import fs from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

const require = createRequire(import.meta.url);

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

type EmbeddedPostgresTestGuardian = {
  stop(): void;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;
const ALLOW_SKIP_EMBEDDED_POSTGRES_ENV = "PAPERCLIP_ALLOW_SKIP_EMBEDDED_POSTGRES";
const EMBEDDED_POSTGRES_GUARDIAN_FLAG = "--paperclip-embedded-postgres-guardian";
const EMBEDDED_POSTGRES_GUARDIAN_POLL_INTERVAL_MS = 250;
const EMBEDDED_POSTGRES_GUARDIAN_STOP_TIMEOUT_MS = 15_000;

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

type EmbeddedPostgresCtorProvider = () => Promise<EmbeddedPostgresCtor>;

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as EmbeddedPostgresCtor;
}

let embeddedPostgresCtorProvider: EmbeddedPostgresCtorProvider = loadEmbeddedPostgresCtor;

// Test seam. Replace the embedded-postgres constructor provider so a test can
// simulate a failed start without the native runtime. Pass `null` to restore
// the default provider. This module is test support only, so the seam is safe.
export function __setEmbeddedPostgresCtorProviderForTests(
  provider: EmbeddedPostgresCtorProvider | null,
): void {
  embeddedPostgresCtorProvider = provider ?? loadEmbeddedPostgresCtor;
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  return await embeddedPostgresCtorProvider();
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  // Postgres writes the true reason for a failed start to its output, for
  // example `could not bind IPv4 address "127.0.0.1": Address already in use`.
  // The `start()` rejection carries an empty message, so we capture the output
  // in a bounded buffer and surface it in the thrown error.
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: (message) => logBuffer.append(message),
    onError: (message) => logBuffer.append(message),
  });
  const guardian = startEmbeddedPostgresTestGuardian(dataDir);

  return { dataDir, port, instance, guardian, getRecentLogs: () => logBuffer.getRecentLogs() };
}

function cleanupEmbeddedPostgresTestDirs(dataDir: string) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function getEmbeddedPostgresGuardianExecArgv(scriptPath: string): string[] {
  return scriptPath.endsWith(".ts") ? ["--import", require.resolve("tsx")] : [];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRunningPostmasterPid(dataDir: string): number | null {
  const postmasterPidFile = path.join(dataDir, "postmaster.pid");
  if (!fs.existsSync(postmasterPidFile)) return null;

  try {
    const pid = Number(fs.readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(EMBEDDED_POSTGRES_GUARDIAN_POLL_INTERVAL_MS);
  }
  return !isProcessAlive(pid);
}

async function stopOrphanedEmbeddedPostgres(dataDir: string): Promise<void> {
  const postmasterPid = readRunningPostmasterPid(dataDir);
  if (!postmasterPid) return;

  const signals: NodeJS.Signals[] =
    process.platform === "win32" ? ["SIGTERM"] : ["SIGINT", "SIGTERM", "SIGKILL"];
  for (const signal of signals) {
    if (!isProcessAlive(postmasterPid)) return;
    try {
      process.kill(postmasterPid, signal);
    } catch {
      return;
    }
    if (await waitForProcessExit(postmasterPid, EMBEDDED_POSTGRES_GUARDIAN_STOP_TIMEOUT_MS)) return;
  }
}

async function runEmbeddedPostgresGuardian(dataDir: string, parentPid: number): Promise<void> {
  while (isProcessAlive(parentPid)) {
    if (!fs.existsSync(dataDir)) return;
    await sleep(EMBEDDED_POSTGRES_GUARDIAN_POLL_INTERVAL_MS);
  }

  if (!fs.existsSync(dataDir)) return;
  await stopOrphanedEmbeddedPostgres(dataDir);
  cleanupEmbeddedPostgresTestDirs(dataDir);
}

function startEmbeddedPostgresTestGuardian(dataDir: string): EmbeddedPostgresTestGuardian {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      ...getEmbeddedPostgresGuardianExecArgv(scriptPath),
      scriptPath,
      EMBEDDED_POSTGRES_GUARDIAN_FLAG,
      dataDir,
      String(process.pid),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  return {
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The detached guardian may already have exited.
      }
    },
  };
}

async function maybeRunEmbeddedPostgresGuardianFromArgv(): Promise<boolean> {
  const guardianFlagIndex = process.argv.indexOf(EMBEDDED_POSTGRES_GUARDIAN_FLAG);
  if (guardianFlagIndex === -1) return false;

  const dataDir = process.argv[guardianFlagIndex + 1];
  const parentPid = Number(process.argv[guardianFlagIndex + 2]);
  if (!dataDir || !Number.isInteger(parentPid) || parentPid <= 0) return true;

  await runEmbeddedPostgresGuardian(dataDir, parentPid);
  return true;
}

void maybeRunEmbeddedPostgresGuardianFromArgv().then((handled) => {
  if (handled) process.exit(0);
});

function shouldAllowSkipEmbeddedPostgres(): boolean {
  return process.env[ALLOW_SKIP_EMBEDDED_POSTGRES_ENV] === "1";
}

function buildEmbeddedPostgresUnsupportedError(reason: string): Error {
  return new Error(
    `Embedded Postgres test support is unavailable: ${reason} Set ${ALLOW_SKIP_EMBEDDED_POSTGRES_ENV}=1 only when you intentionally want infra-gated suites to skip on this host.`,
  );
}

// Upper bound (ms) on how long we wait for the embedded Postgres cluster to
// stop gracefully before abandoning the wait and returning from the hook.
const EMBEDDED_POSTGRES_STOP_TIMEOUT_MS = 5000;

// `embedded-postgres@18.1.0-beta.16` exposes only `stop(): Promise<void>` — no
// shutdown-mode argument. Internally it SIGINTs the postgres process (already
// PostgreSQL "fast shutdown") and resolves *only* on the child's `exit` event,
// with no time bound of its own. Under the loaded serial server shard a slow
// shutdown checkpoint can push that past vitest's hookTimeout and hang the
// afterAll hook. So we bound the graceful stop: if it overruns, we stop waiting
// and return so the hook completes. The SIGINT has already been delivered, so
// the abandoned process still exits on its own (and again when the runner exits).
// Errors are swallowed, matching prior behavior.
//
// `cleanupFn` (data-dir reclaim) is chained on the raw `stop()` promise, not on
// the timeout race, so the disposable data dir is removed *only after* `stop()`
// actually settles — i.e. once the child Postgres process has exited. Removing
// it on the timeout path would pull the data files out from under a still-running
// cluster and provoke checkpoint / WAL I/O errors. In the fast path `cleanupFn`
// has run by the time this resolves; in the timeout path it runs asynchronously
// once the abandoned process finally exits.
async function stopEmbeddedPostgresBounded(
  instance: EmbeddedPostgresInstance | null,
  cleanupFn?: () => void,
): Promise<void> {
  if (!instance) {
    cleanupFn?.();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = instance
    .stop()
    .catch(() => {
      // Swallow shutdown errors — the data dir is reclaimed regardless.
    })
    .finally(() => {
      try {
        cleanupFn?.();
      } catch {
        // Best-effort reclaim; ignore removal errors.
      }
    });
  try {
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EMBEDDED_POSTGRES_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Upper bound on start attempts. `getAvailablePort` uses a check-then-use probe:
// it binds port 0, reads the assigned port, closes the probe, then Postgres binds
// that port. Under load another process can take the port in that window, so the
// bind fails with "Address already in use" and `start()` rejects. Each retry uses
// a fresh port and a fresh data directory, so a transient collision clears.
const EMBEDDED_POSTGRES_START_MAX_ATTEMPTS = 5;

// Start one embedded Postgres cluster with a bounded retry. Each attempt gets a
// fresh port and a fresh data directory. On a failed attempt we stop the cluster
// and remove its data directory before the next attempt. After the last attempt
// we throw with the real Postgres output so the failure is loud and diagnosable.
async function startEmbeddedPostgresWithRetry(tempDirPrefix: string): Promise<{
  port: number;
  dataDir: string;
  instance: EmbeddedPostgresInstance;
  guardian: EmbeddedPostgresTestGuardian;
}> {
  let lastError = new Error("embedded Postgres startup failed");

  for (let attempt = 1; attempt <= EMBEDDED_POSTGRES_START_MAX_ATTEMPTS; attempt += 1) {
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    try {
      await created.instance.initialise();
      await created.instance.start();
      return {
        port: created.port,
        dataDir: created.dataDir,
        instance: created.instance,
        guardian: created.guardian,
      };
    } catch (error) {
      lastError = formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
        recentLogs: created.getRecentLogs(),
      });
      // Stop the failed cluster and remove its data directory. The next attempt
      // allocates a fresh port and a fresh data directory.
      await stopEmbeddedPostgresBounded(created.instance, () => {
        created.guardian.stop();
        cleanupEmbeddedPostgresTestDirs(created.dataDir);
      });
    }
  }

  throw new Error(
    `Failed to start embedded PostgreSQL test database after ${EMBEDDED_POSTGRES_START_MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

// Test-only accessors. Production callers use `startEmbeddedPostgresTestDatabase`
// or `getEmbeddedPostgresTestSupport`. A test drives the bounded retry directly
// so it does not need a real Postgres connection.
export const __startEmbeddedPostgresWithRetryForTests = startEmbeddedPostgresWithRetry;
export const __embeddedPostgresStartMaxAttemptsForTests = EMBEDDED_POSTGRES_START_MAX_ATTEMPTS;
export function __setEmbeddedPostgresSupportForTests(
  support: EmbeddedPostgresTestSupport | null,
): void {
  embeddedPostgresSupportPromise = support ? Promise.resolve(support) : null;
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let started: {
    dataDir: string;
    instance: EmbeddedPostgresInstance;
    guardian: EmbeddedPostgresTestGuardian;
  } | null = null;

  try {
    started = await startEmbeddedPostgresWithRetry("paperclip-embedded-postgres-probe-");
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
      }).message,
    };
  } finally {
    if (started) {
      const { dataDir, instance, guardian } = started;
      await stopEmbeddedPostgresBounded(instance, () => {
        guardian.stop();
        cleanupEmbeddedPostgresTestDirs(dataDir);
      });
    }
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  const support = await embeddedPostgresSupportPromise;
  if (!support.supported && !shouldAllowSkipEmbeddedPostgres()) {
    throw buildEmbeddedPostgresUnsupportedError(support.reason ?? "unsupported environment");
  }
  return support;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  // The bounded retry hardens the cluster start against the port race. It throws
  // with the real Postgres output if every attempt fails.
  const { port, dataDir, instance, guardian } = await startEmbeddedPostgresWithRetry(tempDirPrefix);

  try {
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        await stopEmbeddedPostgresBounded(instance, () => {
          guardian.stop();
          cleanupEmbeddedPostgresTestDirs(dataDir);
        });
      },
    };
  } catch (error) {
    await stopEmbeddedPostgresBounded(instance, () => {
      guardian.stop();
      cleanupEmbeddedPostgresTestDirs(dataDir);
    });
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${
        formatEmbeddedPostgresError(error, {
          fallbackMessage: "embedded Postgres startup failed",
        }).message
      }`,
    );
  }
}

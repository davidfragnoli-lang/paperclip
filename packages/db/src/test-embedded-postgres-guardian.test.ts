import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const require = createRequire(import.meta.url);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
process.env.PAPERCLIP_ALLOW_SKIP_EMBEDDED_POSTGRES = "1";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

describeEmbeddedPostgres("embedded Postgres test guardian", () => {
  it("stops the postmaster and removes its cluster after the parent is killed", async () => {
    const prefix = `paperclip-db-guardian-${Date.now()}-`;
    const helperPath = path.join(currentDir, "test-embedded-postgres-guardian-child.ts");
    const child = spawn(
      process.execPath,
      ["--import", require.resolve("tsx"), helperPath, prefix],
      {
        cwd: path.resolve("."),
        env: { ...process.env, PAPERCLIP_ALLOW_SKIP_EMBEDDED_POSTGRES: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await waitFor(() => stdout.trim().length > 0, 30_000, "child data dir announcement");
    const announcement = stdout.trim().split(/\r?\n/).at(-1);
    expect(announcement).toBeTruthy();
    const parsed = JSON.parse(announcement!) as { dataDir: string; postmasterPid: number };
    expect(fs.existsSync(parsed.dataDir)).toBe(true);
    expect(isProcessAlive(parsed.postmasterPid)).toBe(true);

    child.kill("SIGKILL");
    await waitFor(
      () => !isProcessAlive(parsed.postmasterPid),
      30_000,
      `guardian postmaster shutdown for pid ${parsed.postmasterPid}`,
    );
    await waitFor(
      () => !fs.existsSync(parsed.dataDir),
      30_000,
      `guardian cleanup for ${parsed.dataDir}`,
    );

    expect(stderr).toBe("");
  }, 45_000);

  it("cleans up the cluster directory on the normal success path", async () => {
    const prefix = `paperclip-db-cleanup-${Date.now()}-`;
    const db = await startEmbeddedPostgresTestDatabase(prefix);
    cleanups.push(db.cleanup);

    const dataDir = fs
      .readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(os.tmpdir(), entry))
      .sort()
      .at(-1);

    expect(dataDir).toBeTruthy();
    expect(fs.existsSync(dataDir!)).toBe(true);

    await db.cleanup();
    cleanups.pop();

    expect(fs.existsSync(dataDir!)).toBe(false);
  }, 30_000);
});

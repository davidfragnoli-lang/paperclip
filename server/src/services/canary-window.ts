import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

export const CANARY_OBSERVATION_WINDOW_MS = 60 * 60 * 1000;
export const CANARY_FAILURE_RATE_WINDOW_MS = 30 * 60 * 1000;
export const CANARY_FAILURE_RATE_THRESHOLD_PERCENT = 20;
export const CANARY_MINIMUM_RUNS_FOR_EVALUATION = 5;

const CANARY_MARKER_FILENAME = "canary-window.json";
const FAILED_STATUSES = ["failed", "timed_out"];
const TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"];

export type CanaryWindowState = {
  version: string;
  previousVersion: string | null;
  startedAt: string;
  expiresAt: string;
};

export type CanaryFailureSnapshot = {
  totalRuns: number;
  failedRuns: number;
  ratePercent: number;
};

export type CanaryEvaluation = {
  inCanaryWindow: boolean;
  windowState: CanaryWindowState | null;
  failure: CanaryFailureSnapshot | null;
  thresholdExceeded: boolean;
  rollbackTriggered: boolean;
  reason: string;
};

export function isCanaryWindowActive(
  state: CanaryWindowState | null,
  now: Date,
): boolean {
  if (!state) return false;
  return now.getTime() < new Date(state.expiresAt).getTime();
}

export function computeFailureRate(
  totalRuns: number,
  failedRuns: number,
): number {
  if (totalRuns === 0) return 0;
  return Math.round((failedRuns / totalRuns) * 10000) / 100;
}

export function shouldTriggerRollback(
  ratePercent: number,
  totalRuns: number,
  thresholdPercent: number = CANARY_FAILURE_RATE_THRESHOLD_PERCENT,
  minimumRuns: number = CANARY_MINIMUM_RUNS_FOR_EVALUATION,
): boolean {
  if (totalRuns < minimumRuns) return false;
  return ratePercent > thresholdPercent;
}

function readCanaryMarker(markerPath: string): CanaryWindowState | null {
  try {
    if (!existsSync(markerPath)) return null;
    const raw = readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw) as CanaryWindowState;
    if (!parsed.version || !parsed.startedAt || !parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCanaryMarker(markerPath: string, state: CanaryWindowState): void {
  const dir = dirname(markerPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath, JSON.stringify(state, null, 2), "utf8");
}

function removeCanaryMarker(markerPath: string): void {
  try {
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch {
    // best-effort
  }
}

export type CanaryWindowServiceOptions = {
  dataDir: string;
  repoRoot?: string;
  observationWindowMs?: number;
  failureRateWindowMs?: number;
  failureRateThresholdPercent?: number;
  minimumRuns?: number;
  rollbackEnabled?: boolean;
};

export function canaryWindowService(db: Db, opts: CanaryWindowServiceOptions) {
  const markerPath = join(opts.dataDir, CANARY_MARKER_FILENAME);
  const observationWindowMs = opts.observationWindowMs ?? CANARY_OBSERVATION_WINDOW_MS;
  const failureRateWindowMs = opts.failureRateWindowMs ?? CANARY_FAILURE_RATE_WINDOW_MS;
  const thresholdPercent = opts.failureRateThresholdPercent ?? CANARY_FAILURE_RATE_THRESHOLD_PERCENT;
  const minimumRuns = opts.minimumRuns ?? CANARY_MINIMUM_RUNS_FOR_EVALUATION;
  const rollbackEnabled = opts.rollbackEnabled ?? true;
  const repoRoot = opts.repoRoot;

  function getCanaryState(): CanaryWindowState | null {
    return readCanaryMarker(markerPath);
  }

  function startCanaryWindow(
    version: string,
    previousVersion: string | null,
    now: Date = new Date(),
  ): CanaryWindowState {
    const state: CanaryWindowState = {
      version,
      previousVersion,
      startedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + observationWindowMs).toISOString(),
    };
    writeCanaryMarker(markerPath, state);
    logger.info(
      { version, previousVersion, expiresAt: state.expiresAt },
      "canary observation window opened",
    );
    return state;
  }

  function clearCanaryWindow(reason: string): void {
    const state = getCanaryState();
    removeCanaryMarker(markerPath);
    if (state) {
      logger.info({ version: state.version, reason }, "canary observation window closed");
    }
  }

  function maybeOpenCanaryWindow(
    currentVersion: string,
    now: Date = new Date(),
  ): CanaryWindowState | null {
    const existing = getCanaryState();

    if (existing && existing.version === currentVersion) {
      return isCanaryWindowActive(existing, now) ? existing : null;
    }

    if (existing && existing.version !== currentVersion) {
      clearCanaryWindow("version_superseded");
    }

    const previousVersion = existing?.version ?? null;
    return startCanaryWindow(currentVersion, previousVersion, now);
  }

  async function queryFailureSnapshot(
    now: Date = new Date(),
  ): Promise<CanaryFailureSnapshot> {
    const since = new Date(now.getTime() - failureRateWindowMs);

    const rows = (await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE ${heartbeatRuns.status} IN ('succeeded', 'failed', 'timed_out', 'cancelled'))::int AS total,
        count(*) FILTER (WHERE ${heartbeatRuns.status} IN ('failed', 'timed_out'))::int AS failed
      FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.finishedAt} >= ${since.toISOString()}::timestamptz
        AND ${heartbeatRuns.status} IN ('succeeded', 'failed', 'timed_out', 'cancelled')
    `)) as unknown as Iterable<{ total: number | string; failed: number | string }>;

    const row = Array.from(rows)[0];
    const totalRuns = row ? Number(row.total) : 0;
    const failedRuns = row ? Number(row.failed) : 0;

    return {
      totalRuns,
      failedRuns,
      ratePercent: computeFailureRate(totalRuns, failedRuns),
    };
  }

  async function triggerRollback(
    state: CanaryWindowState,
    failure: CanaryFailureSnapshot,
  ): Promise<boolean> {
    if (!rollbackEnabled) {
      logger.warn(
        { version: state.version, previousVersion: state.previousVersion, ...failure },
        "canary rollback would trigger but rollback is disabled",
      );
      return false;
    }

    if (!state.previousVersion) {
      logger.error(
        { version: state.version, ...failure },
        "canary rollback triggered but no previous version is known",
      );
      return false;
    }

    if (!repoRoot) {
      logger.error(
        { version: state.version, previousVersion: state.previousVersion, ...failure },
        "canary rollback triggered but no repo root configured",
      );
      return false;
    }

    const rollbackScript = join(repoRoot, "scripts", "rollback-latest.sh");
    if (!existsSync(rollbackScript)) {
      logger.error(
        { version: state.version, previousVersion: state.previousVersion, rollbackScript, ...failure },
        "canary rollback triggered but rollback script not found",
      );
      return false;
    }

    logger.warn(
      {
        version: state.version,
        previousVersion: state.previousVersion,
        ...failure,
        thresholdPercent,
      },
      "canary auto-rollback triggered: run failure rate exceeded threshold",
    );

    try {
      await execFileAsync(rollbackScript, [state.previousVersion], {
        cwd: repoRoot,
        timeout: 120_000,
      });
      logger.info(
        { version: state.version, previousVersion: state.previousVersion },
        "canary auto-rollback completed: npm dist-tags repointed to previous version",
      );
      return true;
    } catch (err) {
      logger.error(
        { err, version: state.version, previousVersion: state.previousVersion },
        "canary auto-rollback script failed",
      );
      return false;
    }
  }

  async function evaluateCanaryWindow(
    currentVersion: string,
    now: Date = new Date(),
  ): Promise<CanaryEvaluation> {
    const state = maybeOpenCanaryWindow(currentVersion, now);

    if (!state) {
      const expired = getCanaryState();
      if (expired) {
        clearCanaryWindow("window_expired");
      }
      return {
        inCanaryWindow: false,
        windowState: null,
        failure: null,
        thresholdExceeded: false,
        rollbackTriggered: false,
        reason: "no_active_window",
      };
    }

    if (!isCanaryWindowActive(state, now)) {
      clearCanaryWindow("window_expired");
      return {
        inCanaryWindow: false,
        windowState: state,
        failure: null,
        thresholdExceeded: false,
        rollbackTriggered: false,
        reason: "window_expired",
      };
    }

    const failure = await queryFailureSnapshot(now);

    const exceeded = shouldTriggerRollback(
      failure.ratePercent,
      failure.totalRuns,
      thresholdPercent,
      minimumRuns,
    );

    let rollbackTriggered = false;
    if (exceeded) {
      rollbackTriggered = await triggerRollback(state, failure);
      clearCanaryWindow("rollback_triggered");
    }

    return {
      inCanaryWindow: !exceeded,
      windowState: state,
      failure,
      thresholdExceeded: exceeded,
      rollbackTriggered,
      reason: exceeded
        ? `failure_rate_${failure.ratePercent}%_exceeds_${thresholdPercent}%_threshold`
        : "monitoring",
    };
  }

  return {
    getCanaryState,
    startCanaryWindow,
    clearCanaryWindow,
    evaluateCanaryWindow,
    queryFailureSnapshot,
  };
}

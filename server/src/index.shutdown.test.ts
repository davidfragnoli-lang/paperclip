import { describe, expect, it, vi } from "vitest";
import { logger } from "./middleware/logger.js";
import {
  drainHeartbeatRunsWithShutdownLogging,
  runServerShutdownSequence,
} from "./index.js";

describe("server shutdown heartbeat drain", () => {
  it("finishes the database-backed drain before stopping embedded Postgres", async () => {
    const calls: string[] = [];
    const exit = new Error("exit");

    await expect(runServerShutdownSequence({
      signal: "SIGTERM",
      stopHeartbeatScheduler: () => calls.push("scheduler-stop"),
      waitForHeartbeatSchedulerIdle: async () => { calls.push("scheduler-idle"); },
      drainHeartbeatRunsForShutdown: async () => {
        calls.push("drain");
        return { interrupted: 1 };
      },
      stopTelemetry: async () => { calls.push("telemetry-stop"); },
      appShutdown: () => calls.push("app-stop"),
      stopEmbeddedPostgres: async () => { calls.push("postgres-stop"); },
      shutdownInstrumentation: async () => { calls.push("instrumentation-stop"); },
      exitProcess: () => { throw exit; },
    })).rejects.toBe(exit);

    expect(calls).toEqual([
      "scheduler-stop",
      "drain",
      "scheduler-idle",
      "telemetry-stop",
      "app-stop",
      "postgres-stop",
      "instrumentation-stop",
    ]);
  });

  it("logs drain failure and returns control so infrastructure shutdown can continue", async () => {
    const failure = new Error("database socket unavailable");
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      await expect(drainHeartbeatRunsWithShutdownLogging({
        signal: "SIGTERM",
        drainHeartbeatRunsForShutdown: async () => { throw failure; },
      })).resolves.toBeNull();
      expect(errorLog).toHaveBeenCalledWith(
        { err: failure, signal: "SIGTERM" },
        "graceful heartbeat run drain failed",
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});

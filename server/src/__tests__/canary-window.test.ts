import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANARY_FAILURE_RATE_THRESHOLD_PERCENT,
  CANARY_FAILURE_RATE_WINDOW_MS,
  CANARY_MINIMUM_RUNS_FOR_EVALUATION,
  CANARY_OBSERVATION_WINDOW_MS,
  computeFailureRate,
  isCanaryWindowActive,
  shouldTriggerRollback,
  type CanaryWindowState,
} from "../services/canary-window.js";

describe("isCanaryWindowActive", () => {
  it("returns false for null state", () => {
    expect(isCanaryWindowActive(null, new Date())).toBe(false);
  });

  it("returns true when now is before expiresAt", () => {
    const now = new Date("2026-08-17T10:00:00Z");
    const state: CanaryWindowState = {
      version: "2026.817.0",
      previousVersion: "2026.816.0",
      startedAt: "2026-08-17T09:30:00Z",
      expiresAt: "2026-08-17T10:30:00Z",
    };
    expect(isCanaryWindowActive(state, now)).toBe(true);
  });

  it("returns false when now is after expiresAt", () => {
    const now = new Date("2026-08-17T11:00:00Z");
    const state: CanaryWindowState = {
      version: "2026.817.0",
      previousVersion: "2026.816.0",
      startedAt: "2026-08-17T09:30:00Z",
      expiresAt: "2026-08-17T10:30:00Z",
    };
    expect(isCanaryWindowActive(state, now)).toBe(false);
  });

  it("returns false at the exact expiry time", () => {
    const state: CanaryWindowState = {
      version: "2026.817.0",
      previousVersion: null,
      startedAt: "2026-08-17T09:30:00Z",
      expiresAt: "2026-08-17T10:30:00Z",
    };
    expect(isCanaryWindowActive(state, new Date("2026-08-17T10:30:00Z"))).toBe(false);
  });
});

describe("computeFailureRate", () => {
  it("returns 0 for zero runs", () => {
    expect(computeFailureRate(0, 0)).toBe(0);
  });

  it("returns 0 when no failures", () => {
    expect(computeFailureRate(10, 0)).toBe(0);
  });

  it("returns 100 when all runs failed", () => {
    expect(computeFailureRate(5, 5)).toBe(100);
  });

  it("rounds to two decimal places", () => {
    expect(computeFailureRate(3, 1)).toBe(33.33);
  });

  it("computes 20% correctly", () => {
    expect(computeFailureRate(10, 2)).toBe(20);
  });
});

describe("shouldTriggerRollback", () => {
  it("does not trigger below minimum runs", () => {
    expect(shouldTriggerRollback(50, 3, 20, 5)).toBe(false);
  });

  it("does not trigger at exactly the threshold", () => {
    expect(shouldTriggerRollback(20, 10, 20, 5)).toBe(false);
  });

  it("triggers when rate exceeds threshold with sufficient runs", () => {
    expect(shouldTriggerRollback(25, 10, 20, 5)).toBe(true);
  });

  it("does not trigger below threshold with sufficient runs", () => {
    expect(shouldTriggerRollback(15, 10, 20, 5)).toBe(false);
  });

  it("uses default parameters", () => {
    expect(shouldTriggerRollback(25, 10)).toBe(true);
    expect(shouldTriggerRollback(15, 10)).toBe(false);
    expect(shouldTriggerRollback(50, 3)).toBe(false);
  });
});

describe("constants", () => {
  it("observation window is 60 minutes", () => {
    expect(CANARY_OBSERVATION_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("failure rate window is 30 minutes", () => {
    expect(CANARY_FAILURE_RATE_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it("failure rate threshold is 20%", () => {
    expect(CANARY_FAILURE_RATE_THRESHOLD_PERCENT).toBe(20);
  });

  it("minimum runs for evaluation is 5", () => {
    expect(CANARY_MINIMUM_RUNS_FOR_EVALUATION).toBe(5);
  });
});

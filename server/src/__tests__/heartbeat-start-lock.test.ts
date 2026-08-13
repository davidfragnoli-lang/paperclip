import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentStartLock } from "../services/agent-start-lock.ts";
import { createRestartDrainAdmissionGate } from "../services/heartbeat.ts";

describe("heartbeat agent start lock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a stale start lock freeze later queued-run starts", async () => {
    vi.useFakeTimers();

    const agentId = randomUUID();
    const firstStart = vi.fn(() => new Promise<void>(() => undefined));
    const secondStart = vi.fn(async () => "started");

    void withAgentStartLock(agentId, firstStart);
    await Promise.resolve();
    expect(firstStart).toHaveBeenCalledTimes(1);

    const secondStartResult = withAgentStartLock(agentId, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(secondStartResult).resolves.toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });
});

describe("restart drain admission gate", () => {
  it("drains admitted starts and rejects every start after quiescence begins", async () => {
    const gate = createRestartDrainAdmissionGate();
    let releaseActive!: () => void;
    const active = gate.run(
      () => new Promise<string>((resolve) => {
        releaseActive = () => resolve("finished safely");
      }),
      () => "rejected",
    );
    await Promise.resolve();

    let quiesceSettled = false;
    const quiesce = gate.quiesce().then((result) => {
      quiesceSettled = true;
      return result;
    });

    await expect(gate.run(async () => "started too late", () => "rejected")).resolves.toBe("rejected");
    expect(quiesceSettled).toBe(false);

    releaseActive();
    await expect(active).resolves.toBe("finished safely");
    await expect(quiesce).resolves.toEqual({ quiesced: true, drainedAdmissions: 1 });

    expect(gate.resume()).toEqual({ quiesced: false });
    await expect(gate.run(async () => "started after abort", () => "rejected")).resolves.toBe("started after abort");
  });
});

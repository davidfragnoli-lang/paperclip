import type { Db } from "@paperclipai/db";

export interface PauseDispatchRecoveryInput {
  agentId: string;
  pausedAt: Date;
  resumedAt: Date;
}

export async function recoverPauseRefusedRoutineRuns(
  db: Db,
  input: PauseDispatchRecoveryInput,
) {
  const { routineService } = await import("./routines.js");
  return routineService(db).catchUpPauseRefusedRuns(input);
}

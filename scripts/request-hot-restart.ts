#!/usr/bin/env -S node --import tsx
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import {
  resolveHotRestartIntentPath,
  writeHotRestartIntent,
} from "../server/src/services/hot-restart.js";

function usage(): never {
  console.error([
    "Usage: tsx scripts/request-hot-restart.ts --server-pid <pid> [--drain-required] [--process-lost-proof-run <run-id>]",
    "",
    "Writes an instance-scoped hot-restart intent plus a legacy home-root handoff marker.",
  ].join("\n"));
  process.exit(2);
}

function readArgs(argv: string[]) {
  let serverPid: number | null = null;
  let drainRequired = false;
  let processLostProofRunId: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server-pid") {
      const raw = argv[index + 1];
      if (!raw) usage();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) usage();
      serverPid = parsed;
      index += 1;
      continue;
    }
    if (arg === "--drain-required") {
      drainRequired = true;
      continue;
    }
    if (arg === "--process-lost-proof-run") {
      const raw = argv[index + 1]?.trim();
      if (!raw) usage();
      processLostProofRunId = raw;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if (!serverPid) usage();
  if (drainRequired && processLostProofRunId) usage();
  return { serverPid, drainRequired, processLostProofRunId };
}

function normalizeApiBase(raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/api$/, "");
}

async function readPreviousServerInfo() {
  const apiBase = normalizeApiBase(process.env.PAPERCLIP_API_URL);
  if (!apiBase) return { version: null, identity: null };
  try {
    const apiKey = process.env.PAPERCLIP_API_KEY?.trim();
    const response = await fetch(`${apiBase}/api/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return { version: null, identity: null };
    const body = await response.json() as Record<string, unknown>;
    const serverInfo = body.serverInfo && typeof body.serverInfo === "object"
      ? body.serverInfo as Record<string, unknown>
      : null;
    return {
      version: typeof body.serverVersion === "string"
        ? body.serverVersion
        : typeof body.version === "string"
          ? body.version
          : null,
      identity: typeof serverInfo?.processStartedAt === "string"
        ? serverInfo.processStartedAt
        : null,
    };
  } catch {
    return { version: null, identity: null };
  }
}

async function readPreflightActiveRunIds() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  try {
    const rows = await db.$client<{ id: string }[]>`
      SELECT id
      FROM heartbeat_runs
      WHERE status = 'running'
    `;
    return rows.map((row) => row.id);
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function validateDisposableProcessLostProofRun(runId: string | null) {
  if (!runId) return [];
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  try {
    const rows = await db.$client<Array<{
      run_id: string;
      run_status: string;
      agent_id: string;
      issue_id: string;
      issue_title: string;
      issue_status: string;
      issue_priority: string;
      execution_run_id: string | null;
      other_running_count: number;
    }>>`
      SELECT
        hr.id AS run_id,
        hr.status AS run_status,
        hr.agent_id AS agent_id,
        i.id AS issue_id,
        i.title AS issue_title,
        i.status AS issue_status,
        i.priority AS issue_priority,
        i.execution_run_id AS execution_run_id,
        (
          SELECT count(*)::int
          FROM heartbeat_runs other
          WHERE other.agent_id = hr.agent_id
            AND other.status = 'running'
            AND other.id <> hr.id
        ) AS other_running_count
      FROM heartbeat_runs hr
      JOIN issues i
        ON i.company_id = hr.company_id
       AND i.assignee_agent_id = hr.agent_id
       AND i.execution_run_id = hr.id
      WHERE hr.id = ${runId}
    `;
    const row = rows[0];
    const valid = rows.length === 1
      && row.run_status === "running"
      && row.issue_status === "in_progress"
      && row.issue_priority === "low"
      && row.execution_run_id === row.run_id
      && row.other_running_count === 0
      && /^Disposable FRA-23699 process_lost proof lane\b/.test(row.issue_title);
    if (!valid) {
      throw new Error(
        "Refusing process-lost proof induction: target must be the sole running run of its agent "
        + "on an in-progress, low-priority issue titled 'Disposable FRA-23699 process_lost proof lane …'",
      );
    }
    return [runId];
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

const { serverPid, drainRequired, processLostProofRunId } = readArgs(process.argv.slice(2));
const preflightActiveRunIds = drainRequired ? [] : await readPreflightActiveRunIds();
const processLostProofRunIds = await validateDisposableProcessLostProofRun(processLostProofRunId);
const previousServerInfo = await readPreviousServerInfo();
const intent = await writeHotRestartIntent({
  previousServerPid: serverPid,
  previousServerIdentity: previousServerInfo.identity,
  previousServerVersion: previousServerInfo.version,
  drainRequired,
  requestedByRunId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
  preflightActiveRunIds,
  processLostProofRunIds,
});

console.log(JSON.stringify({
  status: "hot_restart_intent_written",
  intentPath: resolveHotRestartIntentPath(),
  previousServerPid: intent.previousServerPid,
  previousServerIdentity: intent.previousServerIdentity,
  previousServerStartedAt: intent.previousServerStartedAt,
  previousServerVersion: intent.previousServerVersion,
  drainRequired: intent.drainRequired,
  preflightActiveRunIds: intent.preflightActiveRunIds,
  processLostProofRunIds: intent.processLostProofRunIds,
}, null, 2));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const prefix = process.argv[2];

if (!prefix) {
  throw new Error("Missing embedded Postgres guardian child prefix");
}

await startEmbeddedPostgresTestDatabase(prefix);

const matches = fs
  .readdirSync(os.tmpdir())
  .filter((entry) => entry.startsWith(prefix))
  .map((entry) => path.join(os.tmpdir(), entry))
  .sort();

if (matches.length !== 1) {
  throw new Error(`Expected exactly one data dir for ${prefix}, found ${matches.length}`);
}

const dataDir = matches[0]!;
const postmasterPidFile = path.join(dataDir, "postmaster.pid");
const postmasterPid = Number(fs.readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());

if (!Number.isInteger(postmasterPid) || postmasterPid <= 0) {
  throw new Error(`Invalid postmaster pid in ${postmasterPidFile}`);
}

process.stdout.write(`${JSON.stringify({ dataDir, postmasterPid })}\n`);
setInterval(() => {}, 1_000);

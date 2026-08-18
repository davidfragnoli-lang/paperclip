# Patch Manifest: `fra/live-runtime` vs `origin/master`

Generated: 2026-08-18
Measured against anchor: `e71ce9a9d` on branch `fra/live-runtime` at `9d329b228`
Delta: 230 non-merge commits, 175 files changed (+13,684 / -1,394)
Previous measurement: 2026-08-17 — 174 files (same anchor)

## Summary

| Label | Files | Description |
|-------|-------|-------------|
| **upstreamable** | 98 | Correctness fixes / improvements worth PR-ing |
| **keep** | 40 | Fragno-specific runtime; documented owner required |
| **obsolete** | 19 | Migration renumbering artifacts; require rebase to drop |
| **externalizable** | 8 | Move to Fragno Corp config/scripts, out of source tree |
| **Total** | 165 | Unique fork-touched files (some migration files overlap SQL + meta) |

KPI target: manifest size must trend DOWN.

### Measurement log

| Date | Anchor | Branch HEAD | Files | Change | Note |
|------|--------|-------------|-------|--------|------|
| 2026-08-17 | `e71ce9a9d` | (manifest creation) | 174 | — | Baseline |
| 2026-08-18 | `e71ce9a9d` | `9d329b228` | 175 | +1 net | +7 from live fixes, -1 from catalog.json reset (FRA-24563), -5 from commits that were already in the anchor |

### Rebase blocker

The `fra/patches` rebase onto `origin/master` (which would eliminate 19 obsolete migration renumbering files) is blocked by a deep structural conflict in `packages/adapter-utils/src/acpx-engine/execute.ts`: upstream PR #11576 extracted the coordinator lifecycle into separate modules (`run-contracts.js`, `run-resource-ledger.js`, `settlement-sequence.js`, `run-coordinator.js`, `turn-sequence.js`, `run-site-host.js`, `run-site-sandbox.js`) while the fork's stream-idle-timeout patch adds inline timer logic to the same code paths. 7 conflict regions must be resolved with understanding of both architectures. This requires a dedicated rebase pass (see FRA-24563 child issue).

---

## Upstream PR-ready branches (on `fork` remote)

| Branch | Theme | Files | Status | PR | Cycle |
|--------|-------|-------|--------|-----|-------|
| `fix/vitest-exclude-dist` | Test stabilization — vitest config | 6 | PR submitted | [#11559](https://github.com/paperclipai/paperclip/pull/11559) | 2026-08-17 |
| `fix/install-store-symlink-unlink` | CLI robustness — symlink safety | 2 | PR submitted | [#11560](https://github.com/paperclipai/paperclip/pull/11560) | 2026-08-17 |

Standing authorization granted 2026-08-17. Drop local patch after upstream merges.

---

## obsolete (14 files)

Files where upstream now has equivalent functionality. Drop on next rebase.

### packages/db — migration renumbering artifacts (13 files)

All caused by inserting migration `0209_agent_wakeup_live_idempotency.sql` ahead of upstream's sequence, pushing every subsequent migration number up by one. The content is byte-identical to master under different filenames.

| File | Notes |
|------|-------|
| `packages/db/src/migrations/0210_heartbeat_context_snapshot_indexes.sql` | Rename of master's 0209 |
| `packages/db/src/migrations/0211_heartbeat_context_taskkey_index.sql` | Rename of master's 0210 |
| `packages/db/src/migrations/0212_bright_morg.sql` | Rename of master's 0211 |
| `packages/db/src/migrations/0213_onboarding_first_task_unique.sql` | Rename of master's 0212 |
| `packages/db/src/migrations/0214_complete_mystique.sql` | Rename of master's 0213 |
| `packages/db/src/migrations/0215_lively_lord_tyger.sql` | Rename of master's 0214 |
| `packages/db/src/migrations/0216_flat_daimon_hellstrom.sql` | Rename of master's 0215 |
| `packages/db/src/migrations/0217_company_onboarding_seeds.sql` | Rename of master's 0216 |
| `packages/db/src/migrations/0218_yielding_starbolt.sql` | Rename of master's 0217 |
| `packages/db/src/migrations/0220_mushy_jack_murdock.sql` | Rename of master's 0218 |
| `packages/db/src/migrations/meta/0212_snapshot.json` | Rename of master's 0211_snapshot |
| `packages/db/src/migrations/meta/0214_snapshot.json` | Renumbering collision artifact |
| `packages/db/src/migrations/meta/0215_snapshot.json` | Renumbering collision artifact |
| `packages/db/src/migrations/meta/0216_snapshot.json` | Rename of master's 0213_snapshot |
| `packages/db/src/migrations/meta/0218_snapshot.json` | Renumbering collision artifact |
| `packages/db/src/migrations/meta/0219_snapshot.json` | Rename of master's 0217_snapshot |
| `packages/db/src/migrations/meta/_journal.json` | Auto-generated; regenerate on rebase |
| `packages/db/src/add-interaction-resolver-policy-migration.test.ts` | Only change is migration number ref bump |

### packages/skills-catalog (1 file)

| File | Notes |
|------|-------|
| `packages/skills-catalog/generated/catalog.json` | Only `generatedAt` timestamp differs; regeneration noise |

---

## externalizable (8 files)

Move to Fragno Corp config/skills/adapters/scripts, out of the product source tree.

### scripts — Fragno ops tooling (6 files)

| File | Lines | Notes |
|------|-------|-------|
| `scripts/paperclip-issue-update.sh` | +13 | Hardcodes `/Users/davidfragnoli/Projects/Fragno Corp/scripts/paperclip-deploy-gate.js` |
| `scripts/paperclip-issue-update-mutation-check.sh` | +39 | Mutation test for the above deploy-gate binding |
| `scripts/paperclip-issue-update.test.sh` | +59 | Test for the above deploy-gate integration |
| `scripts/reflog-verb-grammar.py` | +129 | Git reflog verb normalizer for Fragno's live-runtime watchdog |
| `scripts/reflog-verb-grammar.test.sh` | +66 | Tests for the above |
| `scripts/request-hot-restart.ts` | +77/-3 | `--process-lost-proof-run` mode tied to specific internal ticket FRA-23699 |

### server/src/middleware — generic logging infra (2 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/middleware/rotating-file-stream.ts` | +186 | Self-contained Node Writable; zero Paperclip domain imports; could be standalone package |
| `server/src/middleware/rotating-file-transport.ts` | +28 | Thin pino-pretty transport adapter for the above |

---

## upstreamable (98 files)

Correctness fixes and improvements worth PR-ing to upstream. Grouped by theme for batching into PRs.

### Theme: Test stabilization — UI hermetic/flaky fixes (12 files)

| File | Lines | Notes |
|------|-------|-------|
| `ui/src/App.activity-routing.test.tsx` | +2/-2 | Increase retry budget to reduce flakiness |
| `ui/src/App.cases-routing.test.tsx` | +3/-5 | Replace fixed-retry loop with `vi.waitFor` |
| `ui/src/components/DocumentAnnotationPopover.test.tsx` | +4/-2 | Wrap render in `act()` |
| `ui/src/components/IssueProperties.test.tsx` | +10/-3 | Use computed time strings instead of hardcoded |
| `ui/src/components/OnboardingWizard.test.tsx` | +6/-8 | Switch to `vi.stubGlobal("localStorage")` |
| `ui/src/components/ProjectWorkspaceSummaryCard.test.tsx` | +6/-2 | Use `vi.waitFor` for clipboard assertions |
| `ui/src/components/task-chat/TaskMessageScroller.test.tsx` | +6/-4 | Wrap event dispatch in `act()` |
| `ui/src/lib/attention.test.ts` | +6/-5 | Local-time-constructed fixture dates for TZ safety |
| `ui/src/pages/AgentToolsTab.test.tsx` | +5/-6 | Replace 300ms sleep with `vi.waitFor` |
| `ui/src/pages/CompanyEnvironments.test.tsx` | +3/-1 | Use `waitForAssertion` helper |
| `ui/src/pages/StatusCards/format.test.ts` | +15/-5 | Add UTC-vs-local timezone edge case coverage |

### Theme: Test stabilization — CLI / adapter / DB hermetic fixes (14 files)

| File | Lines | Notes |
|------|-------|-------|
| `cli/src/__tests__/company-import-transfer.test.ts` | +2/-2 | Add explicit 15s timeouts for disk I/O tests |
| `cli/src/__tests__/company.test.ts` | +7/-0 | Isolate PAPERCLIP_CONTEXT to tmp dir |
| `cli/src/__tests__/doctor.test.ts` | +3/-0 | Pin HOME/PAPERCLIP_HOME to test temp dir |
| `cli/src/__tests__/install-store.test.ts` | +1/-1 | Match production unlinkSync fix |
| `cli/src/__tests__/worktree.test.ts` | +4/-4 | realpathSync for macOS /tmp symlink |
| `packages/adapter-utils/src/execution-target-sandbox.test.ts` | +73/-4 | Fix flaky close/exit ordering + atomic stdin test |
| `packages/adapter-utils/src/local-process-sandbox.test.ts` | +7/-7 | Gate bubblewrap tests to Linux |
| `packages/adapter-utils/src/mcp-isolation.integration.test.ts` | +5/-4 | Quote paths with spaces + relax version check |
| `packages/adapter-utils/src/workspace-restore-merge.test.ts` | +4/-14 | Use mkfifo instead of unix socket fixture |
| `packages/adapters/opencode-local/src/server/runtime-config.test.ts` | +8/-1 | Isolate ANTHROPIC_API_KEY |
| `packages/db/src/test-embedded-postgres-guardian-child.ts` | +33 | Guardian child process helper |
| `packages/db/src/test-embedded-postgres-guardian.test.ts` | +117 | Orphan-postmaster guardian tests |
| `packages/db/src/test-embedded-postgres.test.ts` | +36 | Fail-closed behavior tests |
| `packages/db/src/test-embedded-postgres.ts` | +173/-12 | Guardian child for orphaned Postgres + fail-closed |

### Theme: Test stabilization — server hermetic fixes (18 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/__tests__/adapter-registry.test.ts` | +2/-1 | Snapshot models before mutation |
| `server/src/__tests__/file-resources.test.ts` | +22/-76 | Direct unit test replaces flaky supertest |
| `server/src/__tests__/heartbeat-workspace-branch-containment.test.ts` | +3/-2 | realpath comparison for macOS |
| `server/src/__tests__/heartbeat-retry-scheduling.test.ts` | +6/-0 | Give busy-slot rows durable evidence |
| `server/src/__tests__/logger-tz.test.ts` | +21/-9 | Match dual-transport production config |
| `server/src/__tests__/workspace-instance-cleanup.test.ts` | +2/-1 | realpath fix for macOS |
| `server/src/__tests__/workspace-runtime.test.ts` | +44/-4 | PAPERCLIP_HOME isolation + lsof fallback |
| `server/src/__tests__/issue-comment-redaction.test.ts` | +14/-0 | Redacted timestamps stay parseable |
| `server/src/__tests__/run-secret-redaction.test.ts` | +30/-0 | Date/Map/Set/Buffer survive redaction |
| `server/src/__tests__/execution-workspaces-service.test.ts` | +7/-0 | Postgres-clock race regression test |
| `server/src/__tests__/issue-list-assignee-filter-routes.test.ts` | +49/-0 | Cache invalidation race fix |
| `server/src/__tests__/issue-stale-execution-lock-routes.test.ts` | +45/-0 | Terminal-status checkout rejection |
| `server/src/__tests__/external-object-routes.test.ts` | +5/-1 | Wire checkout/execution run IDs |
| `server/vitest.config.ts` | +3/-1 | Add dist/** exclude + 30s timeout |
| `packages/adapter-utils/vitest.config.ts` | +8/-0 | Exclude dist/**/node_modules/** |
| `packages/adapters/claude-local/vitest.config.ts` | +1/-0 | Same dist exclusion |
| `packages/adapters/codex-local/vitest.config.ts` | +1/-0 | Same dist exclusion |
| `packages/adapters/opencode-local/vitest.config.ts` | +1/-0 | Same dist exclusion |

### Theme: CLI robustness — run-startup-repair (4 files)

| File | Lines | Notes |
|------|-------|-------|
| `cli/src/commands/run-startup-repair.ts` | +141 | New: auto-detect/repair torn node_modules on startup |
| `cli/src/commands/run.ts` | +34/-4 | Wire repair-and-retry into dev-server import |
| `cli/src/__tests__/run-startup-repair.test.ts` | +54 | Tests for the above |
| `cli/src/install-store.ts` | +5/-1 | Fix rmSync vs unlinkSync symlink footgun |

### Theme: Claude/Codex adapter parsing & config (6 files)

| File | Lines | Notes |
|------|-------|-------|
| `packages/adapters/claude-local/src/server/parse.ts` | +86/-11 | Parse weekly/monthly quota messages |
| `packages/adapters/claude-local/src/server/parse.test.ts` | +21 | Tests for the above |
| `packages/adapters/codex-local/src/server/acp.ts` | +15 | Map sandbox-bypass flag to Codex ACP |
| `packages/adapters/codex-local/src/server/acp.test.ts` | +19 | Tests for the above |
| `packages/adapter-utils/src/acpx-engine/execute.ts` | +115/-26 | Stream-idle watchdog + HTML response rejection |
| `packages/adapter-utils/src/acpx-engine/execute.test.ts` | +64 | Tests for the above |

### Theme: ACPX engine stream-idle timeout (1 file)

| File | Lines | Notes |
|------|-------|-------|
| `packages/adapter-utils/src/acpx-engine/constants.ts` | +1 | DEFAULT_ACP_ENGINE_STREAM_IDLE_TIMEOUT_MS |

### Theme: Database correctness (4 files)

| File | Lines | Notes |
|------|-------|-------|
| `packages/db/src/backup-lib.ts` | +53/-13 | Daily backup retention cap + lazy file open |
| `packages/db/src/backup-lib.test.ts` | +77/-2 | Tests for the above |
| `packages/db/src/migrations/0209_agent_wakeup_live_idempotency.sql` | +45 | Deduplicate live agent-wakeup requests |
| `packages/db/src/schema/agent_wakeup_requests.ts` | +5 | Drizzle index definition for 0209 |
| `packages/db/src/client.test.ts` | +135 | Tests for wake idempotency coalescing |
| `packages/db/vitest.config.ts` | +1 | Exclude dist/** |

### Theme: Server — issue/interaction correctness (8 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/services/issue-thread-interactions.ts` | +108/-27 | Enforce one open decision surface; fix self-resolution |
| `server/src/services/issues.ts` | +32/-2 | Reject terminal-status re-checkout + blocker-attention fix |
| `server/src/services/cross-issue-influence-limit.ts` | +3/-1 | Allow timer-run writes without crash |
| `server/src/__tests__/cross-issue-influence-limit.test.ts` | +28/-5 | Cap enforcement + fail-open test |
| `server/src/__tests__/issue-comment-reopen-routes.test.ts` | +51/-8 | Blocked-issue cancellation + run-less writes |
| `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` | +218 | Supervisory normalization + checkout ownership |
| `server/src/__tests__/issues-service.test.ts` | +219 | Blocker-attention + terminal checkout tests |
| `packages/shared/src/types/issue.ts` | +1 | `targetMutationApplied` field |
| `packages/shared/src/validators/issue.ts` | +1 | Zod schema for the above |
| `packages/shared/src/issue-write-denial.ts` | +6/-5 | Clearer error message wording |

### Theme: Server — heartbeat/recovery reliability (14 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/__tests__/heartbeat-process-recovery.test.ts` | +1498/-102 | Hot-restart adoption, orphan reaping, lease release |
| `server/src/__tests__/heartbeat-comment-wake-batching.test.ts` | +247/-1 | Wake idempotency + assignment-mutation batching |
| `server/src/__tests__/heartbeat-dependency-scheduling.test.ts` | +194 | Stale-row slot accounting |
| `server/src/__tests__/heartbeat-workspace-session.test.ts` | +191 | Checkout-bound workspace policy |
| `server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts` | +87 | Concurrent backstop serialization |
| `server/src/__tests__/heartbeat-active-run-output-watchdog.test.ts` | +40 | Severed-capture not misclassified |
| `server/src/__tests__/heartbeat-workspace-busy.test.ts` | +34 | Adopted run holds workspace |
| `server/src/__tests__/heartbeat-start-lock.test.ts` | +31 | Restart-drain admission gate |
| `server/src/__tests__/server-startup-feedback-export.test.ts` | +300/-12 | Startup sequencing regression tests |
| `server/src/services/run-secret-redaction.ts` | +3/-1 | Preserve non-plain values in redaction |
| `server/src/services/workspace-instance-cleanup.ts` | +1/-1 | Consistent realpath reporting |
| `server/src/shutdown.ts` | +8 | reportPreparationError callback |
| `server/src/shutdown.test.ts` | +7 | Tests for the above |
| `server/src/index.shutdown.test.ts` | +77 | Generic shutdown-sequence tests |

### Theme: Server — scheduler & routines (5 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/__tests__/issue-monitor-failed-dispatch-backoff.test.ts` | +66 | Exponential backoff tests |
| `server/src/__tests__/issue-monitor-scheduler.test.ts` | +89/-14 | Pause/resume clock shifting |
| `server/src/__tests__/routines-service.test.ts` | +247/-1 | Pause-refused replay + predecessor linking |
| `server/src/__tests__/budgets-service.test.ts` | +19/-1 | Budget resume triggers dispatch recovery |
| `server/src/__tests__/companies-service.test.ts` | +12/-2 | Company reactivation triggers recovery |

### Theme: Server — operational health & logging (4 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/middleware/logger.ts` | +51/-7 | Durable rotated log-file output |
| `server/src/__tests__/health.test.ts` | +38/-1 | Disk capacity health check |
| `server/src/services/database-backup-health.ts` | +27/-2 | Host disk-capacity warning |
| `server/src/__tests__/rotating-file-stream.test.ts` | +82 | Rotation/archival tests |

### Theme: Server — misc correctness (8 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/runtime-api.ts` | +4/-15 | Fix https: inheritance on internal URLs |
| `server/src/__tests__/runtime-api.test.ts` | +73/-3 | Tests for the above |
| `server/src/services/company-skills.ts` | +13/-6 | Symlink/path-traversal fix + SKILL.md match |
| `server/src/services/execution-workspaces.ts` | +17/-1 | Fix clock-skew in terminal sweep cursor |
| `server/src/services/local-service-supervisor.ts` | +37/-31 | Process-tree signaling + macOS lsof PATH fallback |
| `server/src/__tests__/productivity-review-service.test.ts` | +73/-1 | Ownerless review repair tests |
| `server/src/services/recovery/provider-failure-classification.test.ts` | +425 | Error-code governance test |

### Theme: Documentation (3 files)

| File | Lines | Notes |
|------|-------|-------|
| `doc/DEVELOPING.md` | +30/-3 | Hot-restart, startup repair, log rotation docs |
| `doc/SPEC-implementation.md` | +13/-8 | Cross-issue write-cap spec precision fix |
| `scripts/prepare-server-ui-dist.sh` | +12/-2 | Atomic ui-dist swap |

### Theme: Scripts — test infra (3 files)

| File | Lines | Notes |
|------|-------|-------|
| `scripts/run-vitest-stable.mjs` | +57/-3 | Strip control-plane env + bound test shards |
| `scripts/__tests__/run-vitest-stable-shard.test.mjs` | +9 | Test for the above |
| `scripts/provision-worktree.sh` | +15/-7 | Safe seed guard + skip escape hatch |

---

## keep (40 files)

Fragno-specific runtime infrastructure. Owner: Fragno platform/runtime team (David.F) unless noted.

### Core: primary-instance leader election (3 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/runtime-primary-instance.ts` | +192 | PID/instanceId lease-file leader election |
| `server/src/__tests__/runtime-primary-instance.test.ts` | +182 | Tests for the above |
| `server/src/runtime-startup-state.ts` | +46 | JSON startup-phase file for external tooling |

### Core: server index — startup/shutdown/hot-restart (1 file)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/index.ts` | +423/-215 | Primary-instance gating, startup-state tracking, shutdown restructure, hot-restart adoption |

### Core: heartbeat overhaul (2 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/services/heartbeat.ts` | +1850/-215 | Hot-restart adoption, orphan reaping, execution-workspace policy, monitor backoff, restart-drain gating, wake idempotency |
| `server/src/services/hot-restart.ts` | +5 | processLostProofRunIds type extension |

### Core: recovery subsystem expansion (4 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/services/recovery/service.ts` | +750/-24 | Adapter failure classification, quota rewake throttle, wakeless backstop, stranded-transition grace, idempotent wake serialization |
| `server/src/services/recovery/successful-run-handoff.ts` | +25 | Settle window for handoff notices |
| `server/src/services/recovery/issue-graph-liveness.ts` | +24/-2 | hasScheduledMonitor / external-service-wake exemption |
| `server/src/services/recovery/index.ts` | +2 | Barrel exports for the above |

### Core: pause/dispatch recovery (5 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/services/pause-dispatch-recovery.ts` | +15 | Central recoverPauseRefusedRoutineRuns hub |
| `server/src/services/agents.ts` | +68/-14 | Agent resume wires into pause recovery |
| `server/src/services/budgets.ts` | +14 | Budget resume triggers pause recovery |
| `server/src/services/companies.ts` | +29/-8 | Company reactivation triggers pause recovery |
| `server/src/services/routines.ts` | +104/-1 | Predecessor supersession + pause-refused replay |

### Core: issue execution policy (2 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/services/issue-execution-policy.ts` | +93 | Monitor rearm + pause-shift patch builders |
| `server/src/services/agent-invokability.ts` | +4/-1 | Extracted constant for pause-dispatch matching |

### Core: routes & API (4 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/routes/health.ts` | +36/-1 | /restart-drain/quiesce and /resume endpoints |
| `server/src/routes/openapi.ts` | +16 | Docs for restart-drain routes |
| `server/src/routes/issues.ts` | +194/-14 | Supervisory normalization + cross-issue exemption |
| `server/src/routes/agents.ts` | +26 | Pause recovery on agent resume |

### Core: workspace/worktree (3 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/services/workspace-runtime.ts` | +21/-2 | terminateProcesses flag for leased-runtime teardown |
| `server/src/worktree-config.ts` | +4 | isIsolatedWorktreeRuntimeConfigured() |
| `server/src/services/run-log-store.ts` | +9/-1 | Export resolveLocalRunLogPath for heartbeat mtime reaping |

### Core: productivity review + logging (2 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/services/productivity-review.ts` | +69/-22 | Owner-repair via recovery-service helpers |
| `server/src/services/local-service-supervisor.ts` | kept upstream (see upstreamable) | — |

### Adapter-utils: control-plane reachability (4 files)

| File | Lines | Notes |
|------|-------|-------|
| `packages/adapter-utils/src/execution-target.ts` | +402 | Multi-candidate API URL reachability preflight |
| `packages/adapter-utils/src/execution-target.test.ts` | +295 | Tests for the above |
| `packages/adapter-utils/src/server-utils.ts` | +262/-24 | Durable child-completion envelope, process-tree kill, wake-batch shape, API candidates plumbing |
| `packages/adapter-utils/src/server-utils.test.ts` | +84 | Tests for the above |

### Adapter integration (2 files)

| File | Lines | Notes |
|------|-------|-------|
| `packages/adapters/claude-local/src/server/execute.ts` | +48/-1 | Wire reachability preflight into Claude execute |
| `packages/adapters/claude-local/src/server/acp.test.ts` | +2/-1 | ANTHROPIC_API_KEY isolation (note: afterEach cleanup regression — see flags) |

### Database: Fragno-specific schema (4 files)

| File | Lines | Notes |
|------|-------|-------|
| `packages/db/src/migrations/0219_soft_power_pack.sql` | +2 | heartbeat_runs_company_ctx_paperclip_issue_idx |
| `packages/db/src/schema/heartbeat_runs.ts` | +4 | Drizzle index definition for 0219 |
| `packages/db/src/heartbeat-context-snapshot-index-migration.test.ts` | +15/-2 | Tests for the paperclipIssue index |
| `packages/db/src/migrations/meta/0220_snapshot.json` | new | Terminal Drizzle schema snapshot |

### Shared types (1 file)

| File | Lines | Notes |
|------|-------|-------|
| `packages/shared/src/types/heartbeat.ts` | +3 | outputCaptureState / outputCaptureSeveredAt / adoptedRunDeadlineAt |

### Server tests — Fragno topology (3 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/__tests__/claude-local-execute.test.ts` | +349/-1 | Control-plane reachability preflight tests (Cloudflare Access gate) |
| `server/src/__tests__/heartbeat-runtime-mcp-servers.test.ts` | +67 | PAPERCLIP_RUNTIME_API_URL preference tests |
| `server/src/__tests__/paperclip-env.test.ts` | +24/-1 | RUNTIME_API_CANDIDATES_JSON delivery tests |

### Server tests — behavior change needing owner sign-off (2 files)

| File | Lines | Notes |
|------|-------|-------|
| `server/src/__tests__/issue-thread-interactions-service.test.ts` | +128/-166 | Supersede-semantics rewrite; coverage gap for tool-action linkage |
| `server/src/services/issue-thread-interactions.test.ts` | -115 (deleted) | Removed tests without replacement — needs sign-off |

---

## Flags

Issues discovered during analysis that need attention regardless of classification:

1. **`packages/adapters/claude-local/src/server/acp.test.ts`** — afterEach temp-directory cleanup lost its `.map(root => fs.rm(root, ...))` call; `Promise.all(tempRoots.splice(0))` is now a no-op. Temp dirs leak.

2. **`packages/adapters/codex-local/src/server/acp.ts`** — `DEFAULT_CODEX_ACP_STREAM_IDLE_TIMEOUT_MS` and `DEFAULT_CODEX_ACP_STREAM_IDLE_MAX_RETRIES` are declared but never referenced. Dead code.

3. **`server/src/services/issue-thread-interactions.test.ts`** — Four mock-based tests covering `withdrawInteraction` and terminal-issue expiry of tool-action-linked interactions were deleted without replacement in the embedded-postgres test file. Coverage gap.

4. **`server/src/index.ts`** — May have silently dropped origin/master's periodic status-card scheduler tick during the startup restructure. Verify.

5. **`server/src/index.shutdown.test.ts`** — `runServerShutdownSequence` (the function under test) may not be called by the actual SIGTERM/SIGINT handler. Verify wiring before upstreaming.

# fra/patches Rebase Procedure

Maintain the `fra/patches` branch as a clean, continuously-rebased series
on top of `origin/master`.

## Branch layout

| Branch | Remote | Purpose |
|--------|--------|---------|
| `origin/master` | paperclipai/paperclip | Upstream tip |
| `fra/patches` | fork | Linearized local patches on upstream |
| `fra/live-runtime` | local | Current serving tree (merge-pile, being replaced) |

## Rebase onto new upstream

```bash
# 1. Fetch latest upstream
git fetch origin master

# 2. Rebase the series
git checkout fra/patches
git rebase origin/master

# 3. Resolve any conflicts
#    - Migration numbering: fork migrations always go AFTER the last upstream migration
#    - server/src/index.ts: keep isPrimaryRuntimeInstance guard, adopt upstream reconciliation additions
#    - UI tests: prefer upstream's vi.waitFor/act patterns, keep fork's timezone-independent assertions
#    - local-service-supervisor.ts: keep both Windows (upstream) and macOS /usr/sbin/lsof (fork) support

# 4. Verify
grep -rn '^<<<<<<<' --include='*.ts' --include='*.tsx' .  # no conflict markers
git log --oneline origin/master..HEAD | wc -l              # patch count stable

# 5. Push
git push fork fra/patches --force-with-lease
```

## Conflict hotspots

These files are modified by both upstream and the fork. Expect conflicts on rebase:

| File | Upstream reason | Fork reason | Resolution strategy |
|------|----------------|-------------|-------------------|
| `server/src/index.ts` | New features (HTTPS, capabilities) | Primary instance lease, startup state | Wrap upstream's new reconciliation in `isPrimaryRuntimeInstance` |
| `server/src/services/local-service-supervisor.ts` | Runtime exposure | macOS lsof path, process management | Keep both platform paths |
| `server/src/services/workspace-runtime.ts` | Exposure management | Test cleanup option | Take upstream docs/ordering, add fork's `terminateProcesses` |
| `packages/adapter-utils/src/execution-target.ts` | Sandbox capabilities | Control-plane preflight | Additive — both features coexist |
| DB migrations | New upstream migrations | Fork migrations 0221-0222 | Fork migrations always at the end; renumber if upstream adds more |
| `packages/db/src/migrations/meta/_journal.json` | Binary, auto-generated | Fork entries | Regenerate after rebase |

## Adding a new patch

```bash
git checkout fra/patches
# Make changes
git commit -m "fix(scope): description"
git push fork fra/patches --force-with-lease
```

## Removing an upstreamed patch

When a patch is accepted upstream:

```bash
git fetch origin master
git checkout fra/patches
git rebase -i origin/master
# Drop the commit that was upstreamed
# Save and exit
git push fork fra/patches --force-with-lease
```

## Promotion to live

The promotion candidate is `fra/patches` HEAD (upstream tip + rebased series).

Pre-promotion checklist:
1. `pnpm install --frozen-lockfile`
2. `pnpm build`
3. `pnpm test` (sanitized env — no live control plane vars)
4. Migration journal consistency: `node -e "require('./packages/db/src/migrations/meta/_journal.json')"`
5. No conflict markers: `grep -rn '^<<<<<<<' --include='*.ts' .`

## Patch classification

Each patch in the series has one of these labels (see `patch-manifest.md`):

- **keep** — runtime-specific, needed for Fragno deployment
- **upstreamable** — generic fix worth PR-ing upstream
- **externalizable** — should move to Fragno config/scripts outside the repo

The manifest must trend DOWN. Every sync cycle: check if upstream absorbed any patches,
drop them from the series, and update the manifest.

## Migration numbering

Fork migrations always come AFTER the last upstream migration number.
Current: upstream ends at 0220, fork adds 0221-0222.
When upstream adds 0221+, renumber fork migrations to follow.

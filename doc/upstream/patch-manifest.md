# fra/patches Manifest

53 patches on `origin/master` (e71ce9a9d). 157 files, +12,927/-1,452 lines.

## Classification Summary

| Class | Count | Description |
|-------|-------|-------------|
| keep | 22 | Runtime-specific, required for Fragno deployment |
| upstreamable | 28 | Generic improvement, worth PR-ing upstream |
| externalizable | 2 | Fragno-specific, should move outside repo |
| cleanup | 1 | Maintenance (permissions, stale snapshots) |

## Intentionally Dropped

| Item | Reason |
|------|--------|
| `packages/skills-catalog/generated/catalog.json` | Regenerated on build |
| UI test hermeticity (11 files) | Upstream landed equivalent fixes |
| ~50 overlay reconciliation duplicate commits | Same fix applied multiple times across syncs |

## KPI

This manifest must trend DOWN. On each sync cycle:
1. Check if upstream absorbed any patches -> drop them
2. Prepare 1-2 upstreamable patches as PRs (see FRA-24515)
3. Move externalizable items out of the repo

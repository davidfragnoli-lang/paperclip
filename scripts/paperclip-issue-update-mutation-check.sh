#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch_parent="${PAPERCLIP_SCRATCH_DIR:-${TMPDIR:-/tmp}}"
mutation_dir="$(mktemp -d "$scratch_parent/paperclip-issue-update-mutant.XXXXXX")"
trap 'rm -rf -- "$mutation_dir"' EXIT

mutant="$mutation_dir/paperclip-issue-update.sh"
cp "$repo_root/scripts/paperclip-issue-update.sh" "$mutant"

python3 - "$mutant" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
needle = '  if ! node "$deploy_gate_path" --issue "$issue_id"; then\n'
replacement = '  if ! true; then # MUTANT: deploy gate binding reverted\n'
if source.count(needle) != 1:
    raise SystemExit(f'expected exactly one deploy-gate call, found {source.count(needle)}')
path.write_text(source.replace(needle, replacement))
PY

substitution_count="$(grep -cF 'if ! true; then # MUTANT: deploy gate binding reverted' "$mutant")"
printf 'mutation substitution grep -cF: %s\n' "$substitution_count"
if [[ "$substitution_count" != "1" ]]; then
  printf 'FAIL: mutation substitution did not apply exactly once\n' >&2
  exit 1
fi

if HELPER_UNDER_TEST="$mutant" bash "$repo_root/scripts/paperclip-issue-update.test.sh" >"$mutation_dir/test.out" 2>"$mutation_dir/test.err"; then
  printf 'FAIL: refusing test stayed green after deploy-gate binding was reverted\n' >&2
  exit 1
fi

grep -qF 'work-branch-only payload reached PATCH instead of being refused' "$mutation_dir/test.err"
printf 'PASS: refusing test went red when the close-time binding was reverted\n'

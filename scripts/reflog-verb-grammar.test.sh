#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GRAMMAR="$SCRIPT_DIR/reflog-verb-grammar.py"
SERVING_REPO="${PAPERCLIP_RUNTIME_REPO:-$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)}"
failures=0

assert_normalizes() {
  local subject="$1" expected="$2" actual
  actual="$(python3 "$GRAMMAR" normalize "$subject")"
  if [[ "$actual" == "$expected" ]]; then
    printf 'PASS normalize %s -> %s\n' "$subject" "$expected"
  else
    printf 'FAIL normalize %s: expected=%s actual=%s\n' "$subject" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

assert_normalizes 'commit (cherry-pick): picked change' 'cherry-pick'
assert_normalizes 'commit (merge): merge topic' 'merge'
assert_normalizes 'commit (amend): revise message' 'commit'
assert_normalizes 'rebase (finish): returning to refs/heads/main' 'rebase'
assert_normalizes 'merge impl/FRA-24178-live-fix: Merge made by ort' 'merge'
assert_normalizes 'am --abort: returning to refs/heads/main' 'am'

audit_output="$(python3 "$GRAMMAR" audit "$SERVING_REPO" 2>&1)"
audit_rc=$?
printf '%s\n' "$audit_output"
if [[ "$audit_rc" -ne 0 ]]; then
  failures=$((failures + 1))
fi

# Mutation control: the pre-fix parser stripped only a trailing parenthesized
# qualifier. Against the same real reflog census, it must expose the dead merge
# allowlist arm or this regression has stopped proving the original defect.
legacy_output="$(python3 - "$SERVING_REPO" <<'PY'
import re
import subprocess
import sys

repo = sys.argv[1]
allow = {"reset", "cherry-pick", "merge", "checkout", "branch", "commit"}
subjects = subprocess.check_output(
    ["git", "-C", repo, "reflog", "--format=%gs"], text=True
).splitlines()
actions = {subject.split(":", 1)[0].strip() if ":" in subject else "" for subject in subjects}
reachable = {re.sub(r"\s+\([^()]+\)$", "", action) for action in actions} & allow
missing = sorted(allow - reachable)
if missing:
    print("EXPECTED_FAIL unreachable allowlist verb(s): " + ", ".join(missing))
    raise SystemExit(1)
print("UNEXPECTED_PASS legacy parser reached every allowlist verb")
PY
)"
legacy_rc=$?
printf '%s\n' "$legacy_output"
if [[ "$legacy_rc" -eq 0 || "$legacy_output" != *'unreachable allowlist verb(s): merge'* ]]; then
  printf 'FAIL legacy mutation control did not catch dead merge arm\n'
  failures=$((failures + 1))
else
  printf 'PASS legacy mutation control catches dead merge arm\n'
fi

printf 'RESULT failures=%d\n' "$failures"
[[ "$failures" -eq 0 ]]

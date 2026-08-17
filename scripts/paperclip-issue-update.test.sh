#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper_under_test="${HELPER_UNDER_TEST:-$repo_root/scripts/paperclip-issue-update.sh}"
scratch_parent="${PAPERCLIP_SCRATCH_DIR:-${TMPDIR:-/tmp}}"
test_dir="$(mktemp -d "$scratch_parent/paperclip-issue-update-test.XXXXXX")"
trap 'rm -rf -- "$test_dir"' EXIT

mkdir -p "$test_dir/bin"

cat >"$test_dir/fake-deploy-gate.js" <<'JS'
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const issueIndex = process.argv.indexOf('--issue');
const issue = issueIndex >= 0 ? process.argv[issueIndex + 1] : '';
fs.appendFileSync(process.env.GATE_LOG, `${issue}\n`);
process.exit(issue === 'FRA-NOT-LANDED' ? 42 : 0);
JS

cat >"$test_dir/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CURL_LOG"
printf '{"status":"done"}\n'
SH
chmod +x "$test_dir/bin/curl"

run_helper() {
  local issue="$1"
  PATH="$test_dir/bin:$PATH" \
    PAPERCLIP_API_URL="http://paperclip.invalid" \
    PAPERCLIP_API_KEY="test-key" \
    PAPERCLIP_RUN_ID="test-run" \
    PAPERCLIP_DEPLOY_GATE_PATH="$test_dir/fake-deploy-gate.js" \
    GATE_LOG="$test_dir/gate.log" \
    CURL_LOG="$test_dir/curl.log" \
    bash "$helper_under_test" --issue-id "$issue" --status done --comment "close proof"
}

if run_helper FRA-NOT-LANDED >"$test_dir/refused.out" 2>"$test_dir/refused.err"; then
  printf 'FAIL: work-branch-only payload reached PATCH instead of being refused\n' >&2
  exit 1
fi

grep -qF 'FRA-NOT-LANDED' "$test_dir/gate.log"
grep -qF 'Refusing to close FRA-NOT-LANDED: deploy gate failed.' "$test_dir/refused.err"
if [[ -e "$test_dir/curl.log" ]]; then
  printf 'FAIL: refusing case called the Paperclip PATCH path\n' >&2
  exit 1
fi

run_helper FRA-LANDED >"$test_dir/passed.out" 2>"$test_dir/passed.err"
grep -qF 'FRA-LANDED' "$test_dir/gate.log"
grep -qF -- '-X PATCH' "$test_dir/curl.log"
grep -qF '/api/issues/FRA-LANDED' "$test_dir/curl.log"

printf 'PASS: unlanded payload refused before PATCH; landed payload passed and patched\n'

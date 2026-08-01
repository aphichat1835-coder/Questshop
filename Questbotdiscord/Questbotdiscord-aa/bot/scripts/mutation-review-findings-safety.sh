#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp_dir="$(mktemp -d)"
survived=0

cleanup() {
  for file in \
    claim-retry-policy.js \
    unsupported-executor.js \
    all-mode-recovery.js \
    schedule-hint-bus.js \
    rate-limit-coordinator.js \
    runner-state-observer.js \
    smart-wake-controller.js \
    normalizer.js; do
    [[ ! -f "$tmp_dir/$file" ]] || case "$file" in
      claim-retry-policy.js) cp -- "$tmp_dir/$file" src/quest/claim-retry-policy.js ;;
      unsupported-executor.js) cp -- "$tmp_dir/$file" src/quest/executors/unsupported-executor.js ;;
      all-mode-recovery.js) cp -- "$tmp_dir/$file" src/quest/all-mode-recovery.js ;;
      schedule-hint-bus.js) cp -- "$tmp_dir/$file" src/quest/schedule-hint-bus.js ;;
      rate-limit-coordinator.js) cp -- "$tmp_dir/$file" src/quest/rate-limit-coordinator.js ;;
      runner-state-observer.js) cp -- "$tmp_dir/$file" src/quest/runner-state-observer.js ;;
      smart-wake-controller.js) cp -- "$tmp_dir/$file" src/quest/smart-wake-controller.js ;;
      normalizer.js) cp -- "$tmp_dir/$file" src/quest/schema/normalizer.js ;;
      *) echo "Unknown mutation backup file: $file" >&2; return 1 ;;
    esac
  done
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

record_result() {
  local name="$1"
  local status="$2"
  if [[ "$status" -eq 0 ]]; then
    survived=$((survived + 1))
    echo "SURVIVED: $name" >&2
    cat -- "$tmp_dir/test-output.log" >&2
  else
    echo "KILLED: $name"
  fi
}

cp -- src/quest/claim-retry-policy.js "$tmp_dir/claim-retry-policy.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/claim-retry-policy.js')
source = path.read_text(encoding='utf-8')
old = 'if (!current || TERMINAL_RUNNER_STATES.has(current.state)) return current;'
new = 'if (!current) return current;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: terminal claim retry guard')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/claim-retry-policy.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/claim-retry-policy.js" src/quest/claim-retry-policy.js
rm -- "$tmp_dir/claim-retry-policy.js"
record_result 'claim retry revives a terminal runner' "$status"

cp -- src/quest/executors/unsupported-executor.js "$tmp_dir/unsupported-executor.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/executors/unsupported-executor.js')
source = path.read_text(encoding='utf-8')
old = 'if (recordedIssue) return recordedIssue;'
new = 'if (false) return recordedIssue;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: compatibility reason')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-executor-contract.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/unsupported-executor.js" src/quest/executors/unsupported-executor.js
rm -- "$tmp_dir/unsupported-executor.js"
record_result 'unsupported executor hides the recorded schema reason' "$status"

cp -- src/quest/all-mode-recovery.js "$tmp_dir/all-mode-recovery.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/all-mode-recovery.js')
source = path.read_text(encoding='utf-8')
old = '    schedule(context, { notBefore: retryAt });'
new = '    if (false) schedule(context, { notBefore: retryAt });'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: all-mode restore rearm')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/all-mode-recovery.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/all-mode-recovery.js" src/quest/all-mode-recovery.js
rm -- "$tmp_dir/all-mode-recovery.js"
record_result 'failed all-mode restore is not rearmed' "$status"

cp -- src/quest/all-mode-recovery.js "$tmp_dir/all-mode-recovery.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/all-mode-recovery.js')
source = path.read_text(encoding='utf-8')
old = 'assertRestoreResult(result);'
new = 'void result;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: empty restore summary')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/all-mode-recovery-summary.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/all-mode-recovery.js" src/quest/all-mode-recovery.js
rm -- "$tmp_dir/all-mode-recovery.js"
record_result 'empty all-mode restore summary is accepted' "$status"

cp -- src/quest/schedule-hint-bus.js "$tmp_dir/schedule-hint-bus.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/schedule-hint-bus.js')
source = path.read_text(encoding='utf-8')
old = '&& (left.expiresAt ?? null) === (right.expiresAt ?? null)'
new = '&& true'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: schedule expiry equality')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/schedule-hint-expiry.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/schedule-hint-bus.js" src/quest/schedule-hint-bus.js
rm -- "$tmp_dir/schedule-hint-bus.js"
record_result 'schedule hint expiry refresh is ignored' "$status"

cp -- src/quest/rate-limit-coordinator.js "$tmp_dir/rate-limit-coordinator.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/rate-limit-coordinator.js')
source = path.read_text(encoding='utf-8')
old = 'if (seconds != null) return Math.ceil(seconds * 1000);'
new = 'if (seconds != null) return Math.min(60_000, Math.ceil(seconds * 1000));'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: header retry delay')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/rate-limit-response-parsing.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/rate-limit-coordinator.js" src/quest/rate-limit-coordinator.js
rm -- "$tmp_dir/rate-limit-coordinator.js"
record_result 'server Retry-After header is capped at sixty seconds' "$status"

cp -- src/quest/rate-limit-coordinator.js "$tmp_dir/rate-limit-coordinator.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/rate-limit-coordinator.js')
source = path.read_text(encoding='utf-8')
old = 'return Math.ceil(bodySeconds * 1000);'
new = 'return Math.min(60_000, Math.ceil(bodySeconds * 1000));'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: body retry delay')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/rate-limit-response-parsing.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/rate-limit-coordinator.js" src/quest/rate-limit-coordinator.js
rm -- "$tmp_dir/rate-limit-coordinator.js"
record_result 'server retry_after body is capped at sixty seconds' "$status"

cp -- src/quest/rate-limit-coordinator.js "$tmp_dir/rate-limit-coordinator.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/rate-limit-coordinator.js')
source = path.read_text(encoding='utf-8')
old = 'const shouldReadDelay = response.status === 429 || remaining === 0;'
new = 'const shouldReadDelay = true;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: response body parsing gate')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/rate-limit-response-parsing.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/rate-limit-coordinator.js" src/quest/rate-limit-coordinator.js
rm -- "$tmp_dir/rate-limit-coordinator.js"
record_result 'normal rate-limit responses parse their bodies' "$status"

cp -- src/quest/runner-state-observer.js "$tmp_dir/runner-state-observer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-state-observer.js')
source = path.read_text(encoding='utf-8')
old = 'if (CONTROLLED_STATES.has(observedState) && !CONTROLLED_STATES.has(current.state)) return false;'
new = 'if (false) return false;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: observed terminal precedence')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-state-terminal-observer.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-state-observer.js" src/quest/runner-state-observer.js
rm -- "$tmp_dir/runner-state-observer.js"
record_result 'terminal runner status is hidden by a waiting state' "$status"

cp -- src/quest/smart-wake-controller.js "$tmp_dir/smart-wake-controller.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/smart-wake-controller.js')
source = path.read_text(encoding='utf-8')
old = """    if (!stopped) {
      clearWakeTimer(args.jobKey);
      return false;
    }"""
new = """    if (!stopped) {
      return false;
    }"""
if source.count(old) != 1:
    raise SystemExit('mutation target not found: denied wake cleanup')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/smart-wake-ownership.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/smart-wake-controller.js" src/quest/smart-wake-controller.js
rm -- "$tmp_dir/smart-wake-controller.js"
record_result 'denied Smart Wake attempt remains dormant' "$status"

cp -- src/quest/schema/normalizer.js "$tmp_dir/normalizer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/schema/normalizer.js')
source = path.read_text(encoding='utf-8')
old = 'const id = String(raw.id);'
new = 'const id = raw.id;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: Quest ID normalization')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-id-normalization.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/normalizer.js" src/quest/schema/normalizer.js
rm -- "$tmp_dir/normalizer.js"
record_result 'numeric Quest ID is not canonicalized for recovery' "$status"

if [[ "$survived" -gt 0 ]]; then
  echo "$survived review mutation(s) survived" >&2
  exit 1
fi

echo 'All 26 critical mutations were killed'

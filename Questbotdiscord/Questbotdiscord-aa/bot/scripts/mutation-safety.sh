#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp_dir="$(mktemp -d)"
survived=0

cleanup() {
  [[ ! -f "$tmp_dir/mutation-retry.js" ]] || cp -- "$tmp_dir/mutation-retry.js" src/mutation-retry.js
  [[ ! -f "$tmp_dir/smart-scheduler.js" ]] || cp -- "$tmp_dir/smart-scheduler.js" src/quest/smart-scheduler.js
  [[ ! -f "$tmp_dir/recovery-planner.js" ]] || cp -- "$tmp_dir/recovery-planner.js" src/quest/recovery-planner.js
  [[ ! -f "$tmp_dir/registry.js" ]] || cp -- "$tmp_dir/registry.js" src/quest/executors/registry.js
  [[ ! -f "$tmp_dir/runner-state-store.js" ]] || cp -- "$tmp_dir/runner-state-store.js" src/quest/runner-state-store.js
  [[ ! -f "$tmp_dir/rate-limit-coordinator.js" ]] || cp -- "$tmp_dir/rate-limit-coordinator.js" src/quest/rate-limit-coordinator.js
  [[ ! -f "$tmp_dir/normalizer.js" ]] || cp -- "$tmp_dir/normalizer.js" src/quest/schema/normalizer.js
  [[ ! -f "$tmp_dir/smart-wake-controller.js" ]] || cp -- "$tmp_dir/smart-wake-controller.js" src/quest/smart-wake-controller.js
  [[ ! -f "$tmp_dir/runner-completion-release.js" ]] || cp -- "$tmp_dir/runner-completion-release.js" src/quest/runner-completion-release.js
  [[ ! -f "$tmp_dir/all-mode-recovery.js" ]] || cp -- "$tmp_dir/all-mode-recovery.js" src/quest/all-mode-recovery.js
  [[ ! -f "$tmp_dir/runner-state-observer.js" ]] || cp -- "$tmp_dir/runner-state-observer.js" src/quest/runner-state-observer.js
  [[ ! -f "$tmp_dir/discord-client.js" ]] || cp -- "$tmp_dir/discord-client.js" src/quest/api/discord-client.js
  [[ ! -f "$tmp_dir/runner-completion-observer.js" ]] || cp -- "$tmp_dir/runner-completion-observer.js" src/quest/runner-completion-observer.js
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

cp -- src/mutation-retry.js "$tmp_dir/mutation-retry.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/mutation-retry.js')
source = path.read_text(encoding='utf-8')
old = 'if (await verifyAfterUncertainFailure(verify)) return { verifiedAfterFailure: true };'
new = 'if (false) return { verifiedAfterFailure: true };'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: uncertain verification')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-fault-injection.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/mutation-retry.js" src/mutation-retry.js
rm -- "$tmp_dir/mutation-retry.js"
record_result 'uncertain mutation skips fresh verification' "$status"

cp -- src/quest/smart-scheduler.js "$tmp_dir/smart-scheduler.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/smart-scheduler.js')
source = path.read_text(encoding='utf-8')
old = '&& expiresAt > now'
new = '&& expiresAt <= now'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: deadline comparison')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/smart-scheduler.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/smart-scheduler.js" src/quest/smart-scheduler.js
rm -- "$tmp_dir/smart-scheduler.js"
record_result 'expired Quest becomes deadline eligible' "$status"

cp -- src/quest/recovery-planner.js "$tmp_dir/recovery-planner.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/recovery-planner.js')
source = path.read_text(encoding='utf-8')
old = '&& MUTATION_RECOVERY_STATUSES.has(state.mutation_status)'
new = '&& false'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: recovery checkpoint')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-recovery-planner.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/recovery-planner.js" src/quest/recovery-planner.js
rm -- "$tmp_dir/recovery-planner.js"
record_result 'recovery ignores uncertain mutation checkpoint' "$status"

cp -- src/quest/executors/registry.js "$tmp_dir/registry.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/executors/registry.js')
source = path.read_text(encoding='utf-8')
old = 'if (quest?.autoSupported === false) return unsupportedQuestExecutor;'
new = 'if (false) return unsupportedQuestExecutor;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: automatic support gate')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-executor-contract.node-test.js \
  test/quest-schema-modules.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/registry.js" src/quest/executors/registry.js
rm -- "$tmp_dir/registry.js"
record_result 'incompatible Quest is accepted by an automatic executor' "$status"

cp -- src/quest/runner-state-store.js "$tmp_dir/runner-state-store.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-state-store.js')
source = path.read_text(encoding='utf-8')
old = 'if (Object.hasOwn(options, optionName)) return options[optionName];'
new = 'if (false) return options[optionName];'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: explicit checkpoint update')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-state-store.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-state-store.js" src/quest/runner-state-store.js
rm -- "$tmp_dir/runner-state-store.js"
record_result 'explicit checkpoint updates are ignored' "$status"

cp -- src/quest/rate-limit-coordinator.js "$tmp_dir/rate-limit-coordinator.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/rate-limit-coordinator.js')
source = path.read_text(encoding='utf-8')
old = 'return this.accountBucketResetAt.get(`${task.account}:${bucket}`) ?? 0;'
new = 'return 0;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: user-scoped bucket')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-coordinator-hardening.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/rate-limit-coordinator.js" src/quest/rate-limit-coordinator.js
rm -- "$tmp_dir/rate-limit-coordinator.js"
record_result 'user-scoped bucket block is bypassed' "$status"

cp -- src/quest/schema/normalizer.js "$tmp_dir/normalizer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/schema/normalizer.js')
source = path.read_text(encoding='utf-8')
old = 'const targetValid = Number.isFinite(parsedTarget) && parsedTarget > 0;'
new = 'const targetValid = true;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: target validation')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-schema-modules.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/normalizer.js" src/quest/schema/normalizer.js
rm -- "$tmp_dir/normalizer.js"
record_result 'invalid Quest target is accepted' "$status"

cp -- src/quest/schema/normalizer.js "$tmp_dir/normalizer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/schema/normalizer.js')
source = path.read_text(encoding='utf-8')
old = 'validation.autoSupported = false;'
new = 'validation.autoSupported = true;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: progress validation')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-schema-modules.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/normalizer.js" src/quest/schema/normalizer.js
rm -- "$tmp_dir/normalizer.js"
record_result 'invalid Quest progress remains automatically supported' "$status"

cp -- src/quest/smart-wake-controller.js "$tmp_dir/smart-wake-controller.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/smart-wake-controller.js')
source = path.read_text(encoding='utf-8')
old = "if (!hint || hint.reason === 'baseline') {"
new = 'if (!hint) {'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: baseline wake cancellation')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/schedule-hint-clear.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/smart-wake-controller.js" src/quest/smart-wake-controller.js
rm -- "$tmp_dir/smart-wake-controller.js"
record_result 'baseline leaves a stale Smart Wake timer active' "$status"

cp -- src/quest/runner-completion-release.js "$tmp_dir/runner-completion-release.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-completion-release.js')
source = path.read_text(encoding='utf-8')
old = """    .then(
      () => safeRelease(release, onError),
      () => safeRelease(release, onError),
    )"""
new = """    .then(
      () => safeRelease(release, onError),
      () => {},
    )"""
if source.count(old) < 1:
    raise SystemExit('mutation target not found: rejected completion release')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-completion-release.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-completion-release.js" src/quest/runner-completion-release.js
rm -- "$tmp_dir/runner-completion-release.js"
record_result 'rejected runner completion does not release its execution context' "$status"

cp -- src/quest/all-mode-recovery.js "$tmp_dir/all-mode-recovery.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/all-mode-recovery.js')
source = path.read_text(encoding='utf-8')
old = 'if (state?.state !== RUNNER_STATE.WAITING_RETRY) return null;'
new = 'if (false) return null;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: all-mode recovery state gate')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/all-mode-recovery.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/all-mode-recovery.js" src/quest/all-mode-recovery.js
rm -- "$tmp_dir/all-mode-recovery.js"
record_result 'all-mode recovery restores a runner outside WAITING_RETRY' "$status"

cp -- src/quest/runner-state-observer.js "$tmp_dir/runner-state-observer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-state-observer.js')
source = path.read_text(encoding='utf-8')
old = 'if (HIGH_PRIORITY_WAITING_STATES.has(current.state)) return true;'
new = 'if (false) return true;'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: high-priority wait preservation')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-state-observer.node-test.js \
  test/runner-state-wait-observer.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-state-observer.js" src/quest/runner-state-observer.js
rm -- "$tmp_dir/runner-state-observer.js"
record_result 'legacy observer overwrites a higher-priority waiting state' "$status"

cp -- src/quest/api/discord-client.js "$tmp_dir/discord-client.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/api/discord-client.js')
source = path.read_text(encoding='utf-8')
old = 'if (!Number.isInteger(value) || value < 0) {'
new = 'if (false) {'
if source.count(old) < 1:
    raise SystemExit('mutation target not found: video timestamp validation')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/quest-api-client.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/discord-client.js" src/quest/api/discord-client.js
rm -- "$tmp_dir/discord-client.js"
record_result 'malformed video timestamp reaches the network boundary' "$status"

cp -- src/quest/runner-completion-observer.js "$tmp_dir/runner-completion-observer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-completion-observer.js')
source = path.read_text(encoding='utf-8')
old = """  void Promise.resolve(job.done)
    .then(
      () => runObserverHandler(jobKey, () => handleResolved(jobKey, mode, scheduleId)),
      (error) => runObserverHandler(jobKey, () => handleRejected(jobKey, error)),
    )
    .finally(() => {
      discordRateLimitCoordinator.releaseJob(jobKey);
      observedCompletions.delete(jobKey);
    })
    .catch((error) => reportSafely(error, jobKey));"""
new = """  void Promise.resolve(job.done)
    .then(
      () => handleResolved(jobKey, mode, scheduleId),
      (error) => handleRejected(jobKey, error),
    )
    .finally(() => {
      discordRateLimitCoordinator.releaseJob(jobKey);
      observedCompletions.delete(jobKey);
    });"""
if source.count(old) != 1:
    raise SystemExit('mutation target not found: completion observer containment')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-completion-observer.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-completion-observer.js" src/quest/runner-completion-observer.js
rm -- "$tmp_dir/runner-completion-observer.js"
record_result 'completion observer transition failure escapes its promise chain' "$status"

cp -- src/quest/runner-completion-observer.js "$tmp_dir/runner-completion-observer.js"
python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-completion-observer.js')
source = path.read_text(encoding='utf-8')
old = '      discordRateLimitCoordinator.releaseJob(jobKey);'
new = '      void jobKey;'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: completed coordinator job cleanup')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY
set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/coordinator-job-cleanup.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e
cp -- "$tmp_dir/runner-completion-observer.js" src/quest/runner-completion-observer.js
rm -- "$tmp_dir/runner-completion-observer.js"
record_result 'completed runner leaves its coordinator mutation lock active' "$status"

if [[ "$survived" -gt 0 ]]; then
  echo "$survived critical mutation(s) survived" >&2
  exit 1
fi

echo 'All 15 critical mutations were killed'

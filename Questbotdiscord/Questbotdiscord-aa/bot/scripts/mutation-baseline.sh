#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo 'Verifying mutation baseline...'
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/all-mode-recovery.node-test.js \
  test/all-mode-recovery-summary.node-test.js \
  test/claim-retry-policy.node-test.js \
  test/quest-api-client.node-test.js \
  test/quest-coordinator-hardening.node-test.js \
  test/quest-executor-contract.node-test.js \
  test/quest-fault-injection.node-test.js \
  test/quest-id-normalization.node-test.js \
  test/quest-schema-modules.node-test.js \
  test/rate-limit-response-parsing.node-test.js \
  test/runner-completion-observer.node-test.js \
  test/runner-completion-release.node-test.js \
  test/runner-recovery-planner.node-test.js \
  test/runner-state-observer.node-test.js \
  test/runner-state-store.node-test.js \
  test/runner-state-terminal-observer.node-test.js \
  test/runner-state-wait-observer.node-test.js \
  test/schedule-hint-clear.node-test.js \
  test/schedule-hint-expiry.node-test.js \
  test/smart-scheduler.node-test.js \
  test/smart-wake-ownership.node-test.js

echo 'Mutation baseline passed'

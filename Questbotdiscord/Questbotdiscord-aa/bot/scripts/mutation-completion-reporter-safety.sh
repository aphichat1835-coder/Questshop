#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp_file="$(mktemp)"
cp -- src/quest/runner-completion-release.js "$tmp_file"

cleanup() {
  cp -- "$tmp_file" src/quest/runner-completion-release.js
  rm -f -- "$tmp_file"
}
trap cleanup EXIT

python3 <<'PY'
from pathlib import Path
path = Path('src/quest/runner-completion-release.js')
source = path.read_text(encoding='utf-8')
old = """function reportSafely(onError, error) {
  try {
    onError(error);
  } catch {
    // Error reporting must never create another unhandled rejection.
  }
}"""
new = """function reportSafely(onError, error) {
  onError(error);
}"""
if source.count(old) != 1:
    raise SystemExit('mutation target not found: completion error reporter containment')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY

set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-completion-release.node-test.js
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo 'SURVIVED: completion release error reporter escapes its containment' >&2
  exit 1
fi

echo 'KILLED: completion release error reporter escapes its containment' >&2
echo 'All 15 critical mutations were killed' >&2

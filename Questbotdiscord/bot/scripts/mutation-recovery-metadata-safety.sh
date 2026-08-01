#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tmp_dir="$(mktemp -d)"
source_file="src/quest/recovery-planner.js"
backup_file="$tmp_dir/recovery-planner.js"

cleanup() {
  [[ ! -f "$backup_file" ]] || cp -- "$backup_file" "$source_file"
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

cp -- "$source_file" "$backup_file"
python3 <<'PY'
from pathlib import Path

path = Path('src/quest/recovery-planner.js')
source = path.read_text(encoding='utf-8')
old = '      ...current?.metadata,'
new = '      ...{},'
if source.count(old) != 1:
    raise SystemExit('mutation target not found: recovery metadata preservation')
path.write_text(source.replace(old, new, 1), encoding='utf-8')
PY

set +e
node --import ./test/setup-env.js --test --test-concurrency=1 \
  test/runner-recovery-planner.node-test.js >"$tmp_dir/test-output.log" 2>&1
status=$?
set -e

cp -- "$backup_file" "$source_file"
rm -- "$backup_file"

if [[ "$status" -eq 0 ]]; then
  echo 'SURVIVED: recovery plan drops existing diagnostic metadata' >&2
  cat -- "$tmp_dir/test-output.log" >&2
  exit 1
fi

echo 'KILLED: recovery plan drops existing diagnostic metadata'
echo 'Recovery metadata mutation was killed'

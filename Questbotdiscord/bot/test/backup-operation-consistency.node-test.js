import './setup-env.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function operationSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing section ${startMarker}`);
  return source.slice(start, end);
}

function operationBlocks(section) {
  return section
    .split(/\n {2}Object\.freeze\(\{/)
    .slice(1)
    .map((candidate) => {
      const end = candidate.indexOf('\n  }),');
      assert.ok(end >= 0, 'backup operation block is not closed correctly');
      return candidate.slice(0, end);
    });
}

function assertProfileBlocks(source, {
  declaration,
  nextDeclaration,
  slotArrayName,
  root,
}) {
  const blocks = operationBlocks(operationSection(source, declaration, nextDeclaration));
  assert.equal(blocks.length, 7);

  blocks.forEach((block, index) => {
    const target = `${root}/questbot-slot-${index + 1}.db`;
    const declaredPath = `path: ${slotArrayName}[${index}]`;
    assert.ok(block.includes(declaredPath), `missing declared slot path: ${declaredPath}`);
    assert.equal(
      block.split(target).length - 1,
      3,
      `${target} must be used by backup, remove and modifiedAt in its own slot block`,
    );
  });
}

test('every fixed backup slot block keeps copy, cleanup and timestamp operations on its declared path', async () => {
  const source = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');

  assertProfileBlocks(source, {
    declaration: 'const LOCAL_BACKUP_OPERATIONS',
    nextDeclaration: 'const PERSISTENT_BACKUP_OPERATIONS',
    slotArrayName: 'LOCAL_BACKUP_SLOT_PATHS',
    root: './data/backups',
  });
  assertProfileBlocks(source, {
    declaration: 'const PERSISTENT_BACKUP_OPERATIONS',
    nextDeclaration: 'const LOCAL_BACKUP_PROFILE',
    slotArrayName: 'PERSISTENT_BACKUP_SLOT_PATHS',
    root: '/var/data/backups',
  });
});

test('runtime backup profile validation rejects an operation that targets a different slot', () => {
  const script = `
    const originalToString = Function.prototype.toString;
    Function.prototype.toString = function patchedToString() {
      const source = originalToString.call(this);
      const expected = "db.backup('./data/backups/questbot-slot-1.db')";
      return source.includes(expected)
        ? source.replace('questbot-slot-1.db', 'questbot-slot-2.db')
        : source;
    };
    await import('./src/db.js');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_PATH: ':memory:',
      QUESTBOT_TEST_MODE: 'true',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const output = [child.stderr, child.stdout].filter(Boolean).join('\n');

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, `child terminated by ${child.signal}\n${output}`);
  assert.equal(Number.isInteger(child.status), true, `missing integer exit status\n${output}`);
  assert.notEqual(child.status, 0, `child unexpectedly succeeded\n${output}`);
  assert.match(output, /targets a different fixed path/);
});
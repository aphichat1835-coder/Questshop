import './setup-env.js';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const SRC_ROOT = new URL('../src/', import.meta.url);

async function javascriptFiles(directoryUrl = SRC_ROOT) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl);
    if (entry.isDirectory()) files.push(...await javascriptFiles(child));
    else if (entry.name.endsWith('.js')) files.push(child);
  }
  return files;
}

function relative(fileUrl) {
  return path.relative(new URL('..', SRC_ROOT).pathname, fileUrl.pathname);
}

test('production modules cannot import the legacy restore implementation directly', async () => {
  const violations = [];
  const directLegacyRestoreImport = /import\s*\{[^}]*\brestoreScheduledRunners\b[^}]*\}\s*from\s*['"][^'"]*discord-runner\.js['"]/s;
  for (const file of await javascriptFiles()) {
    const source = await readFile(file, 'utf8');
    if (directLegacyRestoreImport.test(source)) violations.push(relative(file));
  }
  assert.deepEqual(violations, []);
});

test('dead speedMultiplier compatibility option has no production caller', async () => {
  const callers = [];
  for (const file of await javascriptFiles()) {
    if (file.pathname.endsWith('/discord-runner.js')) continue;
    const source = await readFile(file, 'utf8');
    if (/\bspeedMultiplier\b/.test(source)) callers.push(relative(file));
  }
  assert.deepEqual(callers, []);
});

test('application and command entrypoints use runner-service as the lifecycle boundary', async () => {
  for (const relativePath of [
    '../src/app.js',
    '../src/worker-app.js',
    '../src/commands/run.js',
    '../src/commands/panel.js',
    '../src/runner-control.js',
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(source, /quest\/runner-service\.js/, relativePath);
    assert.doesNotMatch(source, /from ['"].*discord-runner\.js['"]/, relativePath);
  }
});

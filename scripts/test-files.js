import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

async function filesUnder(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(path);
  }
  return files;
}

function run(file) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', file], {
      stdio: 'inherit', env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${file} terminated by ${signal}`));
      else if (code !== 0) reject(new Error(`${file} exited with code ${code}`));
      else resolveRun();
    });
  });
}

const roots = process.argv.slice(2).map((root) => resolve(root));
const selectedRoots = roots.length ? roots : [resolve('test')];
const files = (await Promise.all(selectedRoots.map(filesUnder))).flat().sort();
if (!files.length) throw new Error('No test files found');
for (const file of files) await run(file);

#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const [inputPath = 'coverage/lcov.raw.info', outputPath = 'coverage/lcov.info'] = process.argv.slice(2);
const raw = await readFile(inputPath, 'utf8');
const records = raw
  .split('end_of_record')
  .map((record) => record.trim())
  .filter(Boolean);

function sourcePath(record) {
  const line = record.split('\n').find((entry) => entry.startsWith('SF:'));
  return line?.slice(3).replaceAll('\\', '/') ?? '';
}

function isSourceRecord(record) {
  const file = sourcePath(record);
  const normalized = path.posix.normalize(file);
  return normalized.startsWith('src/') || normalized.includes('/src/');
}

function metric(record, name) {
  const line = record.split('\n').find((entry) => entry.startsWith(`${name}:`));
  return Number(line?.slice(name.length + 1) ?? 0);
}

function percent(hit, found) {
  return found > 0 ? `${((hit / found) * 100).toFixed(2)}%` : 'n/a';
}

const selected = records.filter(isSourceRecord);
if (selected.length === 0) {
  throw new Error(`No src coverage records found in ${inputPath}`);
}

await writeFile(outputPath, `${selected.join('\nend_of_record\n')}\nend_of_record\n`, 'utf8');

const totals = selected.reduce((result, record) => ({
  linesFound: result.linesFound + metric(record, 'LF'),
  linesHit: result.linesHit + metric(record, 'LH'),
  branchesFound: result.branchesFound + metric(record, 'BRF'),
  branchesHit: result.branchesHit + metric(record, 'BRH'),
  functionsFound: result.functionsFound + metric(record, 'FNF'),
  functionsHit: result.functionsHit + metric(record, 'FNH'),
}), {
  linesFound: 0,
  linesHit: 0,
  branchesFound: 0,
  branchesHit: 0,
  functionsFound: 0,
  functionsHit: 0,
});

console.log(`Source-only LCOV: ${selected.length} files`);
console.log(`Source-only lines: ${totals.linesHit}/${totals.linesFound} (${percent(totals.linesHit, totals.linesFound)})`);
console.log(`Source-only branches: ${totals.branchesHit}/${totals.branchesFound} (${percent(totals.branchesHit, totals.branchesFound)})`);
console.log(`Source-only functions: ${totals.functionsHit}/${totals.functionsFound} (${percent(totals.functionsHit, totals.functionsFound)})`);

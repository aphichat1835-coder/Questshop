import { readFile } from 'node:fs/promises';

const DEFAULT_MINIMUM = 70;
const METRICS = Object.freeze([
  ['lines', 'LH', 'LF'],
  ['branches', 'BRH', 'BRF'],
  ['functions', 'FNH', 'FNF'],
]);

function minimumFor(metric) {
  const value = process.env[`COVERAGE_MIN_${metric.toUpperCase()}`] ?? DEFAULT_MINIMUM;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new TypeError(`Invalid coverage minimum for ${metric}`);
  }
  return number;
}

function totals(lcov) {
  const result = new Map(METRICS.map(([metric]) => [metric, { hit: 0, found: 0 }]));
  for (const line of lcov.split('\n')) {
    const [prefix, raw] = line.split(':', 2);
    for (const [metric, hitKey, foundKey] of METRICS) {
      if (prefix !== hitKey && prefix !== foundKey) continue;
      const count = Number(raw);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new TypeError(`Invalid ${prefix} counter`);
      }
      if (prefix === hitKey) result.get(metric).hit += count;
      if (prefix === foundKey) result.get(metric).found += count;
    }
  }
  return result;
}

const lcov = await readFile('coverage/lcov.info', 'utf8');
if (!lcov.includes('end_of_record')) throw new Error('LCOV report is empty or invalid');
const summary = totals(lcov);
for (const [metric, value] of summary) {
  const percentage = value.found === 0 ? 100 : (value.hit * 100) / value.found;
  const minimum = minimumFor(metric);
  console.log(`${metric}: ${percentage.toFixed(2)}% (minimum ${minimum.toFixed(2)}%)`);
  if (percentage < minimum) {
    throw new Error(`${metric} coverage ${percentage.toFixed(2)}% is below ${minimum.toFixed(2)}%`);
  }
}

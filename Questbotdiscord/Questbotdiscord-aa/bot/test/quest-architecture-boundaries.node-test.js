import './setup-env.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

function blockNames(block) {
  const open = block.indexOf('{');
  const close = block.lastIndexOf('}');
  if (open === -1 || close <= open) return [];
  return block
    .slice(open + 1, close)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function declarationBlocks(moduleSource, prefix) {
  const lines = moduleSource.split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trimStart().startsWith(prefix)) {
      index++;
      continue;
    }
    const block = [];
    do {
      block.push(lines[index]);
      index++;
    } while (index < lines.length && !block.at(-1).trimEnd().endsWith(';'));
    blocks.push(block.join('\n'));
  }
  return blocks;
}

function namedImports(moduleSource, modulePath) {
  const moduleClause = `from '${modulePath}'`;
  const block = declarationBlocks(moduleSource, 'import {')
    .find((candidate) => candidate.includes(moduleClause));
  return block ? blockNames(block) : [];
}

function localNamedExports(moduleSource) {
  return declarationBlocks(moduleSource, 'export {')
    .filter((block) => !block.includes(' from '))
    .flatMap(blockNames);
}

test('discord runner delegates API, schema and progress execution to authoritative modules', async () => {
  const runner = await source('../src/discord-runner.js');

  assert.match(runner, /from '\.\/quest\/api\/discord-client\.js'/);
  assert.match(runner, /from '\.\/quest\/schema\/normalizer\.js'/);
  assert.match(runner, /from '\.\/quest\/executors\.js'/);
  assert.match(runner, /executeQuestExecutor\(executor,/);

  assert.doesNotMatch(runner, /https:\/\/discord\.com\/api\/v\d+/);
  assert.doesNotMatch(runner, /class DiscordApiError/);
  assert.doesNotMatch(runner, /const DISCORD_API/);
  assert.doesNotMatch(runner, /const QUEST_LIST_PATHS/);
  assert.doesNotMatch(runner, /function _userAgent\(/);
  assert.doesNotMatch(runner, /function buildSuperProperties\(/);
  assert.doesNotMatch(runner, /function userHeaders\(/);
  assert.doesNotMatch(runner, /function extractQuestArray\(/);
  assert.doesNotMatch(runner, /function questTaskEntries\(/);
  assert.doesNotMatch(runner, /function progressSeconds\(/);
  assert.doesNotMatch(runner, /function rewardPlatforms\(/);
  assert.doesNotMatch(runner, /function runVideoQuest\(/);
  assert.doesNotMatch(runner, /function runGameQuest\(/);
  assert.doesNotMatch(runner, /Math\.random\(/);
  assert.doesNotMatch(runner, /\/api\/v9/);
});

test('Quest v9 transport, client headers and compatibility errors have one source of truth', async () => {
  const apiClient = await source('../src/quest/api/discord-client.js');
  const runtime = await source('../src/quest/discord-api-runtime.js');
  const runner = await source('../src/discord-runner.js');
  const apiImports = namedImports(runner, './quest/api/discord-client.js');
  const localExports = localNamedExports(runner);

  assert.match(apiClient, /export const QUEST_API_VERSION = 9;/);
  assert.match(
    apiClient,
    /export const DISCORD_API_BASE = `https:\/\/discord\.com\/api\/v\$\{QUEST_API_VERSION\}`;/,
  );
  assert.match(runtime, /export const DISCORD_API_VERSION = 10;/);
  assert.match(runtime, /preservesRequestedVersion: true/);
  assert.doesNotMatch(runtime, /pathname\.replace\(/);
  assert.match(apiClient, /export class DiscordApiError extends Error/);
  assert.match(apiClient, /export function isFatalAuthError\(/);
  assert.match(apiClient, /export function buildDiscordUserHeaders\(/);
  assert.match(apiClient, /function requireVideoTimestamp\(/);
  assert.match(apiClient, /Number\.isInteger\(value\)/);
  assert.doesNotMatch(apiClient, /randomInt|Math\.random\(/);

  assert.match(
    runner,
    /export \{ DiscordApiError \} from '\.\/quest\/api\/discord-client\.js';/,
  );
  assert.ok(apiImports.includes('isFatalAuthError'));
  assert.equal(apiImports.includes('DiscordApiError'), false);
  assert.ok(localExports.includes('isFatalAuthError'));
  assert.equal(localExports.includes('DiscordApiError'), false);
});

test('schema normalization and executor selection remain outside the runner', async () => {
  const normalizer = await source('../src/quest/schema/normalizer.js');
  const executorFacade = await source('../src/quest/executors.js');
  const videoExecutor = await source('../src/quest/executors/video-executor.js');
  const desktopExecutor = await source('../src/quest/executors/desktop-executor.js');

  assert.match(normalizer, /export function normalizeQuest\(/);
  assert.match(normalizer, /export function normalizeQuestPayload\(/);
  assert.match(executorFacade, /selectQuestExecutor/);
  assert.match(executorFacade, /executeQuestExecutor/);
  assert.match(videoExecutor, /export async function executeVideoQuest\(/);
  assert.match(desktopExecutor, /export async function executeDesktopQuest\(/);
});

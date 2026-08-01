import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { formatRunnerStatusContent } from '../src/runner-status-header.js';

function block(lines) {
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

test('one-shot header locks the initial supported count and updates completed count', () => {
  const state = {};
  const first = formatRunnerStatusContent(block([
    '✅ LOGIN : aphichat',
    '🔎 aphichat: พบ 2 QUESTS',
    '🎉 aphichat: ทำสำเร็จ 0 QUESTS',
    '⏭️ กำลังเตรียมทำ Watch the Trailer',
    '⌛ Watch the Trailer 25%',
  ]), state);

  assert.match(first, /Quest ที่ทำได้ทั้งหมด : 2/);
  assert.match(first, /ไปแล้วทั้งหมด : 0/);

  const second = formatRunnerStatusContent(block([
    '✅ LOGIN : aphichat',
    '🔎 aphichat: พบ 2 QUESTS',
    '🎉 aphichat: ทำสำเร็จ 0 QUESTS',
    '🔎 aphichat: พบ 1 QUESTS',
    '🎉 aphichat: ทำสำเร็จ 1 QUESTS',
  ]), state);

  assert.match(second, /Quest ที่ทำได้ทั้งหมด : 2/);
  assert.doesNotMatch(second, /Quest ที่ทำได้ทั้งหมด : 1/);
  assert.match(second, /ไปแล้วทั้งหมด : 1/);
});

test('completed quest activity is cleared before the next quest is rendered', () => {
  const output = formatRunnerStatusContent(block([
    '✅ LOGIN : aphichat',
    '🔎 aphichat: พบ 2 QUESTS',
    '🎉 aphichat: ทำสำเร็จ 0 QUESTS',
    '⏭️ กำลังเตรียมทำ Watch the Trailer',
    '▶️ กำลังทำ Watch the Trailer',
    '⌛ Watch the Trailer 0%',
    '⌛ Watch the Trailer 25%',
    '⌛ Watch the Trailer 50%',
    '⌛ Watch the Trailer 75%',
    '⌛ Watch the Trailer 100%',
    '🧹 QUEST ACTIVITY CLEARED',
    '🎉 aphichat: ทำสำเร็จ 1 QUESTS',
    '⏭️ กำลังเตรียมทำ Play for 15 Minutes',
    '▶️ กำลังทำ Play for 15 Minutes',
    '⌛ Play for 15 Minutes 0%',
  ]));

  assert.doesNotMatch(output, /Watch the Trailer/);
  assert.match(output, /Play for 15 Minutes/);
  assert.match(output, /ไปแล้วทั้งหมด : 1/);
});

test('final summary keeps failures at the end without a failed-count header', () => {
  const output = formatRunnerStatusContent(block([
    '✅ LOGIN : aphichat',
    '🔎 aphichat: พบ 3 QUESTS',
    '🎉 aphichat: ทำสำเร็จ 2 QUESTS',
    '🧹 QUEST ACTIVITY CLEARED',
    '⚠️ มีบาง Quest ที่บอทดำเนินการไม่สำเร็จ',
    '1. Watch the Trailer',
    '   └ Discord ยังไม่ยืนยันสถานะเสร็จ',
    '🔒 LOGOUT : aphichat',
  ]));

  assert.match(output, /Quest ที่ทำได้ทั้งหมด : 3/);
  assert.match(output, /ไปแล้วทั้งหมด : 2/);
  assert.match(output, /1\. Watch the Trailer/);
  assert.match(output, /Discord ยังไม่ยืนยันสถานะเสร็จ/);
  assert.doesNotMatch(output, /Quest ที่ดำเนินการไม่สำเร็จ\s*:/);
});

test('runner source uses the locked session and defers terminal issue details', async () => {
  const source = await readFile(new URL('../src/discord-runner.js', import.meta.url), 'utf8');
  assert.match(source, /createOneShotQuestSession/);
  assert.match(source, /completeAndClaimOneShotQuest\(fresh\)/);
  assert.match(source, /reportOneShotCompletion\(\)/);
  assert.doesNotMatch(source, /reportOneShot(?:Bot|External)Completion/);
  assert.match(source, /recordOneShotRewardClaim/);
  assert.match(source, /claimPendingCount/);
  assert.match(source, /Quest และรับรางวัลทั้งหมดเสร็จสิ้นแล้ว/);
  assert.match(source, /addLog\('🧹 QUEST ACTIVITY CLEARED'\)/);
  assert.match(source, /getOneShotSessionSummary/);
  assert.match(source, /reportOneShotSummary\(\)/);
  assert.doesNotMatch(source, /⚠️ Quest ที่ดำเนินการไม่สำเร็จ\s*:/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { selectQuestExecutor } from '../src/quest/executors.js';
import { matchesDesktopQuest } from '../src/quest/executors/desktop-executor.js';
import { matchesVideoQuest } from '../src/quest/executors/video-executor.js';

test('video executor accepts only explicitly approved events', () => {
  assert.equal(matchesVideoQuest('WATCH_VIDEO'), true);
  assert.equal(matchesVideoQuest('WATCH_VIDEO_ON_MOBILE'), true);

  for (const eventName of [
    'WATCH_VIDEO_V2',
    'WATCH_VIDEO_NEW_PROTOCOL',
    'WATCH_STREAM_VIDEO',
    'STREAM_ON_DESKTOP',
  ]) {
    assert.equal(matchesVideoQuest(eventName), false, eventName);
  }
});

test('desktop executor accepts only explicitly approved events', () => {
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP'), true);
  assert.equal(matchesDesktopQuest('PLAY_ON_DESKTOP_V2'), true);

  for (const eventName of [
    'PLAY_ON_DESKTOP_V3',
    'PLAY_ON_DESKTOP_V99',
    'PLAY_ON_DESKTOP_V2_BETA',
    'PLAY_ON_DESKTOP_NEW_PROTOCOL',
  ]) {
    assert.equal(matchesDesktopQuest(eventName), false, eventName);
  }
});

test('unapproved lookalike events are quarantined before any mutation can run', () => {
  for (const eventName of [
    'WATCH_VIDEO_V2',
    'WATCH_VIDEO_NEW_PROTOCOL',
    'PLAY_ON_DESKTOP_V3',
    'PLAY_ON_DESKTOP_V99',
    'BRAND_NEW_EVENT',
  ]) {
    const executor = selectQuestExecutor({
      id: `unapproved-${eventName}`,
      eventName,
      secondsNeeded: 60,
      progressSecs: 0,
      completed: false,
    });
    assert.equal(executor.supportsAutomaticProgress, false, eventName);
    assert.equal(executor.id, 'unknown', eventName);
    assert.equal(executor.mutation, null, eventName);
    assert.equal(executor.describeUnsupportedReason({ eventName }), 'UNKNOWN_EVENT', eventName);
  }
});

import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAutomaticallySupportedEvent,
  listQuestExecutorCapabilities,
  selectQuestExecutor,
} from '../src/quest/executors.js';

test('executor registry exposes only explicitly approved video and desktop events', () => {
  assert.equal(selectQuestExecutor('WATCH_VIDEO').id, 'video');
  assert.equal(selectQuestExecutor('WATCH_VIDEO_ON_MOBILE').id, 'video');
  assert.equal(selectQuestExecutor('PLAY_ON_DESKTOP').id, 'desktop');
  assert.equal(selectQuestExecutor('PLAY_ON_DESKTOP_V2').id, 'desktop');
  assert.equal(isAutomaticallySupportedEvent('PLAY_ON_DESKTOP_V2'), true);

  for (const eventName of [
    'WATCH_VIDEO_V2',
    'WATCH_VIDEO_NEW_PROTOCOL',
    'PLAY_ON_DESKTOP_V3',
    'PLAY_ON_DESKTOP_V99',
  ]) {
    assert.equal(selectQuestExecutor(eventName).id, 'unknown', eventName);
    assert.equal(isAutomaticallySupportedEvent(eventName), false, eventName);
  }
});

test('unsupported and unknown events never claim automatic support', () => {
  assert.equal(selectQuestExecutor('STREAM_ON_DESKTOP').id, 'unsupported');
  assert.equal(selectQuestExecutor('PLAY_ON_XBOX').supportsAutomaticProgress, false);
  assert.equal(selectQuestExecutor('BRAND_NEW_EVENT').id, 'unknown');
  assert.equal(isAutomaticallySupportedEvent('BRAND_NEW_EVENT'), false);
});

test('executor capability list is immutable presentation data', () => {
  assert.deepEqual(listQuestExecutorCapabilities(), [
    { id: 'video', supportsAutomaticProgress: true, mutation: 'video-progress' },
    { id: 'desktop', supportsAutomaticProgress: true, mutation: 'heartbeat' },
    { id: 'unsupported', supportsAutomaticProgress: false, mutation: null },
  ]);
});
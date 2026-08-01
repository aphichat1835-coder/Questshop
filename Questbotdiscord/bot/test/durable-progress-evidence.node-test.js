import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { questServerProgressSeconds } from '../src/quest/durable-mutation-verifier.js';

for (const absent of [null, '']) {
  test(`progressSecs ${JSON.stringify(absent)} falls back to raw user progress`, () => {
    const result = questServerProgressSeconds({
      progressSecs: absent,
      user_status: {
        progress: {
          WATCH_VIDEO: { value: 42 },
        },
        stream_progress_seconds: 35,
      },
    });

    assert.equal(result, 42);
  });
}

test('a genuine normalized progress value remains authoritative', () => {
  const result = questServerProgressSeconds({
    progressSecs: 12,
    user_status: {
      progress: { WATCH_VIDEO: { value: 99 } },
    },
  });

  assert.equal(result, 12);
});

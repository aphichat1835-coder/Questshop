import assert from 'node:assert/strict';
import test from 'node:test';
import { abortableDelay } from '../src/abortable-delay.js';

test('abortableDelay resolves normally', async () => {
  await abortableDelay(1);
});

test('abortableDelay rejects a signal that was already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(abortableDelay(100, controller.signal), /aborted/);
});

test('abortableDelay closes the abort race after timer registration', async () => {
  const controller = new AbortController();
  const pending = abortableDelay(100, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

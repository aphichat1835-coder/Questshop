import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createFixedDiscordTransport } from '../../src/quest-engine/api/discord-transport.js';

function transportFixture({ body = '{}', headers = {}, statusCode = 200 } = {}) {
  const captured = [];
  const requestImpl = (options, onResponse) => {
    captured.push(options);
    const request = new EventEmitter();
    request.end = (requestBody) => {
      request.body = requestBody;
      Promise.resolve().then(() => {
        const response = new PassThrough();
        response.statusCode = statusCode;
        response.headers = headers;
        onResponse(response);
        response.end(body);
      });
    };
    return request;
  };
  return { captured, transport: createFixedDiscordTransport({ requestImpl }) };
}

test('fixed Discord transport pins the literal HTTPS Discord host and v9 path', async () => {
  const fixture = transportFixture({ body: '{"id":"account-1"}', headers: { 'content-type': 'application/json' } });
  const response = await fixture.transport({ path: '/users/@me', method: 'POST', body: '{}',
    headers: { authorization: 'secret', Host: 'example.invalid', 'content-length': '999' } });
  assert.deepEqual(fixture.captured[0], {
    protocol: 'https:', hostname: 'discord.com', port: 443, path: '/api/v9/users/@me', method: 'POST',
    headers: { authorization: 'secret', 'content-length': '2' }, signal: undefined,
  });
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('CONTENT-TYPE'), 'application/json');
  assert.equal(await response.text(), '{"id":"account-1"}');
});

test('fixed Discord transport rejects an unsafe path before opening a request', async () => {
  const fixture = transportFixture();
  await assert.rejects(fixture.transport({ path: '//example.invalid', method: 'GET', headers: {} }), /unsafe Discord API path/);
  assert.equal(fixture.captured.length, 0);
});

test('fixed Discord transport enforces the response size limit while streaming', async () => {
  const fixture = transportFixture({ body: 'too-large' });
  const response = await fixture.transport({ path: '/users/@me', method: 'GET', headers: {}, maxResponseBytes: 3 });
  await assert.rejects(response.text(), /response exceeds size limit/);
});

test('fixed Discord transport validates its response-size configuration', async () => {
  const fixture = transportFixture();
  await assert.rejects(fixture.transport({ path: '/users/@me', method: 'GET', headers: {}, maxResponseBytes: 0 }), /positive safe integer/);
  assert.equal(fixture.captured.length, 0);
});

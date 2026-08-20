import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredQuestPriceRange } from '../../src/domain/pricing/resolver.js';
import { questAutoPriceRangeLabel, renderQuestAuto } from '../../src/discord/renderers/surfaces.js';
import {
  QUEST_AUTO_MEDIA_ATTACHMENT_URL,
  QUEST_AUTO_MEDIA_FILENAME,
  loadQuestAutoMedia,
} from '../../src/discord/surfaces/quest-auto-media.js';
import { questAutoSurfaceMatches } from '../../src/discord/surfaces/setup.js';

test('Quest Auto storefront renders one price when configured prices are equal', () => {
  const body = renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 500n } });
  assert.equal(body.embeds[0].data.title, 'Discord Quest • Auto');
  assert.match(body.embeds[0].data.description, /ค่าบริการ 5 บาท \/ เควสสำเร็จ/);
  assert.match(body.embeds[0].data.description, /Discord Token/);
  assert.match(body.embeds[0].data.description, /Discord Orbs/);
  assert.equal(body.embeds[0].data.image.url, QUEST_AUTO_MEDIA_ATTACHMENT_URL);
  assert.equal(body.embeds[0].data.footer, undefined);
});

test('Quest Auto storefront keeps the Owner-approved title and copy instead of legacy branding overrides', () => {
  const body = renderQuestAuto({
    title: 'หัวข้อเก่า',
    description: 'ข้อความเก่า',
    priceRange: { minCents: 500n, maxCents: 700n },
  });
  assert.equal(body.embeds[0].data.title, 'Discord Quest • Auto');
  assert.equal(body.embeds[0].data.description, [
    'ทำ Quest เพื่อสะสม **Discord Orbs** ด้วยระบบอัตโนมัติ',
    '**ค่าบริการ 5-7 บาท / เควสสำเร็จ**',
    'ใช้ **Discord Token** เพื่อให้ระบบเข้าไปทำ Quest ให้โดยอัตโนมัติ',
    'เลือก Quest ที่ต้องการ แล้วติดตามสถานะได้จนสำเร็จ',
  ].join('\n'));
});

test('Quest Auto storefront renders min-max price range with a hyphen', () => {
  assert.equal(questAutoPriceRangeLabel({ minCents: 500n, maxCents: 700n }), '5-7');
  assert.equal(questAutoPriceRangeLabel({ minCents: 550n, maxCents: 725n }), '5.5-7.25');
  const body = renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 700n } });
  assert.match(body.embeds[0].data.description, /ค่าบริการ 5-7 บาท \/ เควสสำเร็จ/);
});

test('configured Quest price range requires all supported TYPE prices', async () => {
  const completePool = { query: async (sql) => {
    assert.match(sql, /min\(amount_cents\)/);
    assert.match(sql, /max\(amount_cents\)/);
    assert.match(sql, /count\(DISTINCT task_type\)/);
    return { rows: [{ min_cents: '500', max_cents: '700', task_type_count: 4 }] };
  } };
  assert.deepEqual(await configuredQuestPriceRange(completePool), { minCents: 500n, maxCents: 700n });

  const incompletePool = { query: async () => ({
    rows: [{ min_cents: '500', max_cents: '700', task_type_count: 3 }],
  }) };
  assert.equal(await configuredQuestPriceRange(incompletePool), null);
});

test('Quest Auto bundled GIF is the exact uploaded asset and missing media marks the surface stale', async () => {
  const media = await loadQuestAutoMedia();
  assert.ok(Buffer.isBuffer(media));
  assert.equal(media.length, 9_190_692);
  assert.equal(media.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(QUEST_AUTO_MEDIA_FILENAME, 'quest-auto-demo.gif');

  const payload = { embeds: [{ title: 'Discord Quest • Auto', description: 'copy', image: { url: QUEST_AUTO_MEDIA_ATTACHMENT_URL } }] };
  const withoutMedia = { embeds: [{ title: 'Discord Quest • Auto', description: 'copy', image: { url: 'https://cdn.example/demo.gif' } }], attachments: new Map() };
  assert.equal(questAutoSurfaceMatches(withoutMedia, payload), false);
  const withMedia = {
    embeds: [{ title: 'Discord Quest • Auto', description: 'copy', image: { url: 'https://cdn.example/demo.gif' } }],
    attachments: new Map([['attachment', { name: QUEST_AUTO_MEDIA_FILENAME }]]),
  };
  assert.equal(questAutoSurfaceMatches(withMedia, payload), true);
  withMedia.embeds[0].footer = { text: 'Questshop Surface • QUEST_AUTO' };
  assert.equal(questAutoSurfaceMatches(withMedia, payload), false);
});

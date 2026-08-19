import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredQuestPriceRange } from '../../src/domain/pricing/resolver.js';
import { questPriceRangeText, renderQuestAuto } from '../../src/discord/renderers/surfaces.js';
import {
  QUEST_AUTO_VIDEO_FILENAME,
  loadQuestAutoVideo,
  questAutoSurfacePresentationMatches,
} from '../../src/discord/surfaces/setup.js';

test('Quest Auto storefront renders one price when configured prices are equal', () => {
  const body = renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 500n } });
  assert.equal(body.embeds[0].data.title, 'Discord Quest • Auto');
  assert.match(body.embeds[0].data.description, /ค่าบริการ 5 บาท \/ เควสสำเร็จ/);
  assert.match(body.embeds[0].data.description, /Discord Token/);
  assert.match(body.embeds[0].data.description, /Discord Orbs/);
});

test('Quest Auto storefront renders min-max price range with a hyphen', () => {
  assert.equal(questPriceRangeText({ minCents: 500n, maxCents: 700n }), '5-7 บาท');
  assert.equal(questPriceRangeText({ minCents: 550n, maxCents: 725n }), '5.50-7.25 บาท');
  const body = renderQuestAuto({ priceRange: { minCents: 500n, maxCents: 700n } });
  assert.match(body.embeds[0].data.description, /ค่าบริการ 5-7 บาท \/ เควสสำเร็จ/);
});

test('configured Quest price range reads the active supported TYPE prices', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /min\(amount_cents\)/);
    assert.match(sql, /max\(amount_cents\)/);
    return { rows: [{ min_amount_cents: '500', max_amount_cents: '700' }] };
  } };
  assert.deepEqual(await configuredQuestPriceRange(pool), { minCents: 500n, maxCents: 700n });
});

test('Quest Auto bundled demo video decodes as MP4 and missing video marks the surface stale', async () => {
  const video = await loadQuestAutoVideo();
  assert.ok(Buffer.isBuffer(video));
  assert.ok(video.length > 1_024);
  assert.equal(video.subarray(4, 8).toString('ascii'), 'ftyp');

  const payload = { embeds: [{ title: 'Discord Quest • Auto', description: 'copy' }] };
  const withoutVideo = { embeds: [{ title: 'Discord Quest • Auto', description: 'copy' }], attachments: new Map() };
  assert.equal(questAutoSurfacePresentationMatches(withoutVideo, payload), false);
  const withVideo = {
    embeds: [{ title: 'Discord Quest • Auto', description: 'copy' }],
    attachments: new Map([['attachment', { name: QUEST_AUTO_VIDEO_FILENAME }]]),
  };
  assert.equal(questAutoSurfacePresentationMatches(withVideo, payload), true);
});

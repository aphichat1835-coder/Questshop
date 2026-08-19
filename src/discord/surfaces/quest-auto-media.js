import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUEST_AUTO_VIDEO_FILENAME = 'quest-auto-demo.mp4';
const QUEST_AUTO_VIDEO_DIRECTORY = fileURLToPath(new URL('../assets/quest-auto-demo.b64/', import.meta.url));
const QUEST_AUTO_VIDEO_SIZE = 83_273;
const QUEST_AUTO_VIDEO_SHA256 = 'daf6b55daf849f14fecb8f8df82e0b59bf1e81b01e082811e46e28b56501e388';
const QUEST_AUTO_VIDEO_CHUNKS = Object.freeze([
  '000.b64', '001.b64', '002.b64',
  '003a.b64', '003b.b64', '003c.b64', '003d.b64',
  '004a.b64', '004b.b64', '004c.b64', '004d.b64',
  '005.b64',
]);

let cachedVideo = null;

export async function loadQuestAutoVideo() {
  if (cachedVideo) return cachedVideo;
  const encoded = await Promise.all(QUEST_AUTO_VIDEO_CHUNKS.map((name) => (
    readFile(join(QUEST_AUTO_VIDEO_DIRECTORY, name), 'utf8')
  )));
  const video = Buffer.concat(encoded.map((part) => Buffer.from(part.trim(), 'base64')));
  const validContainer = video.subarray(4, 8).toString('ascii') === 'ftyp';
  const digest = createHash('sha256').update(video).digest('hex');
  if (video.length !== QUEST_AUTO_VIDEO_SIZE || !validContainer || digest !== QUEST_AUTO_VIDEO_SHA256) {
    throw new Error('Bundled Quest Auto video failed integrity verification');
  }
  cachedVideo = video;
  return cachedVideo;
}

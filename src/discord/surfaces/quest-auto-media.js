import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const QUEST_AUTO_VIDEO_FILENAME = 'videoplayback.mp4';
const QUEST_AUTO_VIDEO_PATH = fileURLToPath(new URL('../assets/videoplayback.mp4', import.meta.url));
const QUEST_AUTO_VIDEO_SIZE = 6_812_564;
const QUEST_AUTO_VIDEO_SHA256 = '0a09d0088a30cc90722af5c1602b4335853246a28ccd46d321cc7c5b64efa467';

let cachedVideo = null;

export async function loadQuestAutoVideo() {
  if (cachedVideo) return cachedVideo;
  const video = await readFile(QUEST_AUTO_VIDEO_PATH);
  const validContainer = video.subarray(4, 8).toString('ascii') === 'ftyp';
  const digest = createHash('sha256').update(video).digest('hex');
  if (video.length !== QUEST_AUTO_VIDEO_SIZE || !validContainer || digest !== QUEST_AUTO_VIDEO_SHA256) {
    throw new Error('Bundled Quest Auto video failed integrity verification');
  }
  cachedVideo = video;
  return cachedVideo;
}

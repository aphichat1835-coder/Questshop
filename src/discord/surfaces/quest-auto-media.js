import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const QUEST_AUTO_VIDEO_FILENAME = 'quest-auto-demo.mp4';
const QUEST_AUTO_VIDEO_CHUNK_DIRECTORY = fileURLToPath(
  new URL('../../../assets/quest-auto-demo.b64/', import.meta.url),
);

let cachedVideo;

function assertMp4(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1_024 || buffer.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error('Bundled Quest Auto demo video is invalid');
  }
  return buffer;
}

export async function loadQuestAutoVideo() {
  cachedVideo ??= (async () => {
    const names = (await readdir(QUEST_AUTO_VIDEO_CHUNK_DIRECTORY))
      .filter((name) => /^\d+\.b64$/.test(name))
      .sort();
    if (!names.length) throw new Error('Bundled Quest Auto demo video is missing');
    const chunks = await Promise.all(names.map((name) => readFile(
      `${QUEST_AUTO_VIDEO_CHUNK_DIRECTORY}/${name}`, 'utf8',
    )));
    const encoded = chunks.join('').replaceAll(/\s+/g, '');
    return assertMp4(Buffer.from(encoded, 'base64'));
  })();
  return cachedVideo;
}

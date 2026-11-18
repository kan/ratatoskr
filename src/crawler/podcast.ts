import type { AudioChapter } from '../../shared/types';
import type { ParsedAudio } from './types';
import { attr, collect, isXmlNode, pick, text } from './xml';

/**
 * Podcast のエピソードの音声を、フィードの item / entry から拾う（issue #46）。
 *
 * - RSS 2.0 … `<enclosure url type length>`
 * - Atom … `<link rel="enclosure" href type>`
 * - 長さ … `<itunes:duration>`（`2:34:53` / `47:56` / `3600`）
 * - チャプター … Podlove Simple Chapters（`<psc:chapters><psc:chapter start title>`）
 *
 * **音声の enclosure だけを拾う。** enclosure は画像や PDF にも使われるので、type が
 * audio/* のもの（type が無ければ拡張子が音声のもの）に限る。動画の Podcast は対象外。
 * url はフィードに書かれたまま返す（相対 URL の解決は取り込み側。記事の URL と同じ）
 */
export function audioOf(item: unknown): ParsedAudio | undefined {
  const enclosure = findAudioEnclosure(item);
  if (enclosure === null) return undefined;
  return {
    url: enclosure.url,
    type: enclosure.type,
    duration: parseDuration(text(pick(item, 'duration'))),
    chapters: chaptersOf(item),
  };
}

const AUDIO_EXTENSION = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:[?#]|$)/i;

function findAudioEnclosure(item: unknown): { url: string; type: string | null } | null {
  const candidates = [
    ...collect(item, 'enclosure').map((node) => ({
      url: attr(node, 'url'),
      type: attr(node, 'type'),
    })),
    ...collect(item, 'link')
      .filter((node) => isXmlNode(node) && attr(node, 'rel') === 'enclosure')
      .map((node) => ({ url: attr(node, 'href'), type: attr(node, 'type') })),
  ];
  for (const candidate of candidates) {
    const url = candidate.url?.trim() ?? '';
    if (url === '') continue;
    const type = candidate.type?.trim().toLowerCase() || null;
    if (type === null ? AUDIO_EXTENSION.test(url) : type.startsWith('audio/')) {
      return { url, type };
    }
  }
  return null;
}

/**
 * `h:mm:ss` / `mm:ss` / 秒数を秒に直す。小数点以下（`05:32.500`）は切り捨てる。
 * 読めなければ null（長さは表示と区切りの目安にしか使わない）
 */
export function parseDuration(value: string | null): number | null {
  if (value === null) return null;
  const parts = value.trim().split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? Math.floor(seconds) : null;
}

function chaptersOf(item: unknown): AudioChapter[] {
  const chapters: AudioChapter[] = [];
  for (const node of collect(pick(item, 'chapters'), 'chapter')) {
    const start = parseDuration(attr(node, 'start'));
    const title = attr(node, 'title')?.trim() ?? '';
    if (start === null || title === '') continue;
    chapters.push({ start, title });
  }
  return chapters.sort((a, b) => a.start - b.start);
}

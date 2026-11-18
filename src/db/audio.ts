import type { AudioChapter, TranscriptSummary } from '../../shared/types';
import { asArray, asObject, asString, parseJson } from '../lib/json';

/**
 * Podcast（issue #46）の列に JSON で持つ値の読み出し。entries と transcripts の
 * どちらの読み出しからも使う
 */

/** 書いたのは取り込み（insertEntries）だが、列の中身は形を確かめてから使う */
export function parseChapters(json: string | null): AudioChapter[] {
  if (json === null) return [];
  return asArray(parseJson(json)).flatMap((value) => {
    const chapter = asObject(value);
    const start = chapter?.start;
    const title = asString(chapter?.title);
    return typeof start === 'number' && title !== null ? [{ start, title }] : [];
  });
}

/** 書いたのは completeTranscript だが、列の中身は形を確かめてから使う */
export function parseSummary(json: string | null): TranscriptSummary | null {
  if (json === null) return null;
  const value = asObject(parseJson(json));
  const overview = asString(value?.overview);
  if (overview === null) return null;
  const sections = asArray(value?.sections).flatMap((item) => {
    const section = asObject(item);
    const start = section?.start;
    const text = asString(section?.text);
    const title = section?.title === null ? null : asString(section?.title);
    // title は null（チャプターの無い番組）か文字列。どちらでもなければ形が崩れている
    if (typeof start !== 'number' || text === null) return [];
    if (title === null && section?.title !== null) return [];
    return [{ start, title, text }];
  });
  return { overview, sections };
}

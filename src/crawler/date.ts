import { text } from './xml';

// 実在しない日付を掴まされたときの足切り。RSS 以前の日付や、遠い未来の日付は
// フィード側の壊れた値とみなす。published_at は表示専用で順序には使わないので、
// 迷ったら null に倒してよい（docs/DESIGN.md §5）
const MIN_EPOCH = 631152000; // 1990-01-01
const FUTURE_TOLERANCE = 366 * 24 * 60 * 60; // 時計のずれを見込んで 1 年先まで許す

/**
 * RFC 822 / RFC 3339 / その亜種を Unix 秒に落とす。
 * パースできなければ null を返し、記事自体は取り込む。
 */
export function parseDate(value: unknown, now = Math.floor(Date.now() / 1000)): number | null {
  const raw = text(value);
  if (raw === null) return null;

  const candidate = raw.trim();
  let ms = Date.parse(candidate);
  if (Number.isNaN(ms)) {
    // 'YYYY-MM-DD hh:mm:ss' のように T が抜けている亜種を救う
    ms = Date.parse(candidate.replace(' ', 'T'));
  }
  if (Number.isNaN(ms)) return null;

  const seconds = Math.floor(ms / 1000);
  if (seconds < MIN_EPOCH) return null;
  if (seconds > now + FUTURE_TOLERANCE) return null;
  return seconds;
}

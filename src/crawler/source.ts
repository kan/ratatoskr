import { errorMessage } from '../lib/errors';
import { withFeed } from './api-feed';
import { asobiTicket } from './asobiticket';
import { fetchFeed } from './fetch';
import { idolmasterNews } from './idolmaster';
import { parseFeed } from './parse';
import type { KnownSource, Source } from './types';

/**
 * フィードの取り込み口（docs/DESIGN.md の「RSS を出さないサイトを取り込む」）。
 *
 * RSS を出していないサイトは、裏の API を引いて `ParsedFeed` に組み立てる。
 * そこから先（サニタイズ、同一性判定、取得間隔）は RSS と同じ経路を通るので、
 * ソースが返すのは「取得してパースした結果」までにする。
 *
 * **どのソースかはフィードの URL で決める。** 種別の列を持たないのは、URL から
 * 一意に決まる値を二重に持つと、食い違ったときにどちらが正しいか決められないため。
 */

const KNOWN_SOURCES: readonly KnownSource[] = [idolmasterNews, asobiTicket];

/**
 * URL が既知のソースを指していれば、そのソースを返す。
 *
 * ホストとパスで照合し、末尾の `/` とクエリは見ない。購読の追加で貼られる URL と、
 * 遡って行き着く上の階層（src/crawler/discover.ts）は、どちらも末尾に `/` が付きうる
 */
export function knownSource(url: string): KnownSource | null {
  const key = sourceKey(url);
  if (key === null) return null;
  return KNOWN_SOURCES.find((source) => sourceKey(source.url) === key) ?? null;
}

function sourceKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function sourceFor(url: string): Source {
  return knownSource(url) ?? rssSource;
}

/** 既定のソース。フィードの URL を取って RSS 2.0 / Atom / RDF として読む */
const rssSource: Source = {
  async fetch(target, fetchImpl, now) {
    const outcome = await fetchFeed(target, fetchImpl);
    if (outcome.kind !== 'fetched') return outcome;
    try {
      return withFeed(outcome, parseFeed(outcome.body, now));
    } catch (err) {
      // 取れてはいるがフィードではない。URL の付け替えでしか直らないので分けて記録する
      return { kind: 'error', message: errorMessage(err), reason: 'not_a_feed' };
    }
  },
};

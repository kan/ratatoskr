import type { FetchOutcome } from './fetch';
import type { ParsedFeed, SourceOutcome } from './types';

/**
 * 裏の API から記事を組み立てるソース（src/crawler/idolmaster.ts、asobiticket.ts）の
 * 共通部品。
 *
 * どちらも取得そのものは `fetchFeed` に URL を差し替えて任せ、応答の JSON を
 * `ParsedFeed` に組み立てる。**失敗の分類だけは RSS と同じにできない**ので、
 * ここで言い直す。
 */

/** 取れた本文をパースした結果に差し替える。条件付き GET の控えはそのまま引き継ぐ */
export function withFeed(
  outcome: Extract<FetchOutcome, { kind: 'fetched' }>,
  feed: ParsedFeed,
): SourceOutcome {
  const { etag, lastModified, contentHash } = outcome;
  return { kind: 'fetched', feed, etag, lastModified, contentHash };
}

/**
 * 取れなかった結果を、どの要求で駄目だったかを添えて返す。
 *
 * **404 / 403 は `other` に言い直す。** フィードの URL なら 404 は「フィードが消えた」で、
 * 購読管理画面は 1 回の失敗で一括解除を勧める（SubscriptionManager.vue の REMOVABLE）。
 * 裏の API の 404 / 403 は「API が変わった」か「こちらの送信元が弾かれた」で、
 * 購読先のサイトは生きている。解除は取り消せず記事ごと消えるので、勧めさせない
 */
export function notFetched(
  outcome: Exclude<FetchOutcome, { kind: 'fetched' }>,
  label: string,
): SourceOutcome {
  if (outcome.kind !== 'error') return outcome;
  const reason =
    outcome.reason === 'not_found' || outcome.reason === 'forbidden' ? 'other' : outcome.reason;
  return { kind: 'error', message: `${label}: ${outcome.message}`, reason };
}

/**
 * 応答の形が想定と違う。API が変わったと見る。
 *
 * `not_a_feed` にしない理由は `notFetched` の 404 と同じ（一括解除を勧めさせない）
 */
export function apiChanged(message: string): SourceOutcome {
  return { kind: 'error', message: `${message}（API が変わった可能性）`, reason: 'other' };
}

import { MAX_CONSECUTIVE_FAILURES, type Feed } from '@shared/types';

/**
 * 購読解除の確認。
 *
 * **取り消せず、記事も一緒に消える。** 入口が増えても同じ文言で聞けるように、
 * ここ 1 箇所に置く。いまの入口は左ペインのフィード名の行（App.vue）と
 * 購読管理の一覧（SubscriptionManager.vue）の 2 つ。
 *
 * 解除そのものと、解除後に何を知らせるかは呼び出し側に任せる。前者は
 * stores/session の unsubscribe、後者は画面ごとに出し方が違う。
 */
export function confirmUnsubscribe(feed: Feed): boolean {
  return window.confirm(`「${feed.title || feed.url}」の購読を解除する。記事も消える`);
}

/**
 * 連続失敗が続いて、サーバが取得を止めたフィードか（M9）。
 *
 * 判定はサーバ側（src/crawler/schedule.ts の shouldDisable）と同じ式にしてある。
 * 手で「停止」したフィードを巻き込まないよう、失敗回数まで見る。
 *
 * **止まったことは黙っていると分からない。** 記事が増えなくなるだけで、画面上は
 * 「更新の無いフィード」と見分けが付かないので、左ペインで件数を知らせる。
 */
export function isStalled(feed: Feed): boolean {
  return feed.disabled && feed.consecutiveFailures > MAX_CONSECUTIVE_FAILURES;
}

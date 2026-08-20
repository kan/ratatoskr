import type { Feed } from '@shared/types';

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

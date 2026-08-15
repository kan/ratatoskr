/**
 * 手元に置く小さな設定。
 *
 * IndexedDB（lib/db.ts）はフィードと記事のための層なので、初回描画の前に
 * 同期的に読みたいフラグはこちらに置く。キー名の実体はここ 1 箇所に持ち、
 * 画面側も E2E もこれを import する。
 */

export const HELP_SEEN_KEY = 'ratatoskr.help-seen';

export function hasSeenHelp(): boolean {
  return localStorage.getItem(HELP_SEEN_KEY) !== null;
}

export function markHelpSeen(): void {
  localStorage.setItem(HELP_SEEN_KEY, '1');
}

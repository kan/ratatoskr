/**
 * 手元に置く小さな設定。
 *
 * IndexedDB（lib/db.ts）はフィードと記事のための層なので、初回描画の前に
 * 同期的に読みたいフラグはこちらに置く。キー名の実体はここ 1 箇所に持ち、
 * 画面側も E2E もこれを import する。
 *
 * **localStorage に触るのもここだけ。** プライベートウィンドウや保存を止めた設定では
 * 読み書きが例外を投げるので、包む場所を散らさない。
 */

export const HELP_SEEN_KEY = 'ratatoskr.help-seen';

/**
 * 画面のテーマ。**「システムに従う」は値を持たない**（キーが無い状態）。
 * 既定を後から変えたくなったときに、保存済みの値と混ざらない
 */
export const THEME_KEY = 'ratatoskr.theme';

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** null を渡すと消す */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 覚えられなくても、その場の動きは変わらない
  }
}

export function hasSeenHelp(): boolean {
  return readPref(HELP_SEEN_KEY) !== null;
}

export function markHelpSeen(): void {
  writePref(HELP_SEEN_KEY, '1');
}

/**
 * Worker と web で共有する型定義。docs/API.md の「型定義」節が正本。
 * 時刻は全て Unix 秒（整数）。ミリ秒と混在させない。
 */

export interface Feed {
  id: number;
  url: string;
  siteUrl: string | null;
  title: string;
  iconUrl: string | null;
  rate: number; // 1..5
  folder: string; // "" は未分類
  readSeq: number; // 既読ウォーターマーク
  unreadCount: number;
  lastFetchedAt: number | null;
  lastError: string | null;
  disabled: boolean;
}

export interface Entry {
  id: number; // 全体単調増加。順序と未読判定の基準
  feedId: number;
  url: string | null;
  title: string;
  author: string | null;
  body: string; // サニタイズ済み HTML
  publishedAt: number | null;
  storedAt: number;
}

export interface Pin {
  id: number;
  entryId: number | null;
  title: string;
  url: string;
  pinnedAt: number;
}

/** エラーレスポンスの形。HTTP ステータスは別に付く */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface HealthResponse {
  ok: boolean;
  serverTime: number;
  schemaVersion: number;
  /** D1 に到達できたか。到達できない場合は ok=false で 503 を返す */
  db: 'ok' | 'error';
}

/**
 * クライアントが持つデータの互換性判定に使う。
 * スキーマの破壊的変更時にインクリメントし、クライアントは IndexedDB を捨てて取り直す。
 */
export const SCHEMA_VERSION = 1;

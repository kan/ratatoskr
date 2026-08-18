import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Entry, Feed } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { OutboxItem } from '@/stores/outbox';

/**
 * 手元の永続化。起動時にここから即座に描画するためのもの（docs/DESIGN.md §6）。
 *
 * 置くものは 2 種類ある。
 *
 *   - キャッシュ（feeds / entries / meta）: サーバから取り直せる。スキーマが
 *     変わったら中身は捨てて作り直す
 *   - 未送信の書き込み（outbox / entryStates）: サーバにも他の端末にも無い。
 *     捨てるとユーザの操作そのものが消えるので、スキーマが変わっても残す
 *
 * バージョンは shared の SCHEMA_VERSION に合わせる。
 */

interface RatatoskrDb extends DBSchema {
  feeds: {
    key: number;
    value: Feed;
  };
  entries: {
    key: number;
    value: Entry;
    indexes: { feedId: number };
  };
  meta: {
    key: string;
    value: unknown;
  };
  /** 送信待ちの書き込み。オフラインで読んでもタブを閉じても失われない（DESIGN.md §6） */
  outbox: {
    key: string;
    value: OutboxItem;
  };
  /**
   * 手動で未読に戻した記事（サーバの entry_states の写し）。
   * ウォーターマークから逸脱する記事だけを持つので、行数は実用上ゼロに近い
   */
  entryStates: {
    key: number;
    value: { entryId: number };
  };
}

export interface Snapshot {
  feeds: Feed[];
  entries: Entry[];
  /** 最後に受け取ったサーバの記事カーソル */
  entryCursor: number;
  /** 最後に同期した時刻（Unix 秒） */
  syncedAt: number;
}

const DB_NAME = 'ratatoskr';
const META_CURSOR = 'entryCursor';
const META_SYNCED_AT = 'syncedAt';

/** 作り直してよいストア。ここに無いものは中身ごと引き継ぐ */
const CACHE_STORES = ['feeds', 'entries', 'meta'] as const;

let dbPromise: Promise<IDBPDatabase<RatatoskrDb>> | null = null;

function db(): Promise<IDBPDatabase<RatatoskrDb>> {
  dbPromise ??= openDB<RatatoskrDb>(DB_NAME, SCHEMA_VERSION, {
    upgrade(database, _oldVersion, _newVersion, transaction) {
      // キャッシュは全てサーバから取り直せる。互換を保つより捨てて作り直す方が安全
      for (const name of CACHE_STORES) {
        if (database.objectStoreNames.contains(name)) database.deleteObjectStore(name);
      }

      database.createObjectStore('feeds', { keyPath: 'id' });
      const entries = database.createObjectStore('entries', { keyPath: 'id' });
      entries.createIndex('feedId', 'feedId');
      database.createObjectStore('meta');

      // 未送信の書き込みは作り直さない。既にあるなら中身ごと引き継ぐ
      if (!database.objectStoreNames.contains('outbox')) {
        database.createObjectStore('outbox', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('entryStates')) {
        database.createObjectStore('entryStates', { keyPath: 'entryId' });
      }

      // 直後に読み出されても空で困らないよう、既定値を入れておく
      transaction.objectStore('meta').put(0, META_CURSOR);
      transaction.objectStore('meta').put(0, META_SYNCED_AT);
    },
  });
  return dbPromise;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** 起動時に 1 回だけ呼ぶ。オフラインでもここまでは必ず動く */
export async function loadSnapshot(): Promise<Snapshot> {
  const database = await db();
  const [feeds, entries, entryCursor, syncedAt] = await Promise.all([
    database.getAll('feeds'),
    database.getAll('entries'),
    database.get('meta', META_CURSOR),
    database.get('meta', META_SYNCED_AT),
  ]);
  return {
    feeds,
    entries,
    entryCursor: asNumber(entryCursor),
    syncedAt: asNumber(syncedAt),
  };
}

/**
 * IndexedDB は structured clone で値を書くので、Vue の reactive プロキシを
 * そのまま渡すと DataCloneError で落ちる。ストアの値を渡されても困らないよう、
 * 保存する側で素のオブジェクトに戻す。
 *
 * Feed / Entry の中身は全て primitive なので、浅いコピーで足りる。
 */
function plain<T extends object>(value: T): T {
  return { ...value };
}

/** 変わったフィードだけを書き直す。既読が進むたびに全件を書き戻さないため */
export async function putFeeds(feeds: Feed[]): Promise<void> {
  if (feeds.length === 0) return;
  const rows = feeds.map(plain);
  const database = await db();
  const tx = database.transaction('feeds', 'readwrite');
  await Promise.all(rows.map((feed) => tx.store.put(feed)));
  await tx.done;
}

/** 購読の増減を反映するためにまるごと置き換える。bootstrap の応答を受けたときだけ使う */
export async function saveFeeds(feeds: Feed[]): Promise<void> {
  const rows = feeds.map(plain);
  const database = await db();
  const tx = database.transaction('feeds', 'readwrite');
  await tx.store.clear();
  await Promise.all(rows.map((feed) => tx.store.put(feed)));
  await tx.done;
}

/**
 * 記事は追加する一方で、いまは消していない。使い続けると起動時の getAll が重くなるので、
 * 既読かつ古い記事の間引きを M9（保持期間の実装）で入れる。サーバ側の削除方針と
 * 揃えたいので、ここだけ先に作らない。
 */
export async function saveEntries(entries: Entry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map(plain);
  const database = await db();
  const tx = database.transaction('entries', 'readwrite');
  await Promise.all(rows.map((entry) => tx.store.put(entry)));
  await tx.done;
}

/** 購読解除。フィードの行と、そのフィードの記事をまとめて捨てる */
export async function deleteFeedData(feedId: number): Promise<void> {
  const database = await db();
  const tx = database.transaction(['feeds', 'entries'], 'readwrite');
  const entries = tx.objectStore('entries');
  const keys = await entries.index('feedId').getAllKeys(feedId);
  await Promise.all([
    tx.objectStore('feeds').delete(feedId),
    ...keys.map((key) => entries.delete(key)),
  ]);
  await tx.done;
}

export async function saveCursor(entryCursor: number, syncedAt: number): Promise<void> {
  const database = await db();
  const tx = database.transaction('meta', 'readwrite');
  await Promise.all([
    tx.store.put(entryCursor, META_CURSOR),
    tx.store.put(syncedAt, META_SYNCED_AT),
  ]);
  await tx.done;
}

/**
 * 送信待ちの書き込みを読み戻す。起動時に 1 回だけ呼ぶ。
 * 前回の起動でオフラインだった分は、ここから再送される。
 */
export async function loadOutbox(): Promise<OutboxItem[]> {
  return (await db()).getAll('outbox');
}

/** キューへの積み増し。key で上書きされる（同じ対象への操作はまとめる） */
export async function putOutboxItem(item: OutboxItem): Promise<void> {
  await (await db()).put('outbox', plain(item));
}

/** 送信が確定した分を落とす */
export async function deleteOutboxItems(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  await Promise.all(keys.map((key) => tx.store.delete(key)));
  await tx.done;
}

/** 手動で未読に戻した記事の id。再読み込みしても未読のまま残すために持つ */
export async function loadEntryStates(): Promise<number[]> {
  const rows = await (await db()).getAll('entryStates');
  return rows.map((row) => row.entryId);
}

export async function putEntryState(entryId: number): Promise<void> {
  await (await db()).put('entryStates', { entryId });
}

export async function deleteEntryState(entryId: number): Promise<void> {
  await (await db()).delete('entryStates', entryId);
}

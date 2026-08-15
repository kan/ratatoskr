import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Entry, Feed } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';

/**
 * 手元の永続化。起動時にここから即座に描画するためのもの（docs/DESIGN.md §6）。
 *
 * サーバから取り直せるデータしか置かないので、スキーマが変わったら中身は捨てて
 * 作り直す。バージョンは shared の SCHEMA_VERSION に合わせる。
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

let dbPromise: Promise<IDBPDatabase<RatatoskrDb>> | null = null;

function db(): Promise<IDBPDatabase<RatatoskrDb>> {
  dbPromise ??= openDB<RatatoskrDb>(DB_NAME, SCHEMA_VERSION, {
    upgrade(database, _oldVersion, _newVersion, transaction) {
      // 手元のデータは全てサーバから取り直せる。互換を保つより捨てて作り直す方が安全
      for (const name of [...database.objectStoreNames]) database.deleteObjectStore(name);

      database.createObjectStore('feeds', { keyPath: 'id' });
      const entries = database.createObjectStore('entries', { keyPath: 'id' });
      entries.createIndex('feedId', 'feedId');
      database.createObjectStore('meta');

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

export async function saveCursor(entryCursor: number, syncedAt: number): Promise<void> {
  const database = await db();
  const tx = database.transaction('meta', 'readwrite');
  await Promise.all([
    tx.store.put(entryCursor, META_CURSOR),
    tx.store.put(syncedAt, META_SYNCED_AT),
  ]);
  await tx.done;
}

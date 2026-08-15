import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Entry, Feed } from '@shared/types';
import { useEntriesStore } from './entries';
import { sortByReadingOrder, useFeedsStore } from './feeds';

/**
 * 既読ウォーターマークのテスト（CLAUDE.md のテスト方針で必須とされている箇所）。
 * 見るのは「巻き戻らないこと」と「新着・未表示の記事が既読にならないこと」。
 */

function feed(id: number, overrides: Partial<Feed> = {}): Feed {
  return {
    id,
    url: `https://example.com/${id}/feed`,
    siteUrl: null,
    title: `フィード ${id}`,
    iconUrl: null,
    rate: 3,
    folder: '',
    readSeq: 0,
    unreadCount: 0,
    lastFetchedAt: null,
    lastError: null,
    disabled: false,
    ...overrides,
  };
}

function entry(id: number, feedId: number): Entry {
  return {
    id,
    feedId,
    url: `https://example.com/${feedId}/${id}`,
    title: `記事 ${id}`,
    author: null,
    body: '<p>本文</p>',
    publishedAt: null,
    storedAt: 0,
  };
}

function entries(feedId: number, ids: number[]): Entry[] {
  return ids.map((id) => entry(id, feedId));
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('既読ウォーターマーク', () => {
  it('記事を表示するたびにその記事まで既読になる', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [10, 11, 12]));
    feeds.setFeeds([feed(1, { unreadCount: 3 })]);
    feeds.enterFirstUnread();

    // 開いた時点で 1 件目は読んだことになる
    expect(feeds.feeds[0].readSeq).toBe(10);
    expect(feeds.feeds[0].unreadCount).toBe(2);

    feeds.nextEntry();
    expect(feeds.feeds[0].readSeq).toBe(11);
    expect(feeds.feeds[0].unreadCount).toBe(1);

    feeds.nextEntry();
    expect(feeds.feeds[0].readSeq).toBe(12);
    expect(feeds.feeds[0].unreadCount).toBe(0);
  });

  it('前の記事に戻っても既読は巻き戻らない', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [10, 11, 12]));
    feeds.setFeeds([feed(1, { unreadCount: 3 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry();
    feeds.nextEntry();
    expect(feeds.feeds[0].readSeq).toBe(12);

    feeds.prevEntry();
    feeds.prevEntry();
    expect(feeds.feeds[0].readSeq).toBe(12);
    expect(feeds.feeds[0].unreadCount).toBe(0);
  });

  it('途中まで読んだフィードに戻ると続きから出る', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [10, 11, 12]), ...entries(2, [13])]);
    feeds.setFeeds([feed(1, { unreadCount: 3 }), feed(2, { unreadCount: 1 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry(); // 11 まで読んだ

    feeds.selectFeed(2);
    feeds.selectFeed(1);
    expect(feeds.currentEntries.map((e) => e.id)).toEqual([12]);
  });

  it('一括既読は手元にある分だけを既読にして次のフィードへ進む', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest([...entries(1, [10, 11, 12]), ...entries(2, [13])]);
    feeds.setFeeds([feed(1, { unreadCount: 3 }), feed(2, { unreadCount: 1 })]);
    feeds.enterFirstUnread();

    feeds.readAllAndNext();
    expect(feeds.feeds[0].readSeq).toBe(12);
    expect(feeds.feeds[0].unreadCount).toBe(0);
    expect(feeds.currentFeed?.id).toBe(2);
  });

  it('サーバの古い read_seq を受けても巻き戻らない', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [10, 11]));
    feeds.setFeeds([feed(1, { unreadCount: 2 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry();
    expect(feeds.feeds[0].readSeq).toBe(11);

    // 既読はまだサーバに送っていないので、サーバは常に古い値を返す
    feeds.setFeeds([feed(1, { readSeq: 0, unreadCount: 2 })]);
    expect(feeds.feeds[0].readSeq).toBe(11);
    expect(feeds.feeds[0].unreadCount).toBe(0);
  });

  it('サーバの方が進んでいればそちらに追随する（他端末で読んだ場合）', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [10, 11]));
    feeds.setFeeds([feed(1, { unreadCount: 2 })]);

    feeds.setFeeds([feed(1, { readSeq: 11, unreadCount: 0 })]);
    expect(feeds.feeds[0].readSeq).toBe(11);
  });

  it('表示していない記事は既読にしない', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();

    // bootstrap が同梱するのは古い方から 50 件まで。残りは背景取得で後から届く
    entriesStore.ingest(entries(1, [1, 2, 3]));
    feeds.setFeeds([feed(1, { unreadCount: 10 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry();
    feeds.nextEntry();
    expect(feeds.feeds[0].readSeq).toBe(3);

    // 3 件目を読み終えた「後」に届いた記事を既読に巻き込まない
    entriesStore.ingest(entries(1, [4, 5]));
    expect(feeds.feeds[0].readSeq).toBe(3);
  });

  it('手元にあっても画面に出していない記事は既読にしない', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();

    entriesStore.ingest(entries(1, [1, 2, 3]));
    feeds.setFeeds([feed(1, { unreadCount: 10 })]);
    feeds.enterFirstUnread();

    // リストに取り込む前に背景取得が進んだ状態。ウォーターマークの材料は
    // 「手元にある最大 id」ではなく「実際に出した最大 id」でなければならない
    entriesStore.ingest(entries(1, [4, 5]));
    feeds.nextEntry();
    feeds.nextEntry();

    expect(feeds.feeds[0].readSeq).toBe(3);
    expect(feeds.feeds[0].unreadCount).toBe(2);
  });

  it('読んでいる最中に届いた記事はリストに足され、既読にならない', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();

    entriesStore.ingest(entries(1, [1, 2]));
    feeds.setFeeds([feed(1, { unreadCount: 5 })]);
    feeds.enterFirstUnread();
    expect(feeds.entryCount).toBe(2);

    entriesStore.ingest(entries(1, [3, 4, 5]));
    feeds.absorbNewEntries();

    expect(feeds.entryCount).toBe(5);
    // 現在位置（1 件目）は動かない
    expect(feeds.currentEntry?.id).toBe(1);
    // 表示したのは 1 件目だけ
    expect(feeds.feeds[0].readSeq).toBe(1);
    expect(feeds.feeds[0].unreadCount).toBe(4);
  });

  it('次のフィードに入っても、まだ出していない記事は既読にしない', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1, 2, 3, 4, 5]), ...entries(2, [10, 11, 12, 13, 14])]);
    feeds.setFeeds([feed(1, { unreadCount: 5 }), feed(2, { unreadCount: 5 })]);
    feeds.enterFirstUnread();
    for (let i = 0; i < 3; i += 1) feeds.nextEntry(); // 4 件目まで読む

    feeds.nextFeed();
    expect(feeds.currentEntry?.id).toBe(10);
    // 入った瞬間に 10 だけが既読。11 以降を巻き込まない
    expect(feeds.feeds[1].readSeq).toBe(10);
    expect(feeds.feeds[1].unreadCount).toBe(4);
  });

  it('s で飛ばした未読フィードに k で戻っても全部既読にしない', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1, 2, 3]), ...entries(2, [10])]);
    feeds.setFeeds([feed(1, { unreadCount: 3 }), feed(2, { unreadCount: 1 })]);
    feeds.enterFirstUnread();
    feeds.nextFeed(); // フィード 1 を飛ばす

    feeds.prevEntry(); // k で戻る
    expect(feeds.currentFeed?.id).toBe(1);
    // 続きの 1 件目に着地する。末尾に着地すると間の記事まで既読になってしまう
    expect(feeds.currentEntry?.id).toBe(2);
    expect(feeds.feeds[0].readSeq).toBe(2);
    expect(feeds.feeds[0].unreadCount).toBe(1);
  });

  it('既読より前の記事は届いても再び出さない', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();

    entriesStore.ingest(entries(1, [10, 11]));
    feeds.setFeeds([feed(1, { readSeq: 10, unreadCount: 1 })]);
    feeds.enterFirstUnread();
    expect(feeds.currentEntries.map((e) => e.id)).toEqual([11]);

    entriesStore.ingest(entries(1, [9]));
    feeds.absorbNewEntries();
    expect(feeds.currentEntries.map((e) => e.id)).toEqual([11]);
  });
});

describe('フィード間の移動', () => {
  function threeFeeds() {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1, 2]), ...entries(2, [3]), ...entries(3, [4])]);
    feeds.setFeeds([
      feed(1, { rate: 5, unreadCount: 2 }),
      feed(2, { rate: 3, unreadCount: 0, readSeq: 3 }),
      feed(3, { rate: 1, unreadCount: 1 }),
    ]);
    feeds.enterFirstUnread();
    return feeds;
  }

  it('未読が無いフィードは飛ばして次に進む', () => {
    const feeds = threeFeeds();
    expect(feeds.currentFeed?.id).toBe(1);

    feeds.nextFeed();
    expect(feeds.currentFeed?.id).toBe(3);
  });

  it('戻るときは未読の有無で絞らない（読み終えたばかりのフィードに戻れる）', () => {
    const feeds = threeFeeds();
    feeds.nextEntry();
    feeds.nextEntry(); // フィード 1 を読み終えて 3 へ
    expect(feeds.currentFeed?.id).toBe(3);
    expect(feeds.feeds[0].unreadCount).toBe(0);

    feeds.prevFeed();
    expect(feeds.currentFeed?.id).toBe(2);
    feeds.prevFeed();
    expect(feeds.currentFeed?.id).toBe(1);
    // 既読でも読み返せる
    expect(feeds.currentEntries.map((e) => e.id)).toEqual([1, 2]);
  });

  it('最後まで読み切ったら止まる（先頭には戻らない）', () => {
    const feeds = threeFeeds();
    feeds.nextEntry();
    feeds.nextEntry();
    expect(feeds.currentFeed?.id).toBe(3);

    feeds.nextEntry();
    expect(feeds.finished).toBe(true);
    feeds.nextEntry();
    expect(feeds.finished).toBe(true);
  });

  it('読了後に前の記事へ戻ると読了表示を解除する', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [1, 2]));
    feeds.setFeeds([feed(1, { unreadCount: 2 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry();
    feeds.nextEntry();
    expect(feeds.finished).toBe(true);

    feeds.prevEntry();
    expect(feeds.finished).toBe(false);
    expect(feeds.currentEntry?.id).toBe(1);
  });

  it('未読数を手元の記事から数え直せる', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [1, 2, 3]));
    // サーバの申告と手元の実態がずれている状態
    feeds.setFeeds([feed(1, { unreadCount: 99 })]);

    feeds.recountUnread();
    expect(feeds.feeds[0].unreadCount).toBe(3);
  });
});

describe('読む順序', () => {
  it('レート降順 → 未読数降順で並べ直す（IndexedDB は id 順で返るため）', () => {
    const stored = [
      feed(2, { rate: 3, unreadCount: 1 }),
      feed(5, { rate: 1, unreadCount: 9 }),
      feed(9, { rate: 5, unreadCount: 2 }),
      feed(11, { rate: 5, unreadCount: 7 }),
    ];
    expect(sortByReadingOrder(stored).map((f) => f.id)).toEqual([11, 9, 2, 5]);
  });
});

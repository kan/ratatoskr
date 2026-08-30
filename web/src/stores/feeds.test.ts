import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
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
    lastErrorKind: null,
    consecutiveFailures: 0,
    disabled: false,
    fullText: false,
    fullTextSuggested: false,
    ...overrides,
  };
}

function entry(id: number, feedId: number, body = '<p>本文</p>'): Entry {
  return {
    id,
    feedId,
    url: `https://example.com/${feedId}/${id}`,
    title: `記事 ${id}`,
    author: null,
    body,
    publishedAt: null,
    storedAt: 0,
  };
}

/** 画像 1 枚だけを持つ記事。先読みウィンドウの並びを見るのに使う */
function imageEntry(id: number, feedId: number): Entry {
  return entry(id, feedId, `<img src="https://img.example.com/${id}.jpg">`);
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

  it('読了後に新着が届いたら、そこへ座り直す', () => {
    // 読み終えてもカーソルは最後のフィードに残る（started は真のまま）ので、
    // 座り直す道が無いと、未読数だけ増えて「全て読み終えた」から動かなくなる
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [1, 2]));
    feeds.setFeeds([feed(1, { unreadCount: 2 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry();
    feeds.nextEntry();
    expect(feeds.finished).toBe(true);

    entriesStore.ingest(entries(1, [3]));
    feeds.setFeeds([feed(1, { readSeq: 2, unreadCount: 1 })]);
    feeds.absorbNewEntries();

    expect(feeds.finished).toBe(false);
    expect(feeds.currentEntry?.id).toBe(3);
  });

  it('読了後に空振りの同期が来ても、読んでいた位置は動かさない', () => {
    // 座り直しを無条件にすると、5 分ごとの同期のたびに a で戻る位置がずれる
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1]), ...entries(2, [2])]);
    feeds.setFeeds([feed(1, { unreadCount: 1 }), feed(2, { unreadCount: 1 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry();
    feeds.nextEntry();
    expect(feeds.finished).toBe(true);
    expect(feeds.currentFeed?.id).toBe(2);

    feeds.absorbNewEntries();

    expect(feeds.finished).toBe(true);
    expect(feeds.currentFeed?.id).toBe(2);
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

describe('未読に戻す（u）', () => {
  it('その記事だけを未読に戻し、ウォーターマークは動かさない', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10, 11, 12]));
    feeds.setFeeds([feed(1, { unreadCount: 3 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry(); // 11 を表示 → 10 と 11 が既読

    feeds.markCurrentUnread();
    expect(feeds.feeds[0].readSeq).toBe(11);
    // 10 は既読のまま。巻き戻すと後ろの既読がまとめて消える
    expect(entriesStore.isUnread(10, feeds.feeds[0].readSeq)).toBe(false);
    expect(entriesStore.isUnread(11, feeds.feeds[0].readSeq)).toBe(true);
    expect(feeds.feeds[0].unreadCount).toBe(2);
  });

  it('既読化が追い越しても未読のまま残る', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10, 11, 12]));
    feeds.setFeeds([feed(1, { unreadCount: 3 })]);
    feeds.enterFirstUnread();

    feeds.markCurrentUnread(); // 10 を未読に戻す
    feeds.nextEntry();
    feeds.nextEntry(); // 12 まで読み進める

    expect(feeds.feeds[0].readSeq).toBe(12);
    expect(feeds.feeds[0].unreadCount).toBe(1);
    expect(entriesStore.unreadOf(1, feeds.feeds[0].readSeq).map((e) => e.id)).toEqual([10]);
  });

  it('未読に戻したフィードに入り直すとその記事から読める', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10, 11]));
    entriesStore.ingest(entries(2, [20]));
    feeds.setFeeds([feed(1, { unreadCount: 2 }), feed(2, { unreadCount: 1 })]);
    feeds.enterFirstUnread();

    feeds.markCurrentUnread(); // 10 を未読に戻す
    feeds.nextEntry(); // 11
    feeds.nextEntry(); // フィード 2 へ
    expect(feeds.currentFeed?.id).toBe(2);

    feeds.selectFeed(1);
    expect(feeds.currentEntries.map((e) => e.id)).toEqual([10]);
    // もう一度表示したのだから既読に戻る（「表示したら既読」が唯一の規則）
    expect(entriesStore.isUnread(10, feeds.feeds[0].readSeq)).toBe(false);
    expect(feeds.feeds[0].unreadCount).toBe(0);
  });

  it('背景取得で古い記事が届いても、未読に戻した記事の例外は外れない', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    // bootstrap が同梱するのは新しい方だけ。古い記事は後から届く
    entriesStore.ingest(entries(1, [20, 21]));
    feeds.setFeeds([feed(1, { unreadCount: 2 })]);
    feeds.enterFirstUnread();
    feeds.markCurrentUnread(); // 20 を未読に戻す

    entriesStore.ingest(entries(1, [10, 11]));
    feeds.absorbNewEntries();

    // 差し替えの途中で位置がずれると、その記事の例外が解除されてしまう
    expect(feeds.currentEntry?.id).toBe(20);
    expect(entriesStore.isUnread(20, feeds.feeds[0].readSeq)).toBe(true);
  });

  it('Shift+S は未読に戻した記事も既読にする', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10, 11, 12]));
    entriesStore.ingest(entries(2, [20]));
    feeds.setFeeds([feed(1, { unreadCount: 3 }), feed(2, { unreadCount: 1 })]);
    feeds.enterFirstUnread();

    feeds.markCurrentUnread(); // 10 を未読に戻す
    feeds.readAllAndNext();

    // 例外を残すとこのフィードが未読 1 件のまま居座る
    expect(feeds.feeds[0].unreadCount).toBe(0);
    expect(entriesStore.forcedUnread.size).toBe(0);
    expect(feeds.currentFeed?.id).toBe(2);
  });
});

describe('レート（1–5）', () => {
  it('レートを変えると左ペインの並びがその場で組み替わる', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10]));
    entriesStore.ingest(entries(2, [20]));
    feeds.setFeeds([feed(1, { rate: 5, unreadCount: 1 }), feed(2, { rate: 3, unreadCount: 1 })]);
    feeds.enterFirstUnread();
    expect(feeds.currentFeed?.id).toBe(1);

    // いま読んでいるフィードを最下位に落とす
    feeds.setRate(1);

    expect(feeds.feeds.map((f) => f.id)).toEqual([2, 1]);
    // 並びが変わってもカーソルは同じフィードに乗ったまま
    expect(feeds.currentFeed?.id).toBe(1);
    expect(feeds.currentEntry?.id).toBe(10);
  });

  it('同じ値なら何もしない（送信も並べ替えも起こさない）', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [10]));
    feeds.setFeeds([feed(1, { rate: 3, unreadCount: 1 })]);
    feeds.enterFirstUnread();
    const before = feeds.settingsRevision;

    feeds.setRate(3);
    expect(feeds.settingsRevision).toBe(before);
  });
});

describe('購読の増減', () => {
  it('追加したフィードは読む順序の位置に入る', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10]));
    entriesStore.ingest(entries(2, [20]));
    feeds.setFeeds([feed(1, { rate: 5, unreadCount: 1 }), feed(2, { rate: 1, unreadCount: 1 })]);
    feeds.enterFirstUnread();

    entriesStore.ingest(entries(3, [30]));
    feeds.upsertFeed(feed(3, { rate: 3, unreadCount: 1 }));

    expect(feeds.feeds.map((f) => f.id)).toEqual([1, 3, 2]);
    expect(feeds.currentFeed?.id).toBe(1);
  });

  it('サーバの readSeq で手元の既読を巻き戻さない', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest(entries(1, [10, 11]));
    feeds.setFeeds([feed(1, { unreadCount: 2 })]);
    feeds.enterFirstUnread();
    feeds.nextEntry(); // 11 まで既読

    // 送信が届く前のサーバの値が返ってきた場合
    feeds.upsertFeed(feed(1, { readSeq: 0, unreadCount: 2 }));
    expect(feeds.feeds[0].readSeq).toBe(11);
    expect(feeds.feeds[0].unreadCount).toBe(0);
  });

  it('購読を解除すると記事ごと消え、読んでいたなら次の未読へ移る', () => {
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10]));
    entriesStore.ingest(entries(2, [20]));
    feeds.setFeeds([feed(1, { unreadCount: 1 }), feed(2, { unreadCount: 1 })]);
    feeds.enterFirstUnread();
    expect(feeds.currentFeed?.id).toBe(1);

    feeds.dropFeed(1);

    expect(feeds.feeds.map((f) => f.id)).toEqual([2]);
    expect(entriesStore.of(1)).toEqual([]);
    expect(feeds.currentFeed?.id).toBe(2);
  });
});

/**
 * 先読みウィンドウ（docs/DESIGN.md §6）。見るのは「読む順に並ぶこと」。
 * 読む順序と先読み順序が一致していることが、先読みが当たる前提条件。
 */
describe('先読みウィンドウ', () => {
  function setup(): ReturnType<typeof useFeedsStore> {
    const feeds = useFeedsStore();
    const store = useEntriesStore();
    for (const feedId of [1, 2, 3, 4, 5, 6]) {
      store.ingest([imageEntry(feedId * 10, feedId), imageEntry(feedId * 10 + 1, feedId)]);
    }
    feeds.setFeeds([1, 2, 3, 4, 5, 6].map((id) => feed(id, { unreadCount: 2 })));
    feeds.enterFirstUnread();
    return feeds;
  }

  it('現在のフィードの先から、3 フィード先までを読む順に並べる', () => {
    const feeds = setup();

    // 先頭の記事は表示済みなので積まない。11 の後は 2〜4 番のフィード
    expect(feeds.prefetchUrls).toEqual(
      [11, 20, 21, 30, 31, 40, 41].map((id) => `https://img.example.com/${id}.jpg`),
    );
  });

  it('記事を送るとウィンドウも前に動く', () => {
    const feeds = setup();

    // フィード 1 の最後まで読むと、残るのは先のフィードだけになる
    feeds.nextEntry();
    expect(feeds.prefetchUrls).toEqual(
      [20, 21, 30, 31, 40, 41].map((id) => `https://img.example.com/${id}.jpg`),
    );

    // 次のフィードに移ると、ウィンドウ全体が 1 つ先へずれる
    feeds.nextEntry();
    expect(feeds.prefetchUrls).toEqual(
      [21, 30, 31, 40, 41, 50, 51].map((id) => `https://img.example.com/${id}.jpg`),
    );
  });

  it('未読の無いフィードは飛ばす（s の辿り方と揃える）', () => {
    const feeds = setup();
    // 2 番を読み終えた状態にする。実際には開かないので温めても無駄になる
    feeds.feeds[1].readSeq = 21;
    feeds.feeds[1].unreadCount = 0;

    expect(feeds.prefetchUrls).toEqual(
      [11, 30, 31, 40, 41, 50, 51].map((id) => `https://img.example.com/${id}.jpg`),
    );
  });

  it('画像の多いフィードでも一度に温める枚数を区切る', () => {
    const feeds = useFeedsStore();
    const store = useEntriesStore();
    // 1 記事 10 枚 × 20 記事 × 2 フィード = 400 枚。全部積むと落とし切れない
    const many = (feedId: number, id: number): Entry =>
      entry(
        id,
        feedId,
        Array.from(
          { length: 10 },
          (_, n) => `<img src="https://img.example.com/${id}-${n}.jpg">`,
        ).join(''),
      );
    for (const feedId of [1, 2]) {
      store.ingest(Array.from({ length: 20 }, (_, n) => many(feedId, feedId * 100 + n)));
    }
    feeds.setFeeds([1, 2].map((id) => feed(id, { unreadCount: 20 })));
    feeds.enterFirstUnread();

    expect(feeds.prefetchUrls).toHaveLength(40);
    // 打ち切っても順序は読む順のまま。先頭は表示済みの次の記事の画像
    expect(feeds.prefetchUrls[0]).toBe('https://img.example.com/101-0.jpg');
  });

  it('読み始める前は何も温めない', () => {
    const feeds = useFeedsStore();
    feeds.setFeeds([feed(1, { unreadCount: 2 })]);

    expect(feeds.prefetchUrls).toEqual([]);
  });
});

describe('記事ビューが覆われている間の既読', () => {
  // 引き出しやオーバーレイの下でカーソルが動くことがある（フォルダの切り替え・
  // 購読の解除）。そのまま進めると一度も表示していない記事が既読になる
  function twoFeeds() {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1, 2]), ...entries(2, [3])]);
    feeds.setFeeds([
      feed(1, { rate: 5, folder: '開発', unreadCount: 2 }),
      feed(2, { rate: 3, folder: 'News', unreadCount: 1 }),
    ]);
    feeds.enterFirstUnread();
    return feeds;
  }

  it('覆われている間はカーソルが動いても既読にしない', () => {
    const feeds = twoFeeds();
    feeds.setCovered(true);
    const before = feeds.feeds[1].unreadCount;

    feeds.setFolder('News');
    expect(feeds.currentFeed?.id).toBe(2);
    expect(feeds.feeds[1].unreadCount).toBe(before);
  });

  it('覆いが外れた時点で既読にする', () => {
    const feeds = twoFeeds();
    feeds.setCovered(true);
    feeds.setFolder('News');

    feeds.setCovered(false);
    expect(feeds.feeds[1].unreadCount).toBe(0);
  });

  it('覆われていなければ従来どおり表示した時点で既読にする', () => {
    const feeds = twoFeeds();
    feeds.setFolder('News');
    expect(feeds.feeds[1].unreadCount).toBe(0);
  });
});

describe('フォルダでの絞り込み（issue #3）', () => {
  function mixedFolders() {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1, 2]), ...entries(2, [3]), ...entries(3, [4])]);
    feeds.setFeeds([
      feed(1, { rate: 5, folder: '開発', unreadCount: 2 }),
      feed(2, { rate: 3, folder: 'News', unreadCount: 1 }),
      feed(3, { rate: 1, folder: '開発', unreadCount: 1 }),
    ]);
    feeds.enterFirstUnread();
    return feeds;
  }

  it('絞り込むと、その外のフィードは一覧に出ない', () => {
    const feeds = mixedFolders();
    expect(feeds.visibleFeeds.map((f) => f.id)).toEqual([1, 2, 3]);

    feeds.setFolder('開発');
    expect(feeds.visibleFeeds.map((f) => f.id)).toEqual([1, 3]);
  });

  it('s は絞り込みの外を飛ばす（並び順は変えない）', () => {
    const feeds = mixedFolders();
    feeds.setFolder('開発');
    expect(feeds.currentFeed?.id).toBe(1);

    // レート順では 1 → 2 → 3 だが、2 は News なので飛ぶ
    feeds.nextFeed();
    expect(feeds.currentFeed?.id).toBe(3);
  });

  it('絞り込みの外にカーソルが居たら、その範囲の先頭へ連れ戻す', () => {
    // 置き去りにすると、s / a も先読みも見えていないフィードを起点に回る
    const feeds = mixedFolders();
    expect(feeds.currentFeed?.folder).toBe('開発');

    feeds.setFolder('News');
    expect(feeds.currentFeed?.id).toBe(2);
  });

  it('絞り込みの中に居るカーソルは動かさない', () => {
    const feeds = mixedFolders();
    feeds.nextEntry();
    const entryId = feeds.currentEntry?.id;

    feeds.setFolder('開発');
    expect(feeds.currentFeed?.id).toBe(1);
    expect(feeds.currentEntry?.id).toBe(entryId);
  });

  it('絞り込みを外すと全部に戻る', () => {
    const feeds = mixedFolders();
    feeds.setFolder('News');
    feeds.setFolder(null);

    expect(feeds.visibleFeeds.map((f) => f.id)).toEqual([1, 2, 3]);
    // 戻したときにカーソルは動かさない（外に出ていないので連れ戻す理由が無い）
    expect(feeds.currentFeed?.id).toBe(2);
  });

  it('先読みも絞り込みの中だけを見る', () => {
    const feeds = mixedFolders();
    feeds.setFolder('News');
    // News はフィード 2 だけ。その先に進んでも開発のフィードは温めない
    expect(feeds.prefetchUrls).toEqual([]);
  });

  it('絞った範囲を読み切った後で広げると、読み終えた表示が残らない', () => {
    // 新しい範囲に未読があるのに「全て読み終えた」が出たままになると、
    // そこから未読に辿り着けなくなる
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1]), ...entries(2, [2])]);
    feeds.setFeeds([
      feed(1, { rate: 5, folder: '開発', unreadCount: 1 }),
      feed(2, { rate: 3, folder: 'News', unreadCount: 1 }),
    ]);
    feeds.enterFirstUnread();

    feeds.setFolder('開発');
    feeds.nextFeed(); // 開発に残りは無い
    expect(feeds.finished).toBe(true);

    feeds.setFolder(null);
    expect(feeds.finished).toBe(false);
    expect(feeds.currentFeed?.folder).toBe('News');
  });

  it('絞っていたフォルダが消えたら絞り込みも外す', async () => {
    // 一覧が空になり、選択肢が 1 つになった時点で解除する導線ごと消えて詰む
    const feeds = mixedFolders();
    feeds.setFolder('News');
    feeds.dropFeed(2);
    await nextTick(); // 後始末は描画前に走る（同期では走らない）

    expect(feeds.folder).toBe(null);
    expect(feeds.visibleFeeds.map((f) => f.id)).toEqual([1, 3]);
    expect(feeds.currentFeed?.id).toBe(1);
  });

  it('全て既読のフォルダを選んでも a で読み返せる', () => {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [1]), ...entries(2, [2])]);
    feeds.setFeeds([
      feed(1, { rate: 5, folder: '開発', readSeq: 1, unreadCount: 0 }),
      feed(2, { rate: 3, folder: 'News', unreadCount: 1 }),
    ]);
    feeds.enterFirstUnread();

    feeds.setFolder('開発');
    expect(feeds.feedIndex).toBe(-1);

    feeds.prevFeed();
    expect(feeds.currentFeed?.id).toBe(1);
    expect(feeds.finished).toBe(false);
  });

  it('絞り込みの外に残っている未読を数える（読み終えた画面で範囲を明かすため）', () => {
    const feeds = mixedFolders();
    expect(feeds.unreadOutsideScope).toBe(0); // 絞っていなければ「外」は無い

    feeds.setFolder('News');
    // 開発の 2 本が範囲の外。フィード 1 は先頭記事を表示した時点で 1 件既読なので 1 + 1
    expect(feeds.unreadOutsideScope).toBe(2);
  });

  it('フォルダ名の一覧は重複を畳み、未分類は最後に置く', () => {
    const feeds = useFeedsStore();
    feeds.setFeeds([
      feed(1, { folder: '開発' }),
      feed(2, { folder: '' }),
      feed(3, { folder: 'News' }),
      feed(4, { folder: '開発' }),
    ]);
    expect(feeds.folders).toEqual(['News', '開発', '']);
  });
});

describe('起動時のカーソル（issue #10）', () => {
  /** 手元の控えだけで起動した状態。他の端末で読んだ分は、まだ届いていない */
  function hydrated() {
    const feeds = useFeedsStore();
    useEntriesStore().ingest([...entries(1, [10, 11]), ...entries(2, [20, 21])]);
    feeds.setFeeds([feed(1, { rate: 5, unreadCount: 2 }), feed(2, { rate: 3, unreadCount: 2 })]);
    feeds.enterFirstUnread({ provisional: true });
    return feeds;
  }

  it('他の端末で読み終えていたフィードからは、次の未読へ座り直す', () => {
    const feeds = hydrated();
    expect(feeds.currentEntry?.id).toBe(10);

    // サーバではフィード 1 を読み終えている（控えが遅れていた）
    feeds.setFeeds([
      feed(1, { rate: 5, readSeq: 11, unreadCount: 0 }),
      feed(2, { rate: 3, unreadCount: 2 }),
    ]);
    feeds.confirmLanding(
      new Map([
        [1, 11],
        [2, 0],
      ]),
    );

    expect(feeds.currentFeed?.id).toBe(2);
    expect(feeds.currentEntry?.id).toBe(20);
  });

  it('サーバでも未読だったなら座り直さない', () => {
    const feeds = hydrated();
    feeds.setFeeds([feed(1, { rate: 5, unreadCount: 2 }), feed(2, { rate: 3, unreadCount: 2 })]);
    feeds.confirmLanding(
      new Map([
        [1, 0],
        [2, 0],
      ]),
    );

    expect(feeds.currentFeed?.id).toBe(1);
    expect(feeds.currentEntry?.id).toBe(10);
  });

  it('ユーザが動かした後なら座り直さない（手で選んだ位置を奪わない）', () => {
    const feeds = hydrated();
    feeds.nextEntry(); // 11 へ

    feeds.setFeeds([
      feed(1, { rate: 5, readSeq: 11, unreadCount: 0 }),
      feed(2, { rate: 3, unreadCount: 2 }),
    ]);
    feeds.confirmLanding(
      new Map([
        [1, 11],
        [2, 0],
      ]),
    );

    expect(feeds.currentFeed?.id).toBe(1);
    expect(feeds.currentEntry?.id).toBe(11);
  });

  it('確かめ直すのは一度きり（次の同期でカーソルを動かさない）', () => {
    const feeds = hydrated();
    feeds.confirmLanding(new Map([[1, 0]]));
    expect(feeds.currentEntry?.id).toBe(10);

    // 以降は暫定ではない。他の端末が読み終えても、読んでいる位置は動かさない
    feeds.confirmLanding(new Map([[1, 11]]));
    expect(feeds.currentEntry?.id).toBe(10);
  });

  it('u で未読に戻した記事に座っていたら、サーバが既読でも座り直さない', () => {
    // 座った時点で例外は外れる（表示したら既読）。外れた後の状態で判定すると、
    // 「後で読むために u を押した記事」が起動のたびに奪われる
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest([...entries(1, [10, 11]), ...entries(2, [20, 21])]);
    entriesStore.restoreForcedUnread([10]);
    feeds.setFeeds([
      feed(1, { rate: 5, readSeq: 11, unreadCount: 1 }),
      feed(2, { rate: 3, unreadCount: 2 }),
    ]);
    feeds.enterFirstUnread({ provisional: true });
    expect(feeds.currentEntry?.id).toBe(10);

    feeds.confirmLanding(
      new Map([
        [1, 11],
        [2, 0],
      ]),
    );

    expect(feeds.currentFeed?.id).toBe(1);
    expect(feeds.currentEntry?.id).toBe(10);
  });

  it('サーバの状態が取れなければ座り直さない（起動の取得に失敗した場合）', () => {
    // 後から届いた定期同期でカーソルが飛ぶ方が困る。暫定の印を外すだけにする
    const feeds = hydrated();
    feeds.confirmLanding(null);
    expect(feeds.currentEntry?.id).toBe(10);

    feeds.confirmLanding(new Map([[1, 11]]));
    expect(feeds.currentEntry?.id).toBe(10);
  });

  it('送信待ちの u が残っているフィードは、サーバが未読 0 と言っても読む対象に残る', () => {
    // サーバの未読数は entry_states を数えるが、まだ届いていない u は知らない。
    // 数え直す前のサーバの値で飛ばすと、戻した記事に辿り着けなくなる
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [10, 11]));
    entriesStore.restoreForcedUnread([10]);
    feeds.setFeeds([feed(1, { readSeq: 11, unreadCount: 0 })]);

    feeds.enterFirstUnread();
    expect(feeds.finished).toBe(false);
    expect(feeds.currentEntry?.id).toBe(10);
  });

  it('未読があるフィードでは、手元の既読記事を並べない', () => {
    // サーバは未読 1 件と言っているが、その記事はまだ届いていない。
    // ここで手元の既読記事に落ちると、開くたびに読み終えた記事が出てくる
    const feeds = useFeedsStore();
    const entriesStore = useEntriesStore();
    entriesStore.ingest(entries(1, [50, 60]));
    feeds.setFeeds([feed(1, { readSeq: 60, unreadCount: 1 })]);
    feeds.enterFirstUnread();

    expect(feeds.currentEntries).toEqual([]);

    // 背景取得で未読が届く。既読の 50 / 60 は混ざらない
    entriesStore.ingest(entries(1, [61]));
    feeds.absorbNewEntries();
    expect(feeds.currentEntries.map((e) => e.id)).toEqual([61]);
  });
});

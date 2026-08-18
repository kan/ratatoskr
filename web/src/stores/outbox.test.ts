import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, beaconRead, postRead, sendEntryUnread, updateFeed } from '@/lib/api';
import { deleteOutboxItems, loadOutbox, putOutboxItem } from '@/lib/db';
import { useOutboxStore } from './outbox';

/**
 * 送信キューのテスト。見るのは「巻き戻らないこと」「重複送信で壊れないこと」
 * 「繋がらない間も失われないこと」（CLAUDE.md のテスト方針）。
 *
 * IndexedDB も fetch も無い環境で回すので、境界はモックで塞ぐ。
 */

vi.mock('@/lib/db', () => ({
  loadOutbox: vi.fn(() => Promise.resolve([])),
  putOutboxItem: vi.fn(() => Promise.resolve()),
  deleteOutboxItems: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  // ApiError は本物を使う。恒久的な失敗の判定がステータスコードに依存している
  ...(await importOriginal<typeof import('@/lib/api')>()),
  postRead: vi.fn(() => Promise.resolve({ feeds: [] })),
  sendEntryUnread: vi.fn(() => Promise.resolve({ feeds: [] })),
  updateFeed: vi.fn(() => Promise.resolve({ feeds: [] })),
  beaconRead: vi.fn(() => true),
}));

/** FLUSH_DELAY / RETRY_BASE と揃えておく（stores/outbox.ts） */
const FLUSH_DELAY = 2_000;
const RETRY_BASE = 2_000;

function marksOfLastCall(): { feedId: number; watermark: number }[] {
  return vi.mocked(postRead).mock.lastCall?.[0] ?? [];
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('既読の送信', () => {
  it('連続した既読は 1 回にまとめて送る', async () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);
    outbox.queueRead(1, 11);
    outbox.queueRead(1, 12);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(postRead).toHaveBeenCalledTimes(1);
    expect(marksOfLastCall()).toEqual([{ feedId: 1, watermark: 12 }]);
    expect(outbox.pending).toBe(0);
  });

  it('後から古いウォーターマークが来てもキューは巻き戻らない', async () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 20);
    // 遅れて届いた古い値。ここで上書きすると既読が巻き戻る
    outbox.queueRead(1, 10);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(marksOfLastCall()).toEqual([{ feedId: 1, watermark: 20 }]);
  });

  it('複数フィードは 1 リクエストにまとめる', async () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);
    outbox.queueRead(2, 20);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(postRead).toHaveBeenCalledTimes(1);
    expect(marksOfLastCall()).toEqual([
      { feedId: 1, watermark: 10 },
      { feedId: 2, watermark: 20 },
    ]);
  });

  it('読み続けている間も送信が先送りされない', async () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);
    // 予約が入った後も読み進める。ここで予約が後ろにずれると永久に送られない
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY - 1);
    outbox.queueRead(1, 11);
    await vi.advanceTimersByTimeAsync(1);

    expect(postRead).toHaveBeenCalledTimes(1);
    expect(marksOfLastCall()).toEqual([{ feedId: 1, watermark: 11 }]);
  });

  it('積んだ時点で永続化する。タブを閉じても失われない', () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);
    expect(putOutboxItem).toHaveBeenCalledWith({
      key: 'read:1',
      kind: 'read',
      feedId: 1,
      watermark: 10,
    });
  });
});

describe('失敗時のふるまい', () => {
  it('失敗したらキューに残し、バックオフしてから再送する', async () => {
    vi.mocked(postRead).mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(postRead).toHaveBeenCalledTimes(1);
    // 送れていないので残す。ここで消すと既読が永久に他の端末へ伝わらない
    expect(outbox.pending).toBe(1);
    expect(deleteOutboxItems).not.toHaveBeenCalledWith(['read:1']);

    // バックオフの途中では叩かない
    await vi.advanceTimersByTimeAsync(RETRY_BASE - 1);
    expect(postRead).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(postRead).toHaveBeenCalledTimes(2);
    expect(outbox.pending).toBe(0);
  });

  it('送り直しても通らない失敗はキューから落とす', async () => {
    // 保持期間を過ぎて消えた記事への未読戻し。残すと後続の既読まで送れなくなる
    vi.mocked(sendEntryUnread).mockRejectedValueOnce(new ApiError('not_found', '無い', 404));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outbox = useOutboxStore();
    outbox.queueUnread(5, true);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(outbox.pending).toBe(0);
  });

  it('認証切れは一時的な失敗として再送する', async () => {
    vi.mocked(postRead).mockRejectedValueOnce(new ApiError('unauthorized', '期限切れ', 401));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(outbox.pending).toBe(1);
  });
});

describe('送信中の積み増し', () => {
  it('送信中に進んだ既読は、送り終えた分と一緒に消さずに次で送る', async () => {
    let release = (): void => undefined;
    vi.mocked(postRead).mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ feeds: [] }))),
    );

    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(postRead).toHaveBeenCalledTimes(1);

    // 応答を待っている間にさらに読み進めた
    outbox.queueRead(1, 20);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // 10 を送り終えても 20 は残っている
    expect(outbox.pending).toBe(1);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(marksOfLastCall()).toEqual([{ feedId: 1, watermark: 20 }]);
    expect(outbox.pending).toBe(0);
  });

  it('送信中に同じ吐き出しを重ねて呼んでも二重に送らない', async () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);

    await Promise.all([outbox.flush(), outbox.flush(), outbox.flush()]);
    expect(postRead).toHaveBeenCalledTimes(1);
  });
});

describe('未読に戻す', () => {
  it('記事ごとに送る', async () => {
    const outbox = useOutboxStore();
    outbox.queueUnread(5, true);
    outbox.queueUnread(7, true);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(sendEntryUnread).toHaveBeenCalledTimes(2);
    expect(sendEntryUnread).toHaveBeenCalledWith(5, true);
    expect(sendEntryUnread).toHaveBeenCalledWith(7, true);
  });

  it('同じ記事への操作は最後のものだけが残る', async () => {
    const outbox = useOutboxStore();
    outbox.queueUnread(5, true);
    // すぐに読み直した
    outbox.queueUnread(5, false);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(sendEntryUnread).toHaveBeenCalledTimes(1);
    expect(sendEntryUnread).toHaveBeenCalledWith(5, false);
  });
});

describe('離脱時', () => {
  it('未読戻しは sendBeacon に載らないので keepalive の fetch で投げる', () => {
    const outbox = useOutboxStore();
    outbox.queueUnread(5, true);
    outbox.flushOnUnload();

    // 送らないと、u を押した直後にタブを閉じた分が丸ごと失われる
    expect(sendEntryUnread).toHaveBeenCalledWith(5, true);
    expect(outbox.pending).toBe(1);
  });

  it('sendBeacon で既読を送り、応答が読めないのでキューには残す', () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);
    outbox.flushOnUnload();

    expect(beaconRead).toHaveBeenCalledWith([{ feedId: 1, watermark: 10 }]);
    // 届いたか分からない。次の起動で再送する（冪等なので二重でも害が無い）
    expect(outbox.pending).toBe(1);
  });
});

describe('起動時の読み戻し', () => {
  it('前回送り切れなかった分を引き継いで送る', async () => {
    vi.mocked(loadOutbox).mockResolvedValueOnce([
      { key: 'read:1', kind: 'read', feedId: 1, watermark: 10 },
    ]);
    const outbox = useOutboxStore();
    await outbox.hydrate();

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(marksOfLastCall()).toEqual([{ feedId: 1, watermark: 10 }]);
  });
});

describe('レート変更', () => {
  it('フィード単位でまとめ、最後の値だけを送る', async () => {
    const outbox = useOutboxStore();
    outbox.queueRate(1, 5);
    // 押し間違えてすぐ押し直した
    outbox.queueRate(1, 4);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(updateFeed).toHaveBeenCalledTimes(1);
    expect(updateFeed).toHaveBeenCalledWith(1, { rate: 4 });
    expect(outbox.pending).toBe(0);
  });

  it('既読とレートは同じ吐き出しで一緒に送る', async () => {
    const outbox = useOutboxStore();
    outbox.queueRead(1, 10);
    outbox.queueRate(1, 5);

    await vi.advanceTimersByTimeAsync(FLUSH_DELAY);
    expect(postRead).toHaveBeenCalledTimes(1);
    expect(updateFeed).toHaveBeenCalledWith(1, { rate: 5 });
    expect(outbox.pending).toBe(0);
  });

  it('離脱時も送る（sendBeacon には載らないので fetch で投げる）', () => {
    const outbox = useOutboxStore();
    outbox.queueRate(1, 2);
    outbox.flushOnUnload();

    expect(updateFeed).toHaveBeenCalledWith(1, { rate: 2 });
    expect(outbox.pending).toBe(1);
  });
});

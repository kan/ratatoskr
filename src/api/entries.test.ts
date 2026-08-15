import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { EntriesResponse } from '../../shared/types';
import { apiGet, apiJson } from '../test/request';
import { seedEntry, seedEntryState, seedFeed, setReadSeq } from '../test/seed';

describe('GET /api/entries', () => {
  it('id 昇順で返し、sinceId で続きを引ける', async () => {
    const feedId = await seedFeed(env.DB, 'https://e-page.example.com/feed');
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedEntry(env.DB, feedId));

    const first = await apiJson<EntriesResponse>('/api/entries?limit=2');
    expect(first.entries.map((entry) => entry.id)).toEqual(ids.slice(0, 2));
    expect(first.hasMore).toBe(true);
    expect(first.nextSinceId).toBe(ids[1]);

    const second = await apiJson<EntriesResponse>(`/api/entries?limit=2&sinceId=${ids[1]}`);
    expect(second.entries.map((entry) => entry.id)).toEqual(ids.slice(2, 4));

    const last = await apiJson<EntriesResponse>(`/api/entries?limit=2&sinceId=${ids[3]}`);
    expect(last.entries.map((entry) => entry.id)).toEqual([ids[4]]);
    expect(last.hasMore).toBe(false);
    expect(last.nextSinceId).toBeNull();
  });

  it('既定では未読だけを返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://e-unread.example.com/feed');
    const read = await seedEntry(env.DB, feedId);
    const unread = await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, read);

    const body = await apiJson<EntriesResponse>('/api/entries');
    expect(body.entries.map((entry) => entry.id)).toEqual([unread]);
  });

  it('unreadOnly=false なら既読も返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://e-all.example.com/feed');
    const read = await seedEntry(env.DB, feedId);
    const unread = await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, read);

    const body = await apiJson<EntriesResponse>('/api/entries?unreadOnly=false');
    expect(body.entries.map((entry) => entry.id)).toEqual([read, unread]);
  });

  it('手動で未読に戻した記事はウォーターマークの下でも未読として返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://e-state.example.com/feed');
    const older = await seedEntry(env.DB, feedId);
    const newer = await seedEntry(env.DB, feedId);
    await setReadSeq(env.DB, feedId, newer);
    await seedEntryState(env.DB, older, true);

    const body = await apiJson<EntriesResponse>('/api/entries');
    expect(body.entries.map((entry) => entry.id)).toEqual([older]);
  });

  it('feedId で絞り込める', async () => {
    const target = await seedFeed(env.DB, 'https://e-target.example.com/feed');
    const other = await seedFeed(env.DB, 'https://e-other.example.com/feed');
    const wanted = await seedEntry(env.DB, target);
    await seedEntry(env.DB, other);

    const body = await apiJson<EntriesResponse>(`/api/entries?feedId=${target}`);
    expect(body.entries.map((entry) => entry.id)).toEqual([wanted]);
  });

  it('記事の中身をそのまま返す', async () => {
    const feedId = await seedFeed(env.DB, 'https://e-shape.example.com/feed');
    const id = await seedEntry(env.DB, feedId, {
      title: 'タイトル',
      author: 'kan',
      body: '<p>サニタイズ済み</p>',
      publishedAt: 1785715200,
      storedAt: 1785800000,
      url: 'https://e-shape.example.com/1',
    });

    const body = await apiJson<EntriesResponse>('/api/entries');
    expect(body.entries[0]).toEqual({
      id,
      feedId,
      url: 'https://e-shape.example.com/1',
      title: 'タイトル',
      author: 'kan',
      body: '<p>サニタイズ済み</p>',
      publishedAt: 1785715200,
      storedAt: 1785800000,
    });
  });

  it('limit の上限を超えたら 400', async () => {
    const response = await apiGet('/api/entries?limit=1001');
    expect(response.status).toBe(400);
  });

  it('unreadOnly に真偽値以外を渡したら 400', async () => {
    const response = await apiGet('/api/entries?unreadOnly=maybe');
    expect(response.status).toBe(400);
  });
});

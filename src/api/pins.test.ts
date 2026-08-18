import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { BootstrapResponse, PinResponse } from '../../shared/types';
import { apiJson, apiSend } from '../test/request';
import { seedEntry, seedFeed } from '../test/seed';

/**
 * ピン。記事より長生きすることが要件なので、記事を消しても残ることを見る
 * （docs/DESIGN.md の pins テーブル）。
 */

async function pin(body: unknown): Promise<Response> {
  return apiSend('POST', '/api/pins', body);
}

async function pinsOf(): Promise<BootstrapResponse['pins']> {
  return (await apiJson<BootstrapResponse>('/api/bootstrap')).pins;
}

describe('POST /api/pins', () => {
  it('記事から独立した控えとして保存する', async () => {
    const feedId = await seedFeed(env.DB, 'https://pin.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);

    const response = await pin({
      entryId,
      title: '後で読む記事',
      url: 'https://pin.example.com/1',
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as PinResponse;
    expect(body.pin).toMatchObject({
      entryId,
      title: '後で読む記事',
      url: 'https://pin.example.com/1',
    });
    expect(await pinsOf()).toHaveLength(1);
  });

  it('同じ URL を二度ピンしても増えない', async () => {
    const params = { entryId: null, title: 'ピン', url: 'https://pin.example.com/same' };
    await pin(params);
    await pin(params);

    expect(await pinsOf()).toHaveLength(1);
  });

  it('記事が消えてもピンは残る', async () => {
    const feedId = await seedFeed(env.DB, 'https://gone.example.com/feed');
    const entryId = await seedEntry(env.DB, feedId);
    await pin({ entryId, title: '消える記事のピン', url: 'https://gone.example.com/1' });

    // 購読ごと消す（記事は CASCADE で消える）
    await apiSend('DELETE', `/api/feeds/${feedId}`);

    const pins = await pinsOf();
    expect(pins).toHaveLength(1);
    // 記事への参照だけが外れる。タイトルと URL は控えているので開ける
    expect(pins[0]).toMatchObject({
      entryId: null,
      title: '消える記事のピン',
      url: 'https://gone.example.com/1',
    });
  });

  it('既に消えた記事を指していても、参照だけ外して作る', async () => {
    // オフラインでピンした後に購読を解除した場合など。
    // 外部キー違反で 500 にすると、outbox が延々と再送することになる
    const response = await pin({
      entryId: 999999,
      title: '消えた記事のピン',
      url: 'https://example.com/vanished',
    });
    expect(response.status).toBe(201);
    expect((await response.json()) as PinResponse).toMatchObject({ pin: { entryId: null } });
  });

  it('記事に紐付かないピンも作れる', async () => {
    const response = await pin({ title: '手で足したピン', url: 'https://example.com/free' });
    expect(response.status).toBe(201);
    expect((await response.json()) as PinResponse).toMatchObject({ pin: { entryId: null } });
  });

  it('title と url を検証する', async () => {
    expect((await pin({ url: 'https://example.com/' })).status).toBe(400);
    expect((await pin({ title: '  ', url: 'https://example.com/' })).status).toBe(400);
    expect((await pin({ title: 'ピン' })).status).toBe(400);
    expect((await pin({ title: 'ピン', url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await pin({ title: 'ピン', url: 'https://example.com/', entryId: 0 })).status).toBe(
      400,
    );
  });
});

describe('DELETE /api/pins/:id', () => {
  it('ピンを消す', async () => {
    const created = (await (
      await pin({ title: '消すピン', url: 'https://example.com/delete' })
    ).json()) as PinResponse;

    const response = await apiSend('DELETE', `/api/pins/${created.pin.id}`);
    expect(response.status).toBe(200);
    expect(await pinsOf()).toHaveLength(0);
  });

  it('既に消えていても成功として扱う（再送で詰まらせない）', async () => {
    const response = await apiSend('DELETE', '/api/pins/999999');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: null });
  });
});

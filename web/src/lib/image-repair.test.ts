import { describe, expect, it } from 'vitest';
import { createImageRepairer } from './image-repair';
import { IMAGE_CACHE, PREFETCH_IMAGE_CACHE } from './sw-policy';

/** src の代入を数えるだけの img の代役。DOM は要らない */
function fakeImage(src: string): { img: HTMLImageElement; assigned: string[] } {
  const assigned: string[] = [];
  let current = src;
  const img = {
    get src() {
      return current;
    },
    set src(value: string) {
      assigned.push(value);
      current = value;
    },
  };
  return { img: img as HTMLImageElement, assigned };
}

/** 消された URL をキャッシュ名ごとに記録する Cache API の代役 */
function fakeCaches(): { open: (name: string) => Promise<Cache | null>; deleted: string[] } {
  const deleted: string[] = [];
  const open = (name: string): Promise<Cache | null> =>
    Promise.resolve({
      delete(request: RequestInfo | URL) {
        deleted.push(`${name} ${String(request)}`);
        return Promise.resolve(true);
      },
    } as unknown as Cache);
  return { open, deleted };
}

function recordingFetch(): { impl: typeof fetch; calls: [string, string | undefined][] } {
  const calls: [string, string | undefined][] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(input), init?.cache]);
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as typeof fetch;
  return { impl, calls };
}

const URL_A = 'https://img.example.com/a.jpg';

describe('createImageRepairer', () => {
  it('取り直してから両方の控えを落とし、読み直す', async () => {
    const { impl, calls } = recordingFetch();
    const { open, deleted } = fakeCaches();
    const { img, assigned } = fakeImage(URL_A);

    await createImageRepairer({ fetchImpl: impl, openCache: open }).repair(img);

    // cache: 'reload' でないと、読み直しが HTTP キャッシュの同じ応答から返ってくる
    expect(calls).toEqual([[URL_A, 'reload']]);
    // 先読みの控えだけ落としても、Service Worker 側の写しが残っていれば出続ける
    expect(deleted).toEqual([`${PREFETCH_IMAGE_CACHE} ${URL_A}`, `${IMAGE_CACHE} ${URL_A}`]);
    expect(assigned).toEqual([URL_A]);
  });

  it('取り直せなければ控えを消さない（オフライン用の写しを道連れにしない）', async () => {
    // 遮断されているだけなら控えの中身は無事なので、消す理由が無い
    const impl = (() => Promise.reject(new Error('遮断されている'))) as typeof fetch;
    const { open, deleted } = fakeCaches();
    const { img, assigned } = fakeImage(URL_A);

    await createImageRepairer({ fetchImpl: impl, openCache: open }).repair(img);

    expect(deleted).toEqual([]);
    // 取り直せていないので、読み直しても同じ結果にしかならない
    expect(assigned).toEqual([]);
  });

  it('同じ画像を 2 枚使っていても、取りに行くのは 1 回で両方読み直す', async () => {
    const { impl, calls } = recordingFetch();
    const { open } = fakeCaches();
    const repairer = createImageRepairer({ fetchImpl: impl, openCache: open });

    const first = fakeImage(URL_A);
    const second = fakeImage(URL_A);
    await repairer.repair(first.img);
    await repairer.repair(second.img);

    expect(calls).toHaveLength(1);
    expect(first.assigned).toEqual([URL_A]);
    expect(second.assigned).toEqual([URL_A]);
  });

  it('同じ img が二度読めなければ、以後その URL では読み直さない', async () => {
    // 取り直しても直らない画像（遮断など）で、開き直すたびに要求を捨てないため
    const { impl, calls } = recordingFetch();
    const { open } = fakeCaches();
    const repairer = createImageRepairer({ fetchImpl: impl, openCache: open });

    const broken = fakeImage(URL_A);
    await repairer.repair(broken.img); // 1 回目: 取り直して読み直す
    await repairer.repair(broken.img); // 読み直しても駄目だった

    const later = fakeImage(URL_A);
    await repairer.repair(later.img); // 別の記事で同じ画像に出会う

    expect(calls).toHaveLength(1);
    expect(broken.assigned).toEqual([URL_A]);
    expect(later.assigned).toEqual([]);
  });

  it('控えの対象でない src は触らない', async () => {
    const { impl, calls } = recordingFetch();
    const { open, deleted } = fakeCaches();
    const { img, assigned } = fakeImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=');

    await createImageRepairer({ fetchImpl: impl, openCache: open }).repair(img);

    expect(calls).toEqual([]);
    expect(deleted).toEqual([]);
    expect(assigned).toEqual([]);
  });

  it('Cache API が使えなくても HTTP キャッシュを入れ替えて読み直す', async () => {
    const { impl, calls } = recordingFetch();
    const { img, assigned } = fakeImage(URL_A);

    await createImageRepairer({
      fetchImpl: impl,
      openCache: () => Promise.resolve(null),
    }).repair(img);

    expect(calls).toEqual([[URL_A, 'reload']]);
    expect(assigned).toEqual([URL_A]);
  });
});

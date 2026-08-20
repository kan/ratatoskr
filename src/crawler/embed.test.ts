import { describe, expect, it } from 'vitest';
import { mayHaveTweetEmbed, resolveTweetEmbeds } from './embed';
import type { FetchBudget } from './fetch';
import { sanitizeHtml } from './sanitize';

/**
 * 埋め込みの扱い（M7）。
 *
 * X のポストは、サイトが置くのが空のリンクだけで本文が HTML に入っていない
 * （テクノエッジの実装を確認した）。そのままではスクリプトを通さないこちらでは
 * 何も出ないので、取り込み時に oEmbed から本文を引いて埋める。
 */

/** テクノエッジが実際に置いているマークアップ。サニタイズ後はリンクだけが残る */
const EMPTY_EMBED =
  '<p>本文</p>' +
  '<blockquote class="twitter-tweet" data-conversation="none">' +
  '<a href="https://twitter.com/TechnoEdgeJP/status/2087892061412622819"></a>' +
  '</blockquote>' +
  '<script async src="https://platform.twitter.com/widgets.js"></script>';

/** oEmbed が返す形。本文・投稿者・日時が入っている */
function oembedPayload(text: string): string {
  return JSON.stringify({
    html:
      '<blockquote class="twitter-tweet" data-dnt="true">' +
      `<p lang="ja" dir="ltr">${text}</p>&mdash; テクノエッジ (@TechnoEdgeJP) ` +
      '<a href="https://x.com/TechnoEdgeJP/status/2087892061412622819?ref_src=twsrc%5Etfw">August 13, 2026</a>' +
      '</blockquote>',
    author_name: 'テクノエッジ',
  });
}

function stubFetch(respond: (url: string) => Response): {
  impl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    return Promise.resolve(respond(String(input)));
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function jsonResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

const TWEET_TEXT = '360度カメラで店内を空間キャプチャしてみました';

describe('mayHaveTweetEmbed', () => {
  it('埋め込みを含まない本文は走査しない', () => {
    expect(mayHaveTweetEmbed('<p>ただの本文</p>')).toBe(false);
    // 引用はあるがポストではない
    expect(mayHaveTweetEmbed('<blockquote><p>引用</p></blockquote>')).toBe(false);
  });

  it('ポストの引用がありそうなら走査する', () => {
    expect(mayHaveTweetEmbed(EMPTY_EMBED)).toBe(true);
  });
});

describe('resolveTweetEmbeds', () => {
  async function sanitized(): Promise<string> {
    return await sanitizeHtml(EMPTY_EMBED, 'https://www.techno-edge.net/');
  }

  it('サニタイズだけでは空の引用が残る（この関数が要る理由）', async () => {
    const body = await sanitized();

    expect(body).not.toContain('widgets.js');
    // リンクはあるが表示される文字が無い
    expect(body).toContain('/status/2087892061412622819');
    expect(body).not.toContain(TWEET_TEXT);
  });

  it('oEmbed から本文・投稿者・日時を引いて埋める', async () => {
    const stub = stubFetch(() => jsonResponse(oembedPayload(TWEET_TEXT)));
    const budget: FetchBudget = { remaining: 10 };

    const body = await resolveTweetEmbeds(await sanitized(), {
      fetchImpl: stub.impl,
      budget,
    });

    expect(body).toContain(TWEET_TEXT);
    expect(body).toContain('@TechnoEdgeJP');
    expect(body).toContain('August 13, 2026');
    // 記事の本文は残る
    expect(body).toContain('<p>本文</p>');
    expect(budget.remaining).toBe(9);
  });

  it('oEmbed には対象のポストの URL を渡す', async () => {
    const stub = stubFetch(() => jsonResponse(oembedPayload(TWEET_TEXT)));
    await resolveTweetEmbeds(await sanitized(), {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    expect(stub.calls[0]).toContain('publish.x.com/oembed');
    expect(stub.calls[0]).toContain(encodeURIComponent('/status/2087892061412622819'));
    // 行動記録に使わせない・スクリプトを返させない
    expect(stub.calls[0]).toContain('dnt=1');
    expect(stub.calls[0]).toContain('omit_script=1');
  });

  it('取り込んだ本文もサニタイズを通す', async () => {
    const evil = JSON.stringify({
      html:
        '<blockquote class="twitter-tweet"><p>危ない<script>alert(1)</script></p>' +
        '<a href="javascript:alert(2)">link</a></blockquote>',
    });
    const stub = stubFetch(() => jsonResponse(evil));

    const body = await resolveTweetEmbeds(await sanitized(), {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    expect(body).toContain('危ない');
    expect(body).not.toContain('alert');
    expect(body).not.toContain('javascript:');
  });

  it('ポストの中の 1 枚を指す URL でも引ける', async () => {
    // 記事には .../status/<id>/video/1 や ?s=20 の形で貼られる。
    // そのままでは oEmbed が受け付けないので、投稿者と id だけに削って渡す
    const withSuffix = await sanitizeHtml(
      '<blockquote class="twitter-tweet">' +
        '<a href="https://twitter.com/TechnoEdgeJP/status/2087892061412622819/video/1"></a>' +
        '</blockquote>',
      'https://www.techno-edge.net/',
    );
    const stub = stubFetch(() => jsonResponse(oembedPayload(TWEET_TEXT)));

    const body = await resolveTweetEmbeds(withSuffix, {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    expect(stub.calls[0]).toContain(
      encodeURIComponent('https://x.com/TechnoEdgeJP/status/2087892061412622819'),
    );
    expect(stub.calls[0]).not.toContain(encodeURIComponent('/video/1'));
    expect(body).toContain(TWEET_TEXT);
  });

  it('引けなければリンクに落とす（空のままにしない）', async () => {
    const stub = stubFetch(() => new Response('not found', { status: 404 }));

    const body = await resolveTweetEmbeds(await sanitized(), {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    expect(body).toContain('X のポストを開く');
    expect(body).toContain('/status/2087892061412622819');
  });

  it('予算が尽きていれば取りに行かず、リンクに落とす', async () => {
    const stub = stubFetch(() => jsonResponse(oembedPayload(TWEET_TEXT)));
    const budget: FetchBudget = { remaining: 0 };

    const body = await resolveTweetEmbeds(await sanitized(), { fetchImpl: stub.impl, budget });

    expect(stub.calls).toEqual([]);
    expect(body).toContain('X のポストを開く');
  });

  it('本文がすでに入っている引用は触らない', async () => {
    // 痛いニュースの形。引用の中にポスト本文がそのまま入っている
    const withText = await sanitizeHtml(
      '<blockquote><p>すでに読める本文 ' +
        '<a href="https://t.co/abc">https://t.co/abc</a></p>&mdash; 名前 (@handle) ' +
        '<a href="https://x.com/handle/status/123">August 17, 2026</a></blockquote>',
      'https://example.com/',
    );
    const stub = stubFetch(() => jsonResponse(oembedPayload('引き直した本文')));

    const body = await resolveTweetEmbeds(withText, {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    // 引き直すと同じポストが二重になる
    expect(stub.calls).toEqual([]);
    expect(body).toContain('すでに読める本文');
    expect(body).not.toContain('引き直した本文');
  });

  it('埋め込みが無ければ何もしない', async () => {
    const stub = stubFetch(() => jsonResponse(oembedPayload(TWEET_TEXT)));
    const plain = '<p>ただの本文</p>';

    expect(
      await resolveTweetEmbeds(plain, { fetchImpl: stub.impl, budget: { remaining: 10 } }),
    ).toBe(plain);
    expect(stub.calls).toEqual([]);
  });
});

/**
 * iframe の埋め込み。中身は通さないが、跡形もなく消すと記事の意味が通らなくなる。
 * 提供元が分かるものに限ってリンクに差し替える（src/crawler/sanitize.ts）。
 */
describe('iframe の埋め込み', () => {
  it('YouTube は視聴ページへのリンクにする', async () => {
    const body = await sanitizeHtml(
      '<p>本文</p><iframe src="https://www.youtube.com/embed/_hPRy48kSWg?rel=0" width="640"></iframe>',
      'https://example.com/',
    );

    expect(body).toContain('https://www.youtube.com/watch?v=_hPRy48kSWg');
    expect(body).toContain('YouTube の動画を開く');
    expect(body).not.toContain('<iframe');
  });

  it('知らない提供元の iframe は落とす', async () => {
    // 計測用の隠し iframe までリンクにしない
    const body = await sanitizeHtml(
      '<p>本文</p><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X" height="0"></iframe>',
      'https://example.com/',
    );

    expect(body).toBe('<p>本文</p>');
  });

  it('src の無い iframe は落とす', async () => {
    expect(await sanitizeHtml('<p>本文</p><iframe></iframe>', 'https://example.com/')).toBe(
      '<p>本文</p>',
    );
  });

  it('iframe の中身は持ち込まない', async () => {
    const body = await sanitizeHtml(
      '<iframe src="https://www.youtube.com/embed/abcdef"><p>代替テキスト</p></iframe>',
      'https://example.com/',
    );

    expect(body).not.toContain('代替テキスト');
  });
});

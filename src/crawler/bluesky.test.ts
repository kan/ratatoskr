import { describe, expect, it } from 'vitest';
import { blueskyPostRef, fetchBlueskyPosts } from './bluesky';
import type { FetchBudget } from './fetch';

/**
 * Bluesky の投稿を API から組み立てる。
 *
 * 形は実際の public.api.bsky.app の応答から採ったが、公開リポジトリに他人の投稿を
 * 置かないよう、フィクスチャは同じ形の作り物にしてある。
 */

const DID = 'did:plc:example';

function postUrl(rkey: string, actor = 'someone.example.com'): string {
  return `https://bsky.app/profile/${actor}/post/${rkey}`;
}

function post(rkey: string, record: Record<string, unknown>, embed?: unknown): unknown {
  return {
    uri: `at://${DID}/app.bsky.feed.post/${rkey}`,
    author: { did: DID, handle: 'someone.example.com', displayName: '名前' },
    record: { $type: 'app.bsky.feed.post', createdAt: '2026-08-29T07:24:49.617Z', ...record },
    ...(embed === undefined ? {} : { embed }),
  };
}

interface Stub {
  impl: typeof fetch;
  calls: string[];
}

/**
 * rkey → 返す投稿。渡さなかった rkey は「取れなかった」扱いになる。
 * `threads` は at-uri → getPostThread の `thread`。無い uri は 502 を返す
 */
function stubApi(posts: unknown[], threads: Record<string, unknown> = {}): Stub {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.includes('resolveHandle')) {
      return new Response(JSON.stringify({ did: DID }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('getPostThread')) {
      const thread = threads[new URL(url).searchParams.get('uri') ?? ''];
      if (thread === undefined) return new Response('nope', { status: 502 });
      return new Response(JSON.stringify({ thread }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    // getPosts は要求された uri のうち、手元にあるものだけを返す
    const wanted = new Set([...new URL(url).searchParams.getAll('uris')]);
    return new Response(
      JSON.stringify({ posts: posts.filter((p) => wanted.has((p as { uri: string }).uri)) }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

/** 記事 URL から ref を作って渡す。fillFullText が実際にやっている手順に揃える */
function refsOf(urls: string[]) {
  return urls.map((url) => {
    const ref = blueskyPostRef(url);
    if (ref === null) throw new Error(`Bluesky の投稿 URL ではない: ${url}`);
    return ref;
  });
}

async function render(posts: unknown[], urls: string[], budget = 10): Promise<string[]> {
  const stub = stubApi(posts);
  const { bodies } = await fetchBlueskyPosts(refsOf(urls), {
    fetchImpl: stub.impl,
    budget: { remaining: budget },
  });
  return [...bodies.values()];
}

describe('blueskyPostRef', () => {
  it('投稿の URL から投稿者と rkey を取り出す', () => {
    expect(blueskyPostRef('https://bsky.app/profile/a.example.com/post/3mu7')).toEqual({
      actor: 'a.example.com',
      rkey: '3mu7',
    });
  });

  it('投稿者が DID でも取り出せる', () => {
    // RSS は /profile/<handle>/rss でも /profile/<did>/rss でも配られる
    expect(blueskyPostRef(`https://bsky.app/profile/${DID}/post/3mu7`)?.actor).toBe(DID);
  });

  it('投稿を指さない URL は対象にしない', () => {
    expect(blueskyPostRef('https://bsky.app/profile/a.example.com')).toBeNull();
    expect(blueskyPostRef('https://bsky.app/profile/a.example.com/rss')).toBeNull();
    expect(blueskyPostRef('https://example.com/profile/a/post/3mu7')).toBeNull();
    expect(blueskyPostRef('not a url')).toBeNull();
  });
});

describe('fetchBlueskyBodies', () => {
  it('本文の改行を br にする', async () => {
    // RSS の description は平文なので、改行が HTML では潰れる。
    // 行の並ぶ投稿（体重ログなど）が 1 行に繋がってしまう
    const [html] = await render([post('a', { text: '1 行目\n2 行目' })], [postUrl('a')]);

    expect(html).toBe('<p>1 行目<br>2 行目</p>');
  });

  it('facet のバイト位置でリンクにする', async () => {
    // **facet の位置は UTF-8 のバイト数。** UTF-16 の文字数で切ると日本語で必ずずれる
    const text = 'あいう example.com/x えお';
    const bytes = new TextEncoder().encode(text);
    const start = bytes.indexOf('e'.charCodeAt(0));
    const [html] = await render(
      [
        post('a', {
          text,
          facets: [
            {
              index: { byteStart: start, byteEnd: start + 'example.com/x'.length },
              features: [
                { $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/x?a=1' },
              ],
            },
          ],
        }),
      ],
      [postUrl('a')],
    );

    expect(html).toContain('>あいう <a href="https://example.com/x?a=1"');
    expect(html).toContain('>example.com/x</a> えお</p>');
  });

  it('範囲の壊れた facet は捨てて本文を残す', async () => {
    const [html] = await render(
      [
        post('a', {
          text: 'あいうえお',
          facets: [
            {
              index: { byteStart: 3, byteEnd: 9999 },
              features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/' }],
            },
          ],
        }),
      ],
      [postUrl('a')],
    );

    expect(html).toBe('<p>あいうえお</p>');
  });

  it('画像を img にして alt を添える', async () => {
    // 画像が本文に入って初めて先読みが効く（docs/DESIGN.md）
    const [html] = await render(
      [
        post(
          'a',
          { text: '飯' },
          {
            $type: 'app.bsky.embed.images#view',
            images: [
              { fullsize: 'https://cdn.example.com/1.jpg', alt: 'うどん', thumb: 'x' },
              { fullsize: 'https://cdn.example.com/2.jpg', alt: '' },
            ],
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).toContain('<img src="https://cdn.example.com/1.jpg" alt="うどん">');
    expect(html).toContain('<figcaption>うどん</figcaption>');
    // alt が無い画像に空の figcaption を付けない
    expect(html).toContain('<img src="https://cdn.example.com/2.jpg" alt="">');
    expect(html).not.toContain('<figcaption></figcaption>');
  });

  it('外部リンクのカードを見出しと画像にする', async () => {
    const [html] = await render(
      [
        post(
          'a',
          { text: 'これ' },
          {
            $type: 'app.bsky.embed.external#view',
            external: {
              uri: 'https://example.com/article',
              title: '記事の題',
              description: '説明',
              thumb: 'https://cdn.example.com/t.jpg',
            },
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).toContain('<img src="https://cdn.example.com/t.jpg" alt="">');
    expect(html).toContain('>記事の題</a>');
    expect(html).toContain('説明');
  });

  it('画像の無いカードは figure にしない', async () => {
    // 絵の無い figure は figcaption だけが残って据わりが悪い
    const [html] = await render(
      [
        post(
          'a',
          { text: 'これ' },
          {
            $type: 'app.bsky.embed.external#view',
            external: { uri: 'https://example.com/x', title: '題', description: '' },
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).toBe(
      '<p>これ</p><p><a href="https://example.com/x" target="_blank" rel="noopener noreferrer">題</a></p>',
    );
  });

  it('引用された投稿を blockquote にする', async () => {
    const [html] = await render(
      [
        post(
          'a',
          { text: '同意' },
          {
            $type: 'app.bsky.embed.record#view',
            record: {
              $type: 'app.bsky.embed.record#viewRecord',
              uri: 'at://did:plc:other/app.bsky.feed.post/3zzz',
              author: { did: 'did:plc:other', handle: 'other.example.com', displayName: '別人' },
              value: { text: '元の投稿' },
              embeds: [],
            },
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).toContain('<blockquote>');
    expect(html).toContain('https://bsky.app/profile/other.example.com/post/3zzz');
    expect(html).toContain('別人 (@other.example.com)');
    expect(html).toContain('元の投稿');
  });

  it('消された引用は blockquote にしない', async () => {
    // 消された・非公開・引用を外された投稿は viewRecord ではない形で来る
    const [html] = await render(
      [
        post(
          'a',
          { text: '同意' },
          {
            $type: 'app.bsky.embed.record#view',
            record: { $type: 'app.bsky.embed.record#viewNotFound', notFound: true },
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).toBe('<p>同意</p>');
  });

  it('引用の引用までは辿らない', async () => {
    const [html] = await render(
      [
        post(
          'a',
          { text: 'ここ' },
          {
            $type: 'app.bsky.embed.record#view',
            record: {
              $type: 'app.bsky.embed.record#viewRecord',
              uri: 'at://did:plc:other/app.bsky.feed.post/3zzz',
              author: { did: 'did:plc:other', handle: 'other.example.com', displayName: '別人' },
              value: { text: '一段目' },
              embeds: [
                {
                  $type: 'app.bsky.embed.record#view',
                  record: {
                    $type: 'app.bsky.embed.record#viewRecord',
                    uri: 'at://did:plc:third/app.bsky.feed.post/3yyy',
                    author: { did: 'did:plc:third', handle: 'third.example.com' },
                    value: { text: '二段目' },
                    embeds: [],
                  },
                },
                {
                  $type: 'app.bsky.embed.images#view',
                  images: [{ fullsize: 'https://cdn.example.com/q.jpg', alt: '' }],
                },
              ],
            },
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).toContain('一段目');
    // 引用元に付いていた画像は出すが、引用の引用は出さない
    expect(html).toContain('https://cdn.example.com/q.jpg');
    expect(html).not.toContain('二段目');
  });

  it('画像と引用が両方ある投稿は、両方出す', async () => {
    const [html] = await render(
      [
        post(
          'a',
          { text: '両方' },
          {
            $type: 'app.bsky.embed.recordWithMedia#view',
            media: {
              $type: 'app.bsky.embed.images#view',
              images: [{ fullsize: 'https://cdn.example.com/m.jpg', alt: '' }],
            },
            record: {
              $type: 'app.bsky.embed.record#view',
              record: {
                $type: 'app.bsky.embed.record#viewRecord',
                uri: 'at://did:plc:other/app.bsky.feed.post/3zzz',
                author: { did: 'did:plc:other', handle: 'other.example.com', displayName: '別人' },
                value: { text: '引用元' },
                embeds: [],
              },
            },
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).toContain('https://cdn.example.com/m.jpg');
    expect(html).toContain('引用元');
  });

  it('投稿の文字をマークアップとして通さない', async () => {
    // 組み立てるのはこちらでも、中身は外から来た文字列（不変条件 4）
    const [html] = await render(
      [post('a', { text: '<script>alert(1)</script> & <b>' })],
      [postUrl('a')],
    );

    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;</p>');
  });

  it('10 件の投稿を 2 回の要求で取る', async () => {
    // 記事ページを 1 枚ずつ引くのに比べて、相手のサーバへの負担が桁で減る。
    // ハンドルを DID に直すのに 1 回、投稿をまとめて取るのに 1 回
    const rkeys = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const stub = stubApi(rkeys.map((rkey) => post(rkey, { text: rkey })));
    const budget: FetchBudget = { remaining: 20 };

    const { bodies } = await fetchBlueskyPosts(refsOf(rkeys.map((rkey) => postUrl(rkey))), {
      fetchImpl: stub.impl,
      budget,
    });

    expect(bodies.size).toBe(10);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0]).toContain('resolveHandle');
    // 使わなかった枠は返す
    expect(budget.remaining).toBe(18);
  });

  it('投稿者が DID なら、名前を引き直さない', async () => {
    const stub = stubApi([post('a', { text: 'x' })]);

    await fetchBlueskyPosts(refsOf([postUrl('a', DID)]), {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain('getPosts');
  });

  it('応答に入っていない投稿は「確かに無い」として返す', async () => {
    // 消された・非公開の投稿。呼び出し側が「取りに行ったが採らなかった」印を付ける
    const stub = stubApi([post('a', { text: 'ある' })]);

    const result = await fetchBlueskyPosts(refsOf([postUrl('a'), postUrl('b')]), {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    expect(result.bodies.size).toBe(1);
    expect([...result.missing]).toEqual(['b']);
  });

  it('投稿の取得が通らなかったときは、印を付けさせない', async () => {
    // **一時的な失敗と「確かに無い」を混ぜない。** 印は selectMissingFullText から
    // 永久に外す働きがあるので、API が落ちている回に付けると購読を入れ直すまで戻らない。
    // 投稿者が DID なので名前解決は挟まらず、getPosts が直接 502 になる
    const impl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;

    const result = await fetchBlueskyPosts(refsOf([postUrl('a', DID)]), {
      fetchImpl: impl,
      budget: { remaining: 10 },
    });

    expect(result.bodies.size).toBe(0);
    expect(result.missing.size).toBe(0);
  });

  it('名前が引けなかったときも、印を付けさせない', async () => {
    const impl = (async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes('resolveHandle')) return new Response('nope', { status: 502 });
      throw new Error('名前が引けていないのに投稿を取りに行った');
    }) as unknown as typeof fetch;

    const result = await fetchBlueskyPosts(refsOf([postUrl('a')]), {
      fetchImpl: impl,
      budget: { remaining: 10 },
    });

    expect(result.bodies.size).toBe(0);
    expect(result.missing.size).toBe(0);
  });

  it('文字の途中を指す facet は捨てる', async () => {
    // 切ると断片が U+FFFD になって本文に残る
    const [html] = await render(
      [
        post('a', {
          text: 'あいう',
          facets: [
            {
              index: { byteStart: 1, byteEnd: 3 },
              features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/' }],
            },
          ],
        }),
      ],
      [postUrl('a')],
    );

    expect(html).toBe('<p>あいう</p>');
  });

  it('中身の無い投稿は空にして、RSS の本文を残す', async () => {
    // 読み出しは COALESCE(NULLIF(full_body, ''), body) なので、空の <p></p> を
    // 保存すると「空でない全文」として RSS の本文を押しのけ、記事が真っ白になる
    const bodies = await render(
      [
        post(
          'a',
          { text: '' },
          {
            $type: 'app.bsky.embed.record#view',
            record: { $type: 'app.bsky.embed.record#viewBlocked', blocked: true },
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(bodies).toEqual([]);
  });

  it('テキストの無い画像だけの投稿に、空の段落を付けない', async () => {
    const [html] = await render(
      [
        post(
          'a',
          { text: '' },
          {
            $type: 'app.bsky.embed.images#view',
            images: [{ fullsize: 'https://cdn.example.com/1.jpg', alt: '' }],
          },
        ),
      ],
      [postUrl('a')],
    );

    expect(html).not.toContain('<p></p>');
    expect(html).toContain('<img src="https://cdn.example.com/1.jpg" alt="">');
  });

  describe('本人の返信（issue #32）', () => {
    const OTHER = 'did:plc:other';

    function uriOf(rkey: string): string {
      return `at://${DID}/app.bsky.feed.post/${rkey}`;
    }

    /** getPostThread の 1 段。`by` で投稿者を差し替える */
    function node(
      rkey: string,
      text: string,
      replies: unknown[] = [],
      options: { by?: string; createdAt?: string; embed?: unknown } = {},
    ): unknown {
      const base = post(
        rkey,
        { text, createdAt: options.createdAt ?? '2026-08-29T07:24:49.617Z' },
        options.embed,
      ) as Record<string, unknown>;
      const author = { ...(base.author as object), did: options.by ?? DID };
      return {
        $type: 'app.bsky.feed.defs#threadViewPost',
        post: { ...base, author },
        replies,
      };
    }

    function withReplies(rkey: string, text: string): unknown {
      return { ...(post(rkey, { text }) as object), replyCount: 1 };
    }

    async function fetchWith(
      threads: Record<string, unknown>,
      root = withReplies('a', '紹介'),
      budget: FetchBudget = { remaining: 10 },
    ) {
      const stub = stubApi([root], threads);
      const result = await fetchBlueskyPosts(refsOf([postUrl('a', DID)]), {
        fetchImpl: stub.impl,
        budget,
      });
      return { ...result, stub, budget };
    }

    it('本人の返信を「続きの投稿」として末尾に足す。リンクカードも同じ形で出す', async () => {
      const card = {
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'https://example.com/item', title: '紹介先', description: '' },
      };
      const { bodies } = await fetchWith({
        [uriOf('a')]: node('a', '紹介', [node('b', 'リンクはこちら', [], { embed: card })]),
      });

      expect(bodies.get('a')).toBe(
        '<p>紹介</p><hr><p><small>続きの投稿</small></p>' +
          '<p>リンクはこちら</p>' +
          '<p><a href="https://example.com/item" target="_blank" rel="noopener noreferrer">紹介先</a></p>',
      );
    });

    it('他人の返信と、その下にある本人の返信は採らない', async () => {
      const { bodies } = await fetchWith({
        [uriOf('a')]: node('a', '紹介', [
          node('x', '他人の返信', [node('y', '本人の受け答え')], { by: OTHER }),
          node('b', '本人の続き'),
        ]),
      });

      const html = bodies.get('a') ?? '';
      expect(html).toContain('本人の続き');
      expect(html).not.toContain('他人の返信');
      expect(html).not.toContain('本人の受け答え');
    });

    it('本人の返信は 5 段まで辿り、同じ段は古い順に並べる', async () => {
      let chain: unknown = node('r6', '6 段目');
      for (let depth = 5; depth >= 1; depth -= 1)
        chain = node(`r${depth}`, `${depth} 段目`, [chain]);
      const later = node('late', '後から足した返信', [], { createdAt: '2026-08-30T00:00:00.000Z' });

      const { bodies, stub } = await fetchWith({
        [uriOf('a')]: node('a', '紹介', [later, chain]),
      });

      const html = bodies.get('a') ?? '';
      expect(html).toContain('5 段目');
      expect(html).not.toContain('6 段目');
      expect(html.indexOf('5 段目')).toBeLessThan(html.indexOf('後から足した返信'));
      // 段数は 1 回の要求で取れる深さに収める
      expect(stub.calls.filter((call) => call.includes('getPostThread'))).toHaveLength(1);
      expect(stub.calls.find((call) => call.includes('getPostThread'))).toContain('depth=5');
    });

    it('返信の無い投稿はスレッドを引かない', async () => {
      const { stub } = await fetchWith({}, post('a', { text: '単発' }));

      expect(stub.calls.some((call) => call.includes('getPostThread'))).toBe(false);
    });

    it('スレッドを引く枠が無ければ、今回は埋めずに次の機会に回す', async () => {
      // getPosts の 1 回で枠が尽きる。返信抜きで埋めると、全文は 1 回しか取りに
      // 行かないので紹介先の URL が永久に出てこない
      const { bodies, missing, stub } = await fetchWith(
        { [uriOf('a')]: node('a', '紹介', [node('b', '続き')]) },
        withReplies('a', '紹介'),
        { remaining: 1 },
      );

      expect(bodies.size).toBe(0);
      expect(missing.size).toBe(0);
      expect(stub.calls.some((call) => call.includes('getPostThread'))).toBe(false);
    });

    it('スレッドの要求が通らなければ、印を付けずに次の機会に回す', async () => {
      const { bodies, missing, budget } = await fetchWith({});

      expect(bodies.size).toBe(0);
      expect(missing.size).toBe(0);
      // 取りに行って失敗した分は返さない（fetch.ts の releaseBudget）
      expect(budget.remaining).toBe(8);
    });

    it('スレッドの要求が 4xx で断られたら、返信抜きで埋める（毎回取り直さない）', async () => {
      const stub = stubApi([withReplies('a', '紹介')]);
      const impl = (async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).includes('getPostThread')) {
          return new Response('{"error":"NotFound"}', { status: 400 });
        }
        return stub.impl(input);
      }) as unknown as typeof fetch;

      const { bodies } = await fetchBlueskyPosts(refsOf([postUrl('a', DID)]), {
        fetchImpl: impl,
        budget: { remaining: 10 },
      });

      expect(bodies.get('a')).toBe('<p>紹介</p>');
    });

    it('同じ段の返信は、時差の書き方が違っても時刻の順に並べる', async () => {
      // 16:00+09:00 は 07:00Z。文字列で比べると 08:00Z より後に来てしまう
      const { bodies } = await fetchWith({
        [uriOf('a')]: node('a', '紹介', [
          node('b', '後', [], { createdAt: '2026-08-29T08:00:00Z' }),
          node('c', '先', [], { createdAt: '2026-08-29T16:00:00+09:00' }),
        ]),
      });

      const html = bodies.get('a') ?? '';
      expect(html.indexOf('先')).toBeLessThan(html.indexOf('後'));
    });

    it('元の投稿が空なら、区切りと見出しを付けずに返信だけを出す', async () => {
      const { bodies } = await fetchWith(
        { [uriOf('a')]: node('a', '', [node('b', '本人の続き')]) },
        { ...(post('a', { text: '' }) as object), replyCount: 1 },
      );

      expect(bodies.get('a')).toBe('<p>本人の続き</p>');
    });

    it('スレッドが辿れない投稿（消された・ブロック）は、返信抜きで埋める', async () => {
      const { bodies } = await fetchWith({
        [uriOf('a')]: { $type: 'app.bsky.feed.defs#notFoundPost', uri: uriOf('a'), notFound: true },
      });

      expect(bodies.get('a')).toBe('<p>紹介</p>');
    });
  });

  it('予算が無ければ取りに行かない', async () => {
    const stub = stubApi([post('a', { text: 'x' })]);

    const { bodies } = await fetchBlueskyPosts(refsOf([postUrl('a')]), {
      fetchImpl: stub.impl,
      budget: { remaining: 0 },
    });

    expect(bodies.size).toBe(0);
    expect(stub.calls).toEqual([]);
  });
});

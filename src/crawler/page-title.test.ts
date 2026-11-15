import { describe, expect, it } from 'vitest';
import { bytesOf, EUCJP_NIHONGO, SJIS_NIHONGO } from '../test/bytes';
import { fetchPageTitle, looksLikeUrl, titleFromHtml } from './page-title';

function stub(body: BodyInit, init: ResponseInit = {}): typeof fetch {
  return () =>
    Promise.resolve(new Response(body, { headers: { 'content-type': 'text/html' }, ...init }));
}

describe('looksLikeUrl', () => {
  const url = 'https://example.com/articles/2026/11/foo';

  it('URL そのものは対象', () => {
    expect(looksLikeUrl(url, url)).toBe(true);
    expect(looksLikeUrl('https://other.example.net/', url)).toBe(true);
  });

  it('Bluesky が切り詰めた URL は対象', () => {
    expect(looksLikeUrl('example.com/articles/20...', url)).toBe(true);
    expect(looksLikeUrl('example.com/articles/20…', url)).toBe(true);
    expect(looksLikeUrl('example.com', url)).toBe(true);
  });

  it('パスの日本語は、生の文字でもエンコード済みでも一致する', () => {
    const encoded = 'https://ja.example.org/wiki/%E6%97%A5%E6%9C%AC';
    expect(looksLikeUrl('ja.example.org/wiki/日本', encoded)).toBe(true);
  });

  it('言葉のリンク文字と空は対象外', () => {
    expect(looksLikeUrl('詳しくはこちら', url)).toBe(false);
    expect(looksLikeUrl('example.com の記事', url)).toBe(false);
    expect(looksLikeUrl('', url)).toBe(false);
    expect(looksLikeUrl('...', url)).toBe(false);
    // ホスト名の頭と重なるだけの言葉
    expect(looksLikeUrl('example', url)).toBe(false);
    expect(looksLikeUrl('e', url)).toBe(false);
  });
});

describe('titleFromHtml', () => {
  it('og:title を <title> より優先する', async () => {
    const html =
      '<html><head><title>記事 | サイト</title>' +
      '<meta property="og:title" content="記事"></head></html>';
    expect(await titleFromHtml(html)).toBe('記事');
  });

  it('og:title が無ければ <title>。空白を畳み、実体参照を戻す', async () => {
    const html = '<title>\n  A &amp; B &#8211;\n  C </title>';
    expect(await titleFromHtml(html)).toBe('A & B – C');
  });

  it('og:title の値の実体参照も戻す', async () => {
    const html = '<meta property="og:title" content="Q&amp;A &quot;入門&quot;">';
    expect(await titleFromHtml(html)).toBe('Q&A "入門"');
  });

  it('空の og:title は <title> に倒す', async () => {
    expect(await titleFromHtml('<meta property="og:title" content=" "><title>本題</title>')).toBe(
      '本題',
    );
  });

  it('本文の SVG の <title> を拾わない', async () => {
    const html =
      '<head><title>ページ</title></head><body><svg><title>アイコン</title></svg></body>';
    expect(await titleFromHtml(html)).toBe('ページ');
  });

  it('自己終了の <title/> で落ちない', async () => {
    expect(await titleFromHtml('<svg><title/></svg><title>後の題</title>')).toBe('後の題');
  });

  it('どちらも無ければ null', async () => {
    expect(await titleFromHtml('<p>本文だけ</p>')).toBeNull();
  });
});

describe('fetchPageTitle', () => {
  it('Shift_JIS のページのタイトルを取る', async () => {
    const body = bytesOf('<html><head><title>', SJIS_NIHONGO, '</title></head></html>');
    const fetchImpl = stub(body, { headers: { 'content-type': 'text/html; charset=shift_jis' } });
    expect(await fetchPageTitle('https://example.jp/', fetchImpl)).toBe('日本語');
  });

  it('エラー応答・HTML 以外・通信の失敗は null', async () => {
    expect(
      await fetchPageTitle('https://e.example/', stub('<title>x</title>', { status: 404 })),
    ).toBeNull();
    const pdf = stub('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
    expect(await fetchPageTitle('https://e.example/a.pdf', pdf)).toBeNull();
    const failing: typeof fetch = () => Promise.reject(new Error('internal error'));
    expect(await fetchPageTitle('https://e.example/', failing)).toBeNull();
  });

  it('大きなページは頭だけ読む', async () => {
    const huge = `<title>頭の題</title>${'x'.repeat(2 * 1024 * 1024)}`;
    expect(await fetchPageTitle('https://e.example/', stub(huge))).toBe('頭の題');
  });

  it('<meta> だけで宣言したページも化けない（HTMLRewriter が宣言で読み替えない）', async () => {
    const body = bytesOf(
      '<html><head><meta charset="euc-jp"><meta property="og:title" content="',
      EUCJP_NIHONGO,
      '"><title>',
      EUCJP_NIHONGO,
      '</title></head></html>',
    );
    expect(await fetchPageTitle('https://e.example/', stub(body))).toBe('日本語');
    const titleOnly = bytesOf('<meta charset="euc-jp"><title>', EUCJP_NIHONGO, '</title>');
    expect(await fetchPageTitle('https://e.example/', stub(titleOnly))).toBe('日本語');
  });

  it('</head> が塊の境目で割れても、そこで読むのをやめる', async () => {
    const parts = ['<title>題</title></he', 'ad>', 'x'.repeat(1024)];
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const part = parts[pulled];
          pulled += 1;
          if (part === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(part));
        },
        // 先回りして引かせない。読まれた塊の数だけ pull が呼ばれるようにする
      },
      { highWaterMark: 0 },
    );
    expect(await fetchPageTitle('https://e.example/', stub(stream))).toBe('題');
    // 3 つ目の塊は引かない
    expect(pulled).toBe(2);
  });

  it('本文の読み出しで落ちても null に倒す', async () => {
    const throwing: typeof fetch = () =>
      Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: {
          getReader: () => ({
            read: () => Promise.reject(new Error('壊れた本文')),
            cancel: () => Promise.resolve(),
          }),
        },
      } as unknown as Response);
    expect(await fetchPageTitle('https://e.example/', throwing)).toBeNull();
  });
});

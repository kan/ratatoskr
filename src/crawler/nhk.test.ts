import { describe, expect, it } from 'vitest';
import { nhkArticle as article, redirect, stubNhk } from '../test/nhk';
import type { FetchBudget } from './fetch';
import { fetchNhkArticles, nhkArticleId, renderArticle, renderMarked } from './nhk';

/**
 * NHK ONE の記事を JSON から組み立てる。偽物の NHK ONE は src/test/nhk.ts。
 */

describe('nhkArticleId', () => {
  it('ニュース記事の URL から記事 id を取り出す', () => {
    expect(nhkArticleId('https://news.web.nhk/newsweb/na/nd-20260917de50715')).toBe(
      'nd-20260917de50715',
    );
  });

  it('記事ではない URL やほかのホストは対象にしない', () => {
    expect(nhkArticleId('https://news.web.nhk/newsweb/')).toBeNull();
    expect(nhkArticleId('https://news.web.nhk/newsweb/pl/news-nwa-latest-nationwide')).toBeNull();
    expect(nhkArticleId('https://www3.nhk.or.jp/news/html/20260801/k1001.html')).toBeNull();
    expect(nhkArticleId('http://news.web.nhk/newsweb/na/nd-1')).toBeNull();
    expect(nhkArticleId('not a url')).toBeNull();
  });
});

describe('renderMarked', () => {
  it('段落と、行末の \\ による改行を組み立てる', () => {
    expect(renderMarked('1 行目\\\n2 行目\n\n次の段落')).toBe(
      '<p>1 行目<br>2 行目</p><p>次の段落</p>',
    );
  });

  it('見出しの属性とバッジは捨てる', () => {
    const source = [
      '==NEW=={class=nw--updated datetime=2026-09-17T14:51:58+09:00}',
      '==注目=={class=nw--attention id=anchor-020}',
      '',
      '## 見出し {id=anchor-021}',
      '',
      '本文',
    ].join('\n');
    expect(renderMarked(source)).toBe('<h2>見出し</h2><p>本文</p>');
  });

  it('画像だけの段落は figure にし、太字と区切り線を組み立てる', () => {
    const source = ['![説明](https://img.example.nhk/a.jpg)', '', '**太字**の段落', '', '***'].join(
      '\n',
    );
    expect(renderMarked(source)).toBe(
      '<figure><img src="https://img.example.nhk/a.jpg" alt="説明"></figure>' +
        '<p><strong>太字</strong>の段落</p><hr>',
    );
  });

  it('関連記事のカードは、画像と題を行き先へのリンクにして引用の枠に入れる', () => {
    const source = [
      ':::nw--link-type4 {href=https://news.web.nhk/newsweb/na/nd-2}',
      '![関連](https://img.example.nhk/card.jpg)',
      '',
      '**関連記事の題**\\',
      '説明の文',
      ':::',
      '',
      'カードの後の本文',
    ].join('\n');
    expect(renderMarked(source)).toBe(
      '<blockquote>' +
        '<figure><a href="https://news.web.nhk/newsweb/na/nd-2">' +
        '<img src="https://img.example.nhk/card.jpg" alt="関連"></a></figure>' +
        '<p><a href="https://news.web.nhk/newsweb/na/nd-2"><strong>関連記事の題</strong></a>' +
        '<br>説明の文</p>' +
        '</blockquote>' +
        '<p>カードの後の本文</p>',
    );
  });

  it('囲み記事は枠を付けず、中身だけを出す', () => {
    const source = [
      ':::nw--border {style=border-color:#D82991}',
      '## 囲みの見出し',
      '',
      '囲みの本文',
      ':::',
    ].join('\n');
    expect(renderMarked(source)).toBe('<h2>囲みの見出し</h2><p>囲みの本文</p>');
  });

  it('生の HTML ブロックは中身ごと捨てる', () => {
    const source = [
      '前の段落',
      '',
      '```raw-html',
      '<div><h2>地図</h2><iframe src="https://example.nhk/map"></iframe></div>',
      '```',
      '',
      '後の段落',
    ].join('\n');
    expect(renderMarked(source)).toBe('<p>前の段落</p><p>後の段落</p>');
  });

  it('本文の文字は HTML としてではなく文字として扱う', () => {
    expect(renderMarked('<script>alert(1)</script> & "引用"')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;引用&quot;</p>',
    );
  });
});

describe('renderArticle', () => {
  it('メイン画像、リード、本文の順に並べる', () => {
    const html = renderArticle(article('リードの文', '## 見出し\n\n本文の文'));
    expect(html).toBe(
      '<figure><img src="https://img.example.nhk/main_l.jpg" alt=""></figure>' +
        '<p>リードの文</p><h2>見出し</h2><p>本文の文</p>',
    );
  });

  it('生の HTML ブロックを除いた版があればそちらを使う', () => {
    const html = renderArticle(
      article('リード\n\n```raw-html\n<iframe></iframe>\n```', '本文', {
        noHtmlMarkedLead: 'リード（除いた版）',
        noHtmlMarkedBody: '本文（除いた版）',
      }),
    );
    expect(html).toContain('<p>リード（除いた版）</p><p>本文（除いた版）</p>');
  });

  it('速報のように本文が空でも、リードがあれば組み立てる', () => {
    expect(renderArticle(article('速報のリード', ''))).toContain('<p>速報のリード</p>');
  });

  it('リードも本文も空なら、画像だけの全文にしない', () => {
    expect(renderArticle(article('', ''))).toBe('');
  });
});

describe('fetchNhkArticles', () => {
  it('トークンを取ってから記事の JSON を引き、組み立てて返す', async () => {
    const stub = stubNhk({ 'nd-1': article('リード', '本文'), 'nd-2': article('二本目', '') });
    const budget: FetchBudget = { remaining: 10 };

    const { bodies, missing } = await fetchNhkArticles(['nd-1', 'nd-2'], {
      fetchImpl: stub.impl,
      budget,
    });

    expect(bodies.get('nd-1')).toContain('<p>リード</p><p>本文</p>');
    expect(bodies.get('nd-2')).toContain('<p>二本目</p>');
    expect(missing.size).toBe(0);
    // トークンの 3 回と、記事ごとに 1 回
    expect(stub.calls).toHaveLength(5);
    expect(budget.remaining).toBe(5);
  });

  it('消えた記事は missing に入れる', async () => {
    const stub = stubNhk({ 'nd-1': article('リード', '本文') });

    const { bodies, missing } = await fetchNhkArticles(['nd-1', 'nd-gone'], {
      fetchImpl: stub.impl,
      budget: { remaining: 10 },
    });

    expect([...bodies.keys()]).toEqual(['nd-1']);
    expect([...missing]).toEqual(['nd-gone']);
  });

  it('トークンが取れない回は記事を引かず、印も残さない', async () => {
    const stub = stubNhk({ 'nd-1': article('リード', '本文') }, { authorize: false });
    const budget: FetchBudget = { remaining: 10 };

    const { bodies, missing } = await fetchNhkArticles(['nd-1'], {
      fetchImpl: stub.impl,
      budget,
    });

    expect(bodies.size).toBe(0);
    // 発行口が落ちているだけなら次の機会に取れる。印を付けると二度と埋まらない
    expect(missing.size).toBe(0);
    expect(stub.calls.some((url) => url.includes('/newsarticle/'))).toBe(false);
    // 記事の分は返す。トークンの分（取りに行った分）は返さない
    expect(budget.remaining).toBe(7);
  });

  it('本文の欄が無い応答は、記事が無いのではなく受け付けられなかったとみなす', async () => {
    const stub = stubNhk({ 'nd-1': article('リード', '本文'), 'nd-2': article('二本目', '') });
    // トークンを送らない fetch に差し替える（API は本文の欄を落として返す）
    const withoutToken = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      return stub.impl(input, { ...init, headers });
    }) as typeof fetch;
    const budget: FetchBudget = { remaining: 10 };

    const { bodies, missing } = await fetchNhkArticles(['nd-1', 'nd-2'], {
      fetchImpl: withoutToken,
      budget,
    });

    expect(bodies.size).toBe(0);
    expect(missing.size).toBe(0);
    // 記事によらない失敗なので、2 本目は取りに行かず枠を返す
    expect(stub.calls.filter((url) => url.includes('/newsarticle/'))).toHaveLength(1);
    expect(budget.remaining).toBe(6);
  });

  it('リダイレクトが確保した数より長く続いても、確保した分しか要求を送らない', async () => {
    const calls: string[] = [];
    // トークンを出さずにリダイレクトし続ける発行口
    const impl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return redirect(`https://news.web.nhk/tix/loop?n=${calls.length}`);
    }) as unknown as typeof fetch;
    const budget: FetchBudget = { remaining: 10 };

    const { bodies } = await fetchNhkArticles(['nd-1'], { fetchImpl: impl, budget });

    expect(bodies.size).toBe(0);
    expect(calls).toHaveLength(3);
    expect(budget.remaining).toBe(7);
  });

  it('トークンと記事 1 本の分の枠が無ければ、何も取りに行かない', async () => {
    const stub = stubNhk({ 'nd-1': article('リード', '本文') });
    const budget: FetchBudget = { remaining: 3 };

    const { bodies } = await fetchNhkArticles(['nd-1'], { fetchImpl: stub.impl, budget });

    expect(bodies.size).toBe(0);
    expect(stub.calls).toEqual([]);
    expect(budget.remaining).toBe(3);
  });

  it('枠が足りなければ、入る分だけ記事を引いて残りは次の機会に回す', async () => {
    const stub = stubNhk({ 'nd-1': article('一', ''), 'nd-2': article('二', '') });
    const budget: FetchBudget = { remaining: 4 };

    const { bodies, missing } = await fetchNhkArticles(['nd-1', 'nd-2'], {
      fetchImpl: stub.impl,
      budget,
    });

    expect([...bodies.keys()]).toEqual(['nd-1']);
    expect(missing.size).toBe(0);
    expect(budget.remaining).toBe(0);
  });
});

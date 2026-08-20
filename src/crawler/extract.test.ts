import { describe, expect, it } from 'vitest';
import technoEdgeHtml from './__fixtures__/article-techno-edge.html?raw';
import { scanCandidates } from './extract';
import { sanitizeWithin } from './sanitize';

/**
 * 本文の取り出し（M7 の全文取得）。
 *
 * フィクスチャはテクノエッジの実際の記事ページ。要約しか配信しないフィードの
 * 代表例で、docs/ROADMAP.md の M7 が名指ししているモデルケースにあたる。
 */

describe('scanCandidates', () => {
  it('実際の記事ページで本文の入れ物を 1 位にする', async () => {
    const candidates = await scanCandidates(technoEdgeHtml);

    // 本文は article.arti-body。ページ全体を包む div.thm-body ではない
    expect(candidates[0].selector).toContain('arti-body');
  });

  it('ページ全体を包む入れ物を上位に出さない', async () => {
    const candidates = await scanCandidates(technoEdgeHtml);

    // 単純なテキスト量では div.thm-body が最大になる。段落の点を 2 段までしか
    // 配らないのは、まさにこれを 1 位にしないため
    const whole = candidates.findIndex((candidate) => candidate.selector.includes('thm-body'));
    expect(whole).not.toBe(0);
  });

  it('文書内で一意に名指しできない入れ物は候補にしない', async () => {
    const candidates = await scanCandidates(technoEdgeHtml);

    // article.pickup-content は関連記事で、同じ class の要素がページ内に複数ある。
    // セレクタで名指しできない = 次の記事で同じ場所を引ける保証が無い
    expect(candidates.map((candidate) => candidate.selector)).not.toContain(
      'article.pickup-content',
    );
  });

  it('リンクばかりの入れ物を本文より上に出さない', async () => {
    const candidates = await scanCandidates(technoEdgeHtml);
    const body = candidates[0];

    expect(body.link / body.text).toBeLessThan(0.5);
  });

  it('段落の無い文書では候補が出ない', async () => {
    const candidates = await scanCandidates(
      '<html><body><div class="nav"><a href="/a">A</a><a href="/b">B</a></div></body></html>',
    );

    expect(candidates).toEqual([]);
  });
});

describe('sanitizeWithin', () => {
  const page = `<!doctype html>
    <html><head><title>ページ</title><script>alert(1)</script></head>
    <body>
      <nav class="global"><a href="/top">トップ</a>ナビの文字</nav>
      <div class="wrap">
        <article class="entry">
          <p>本文の 1 段落目。</p>
          <p>本文の 2 段落目。<a href="/link">中のリンク</a></p>
          <img src="/img/a.jpg" width="600" height="400" alt="写真">
          <script>alert(2)</script>
        </article>
      </div>
      <footer class="foot">フッタの文字</footer>
    </body></html>`;

  it('対象の中身だけをサニタイズして返す', async () => {
    const body = await sanitizeWithin(page, 'article.entry', 'https://example.com/article/1');

    expect(body).toContain('本文の 1 段落目。');
    expect(body).toContain('本文の 2 段落目。');
    // 相対 URL は記事の URL を基準に絶対化され、width / height は落ちる
    expect(body).toContain('<img src="https://example.com/img/a.jpg" alt="写真">');
    expect(body).not.toContain('width=');
  });

  it('対象の外にある文字を持ち込まない', async () => {
    const body = await sanitizeWithin(page, 'article.entry', 'https://example.com/article/1');

    // 祖先（div.wrap / body / html）はタグを剥がすだけなので、外側のテキストが
    // 混ざらないことを見ておく。本文の前後には必ずナビや関連記事がある
    expect(body).not.toContain('ナビの文字');
    expect(body).not.toContain('フッタの文字');
    expect(body).not.toContain('トップ');
  });

  it('スクリプトを持ち込まない', async () => {
    const body = await sanitizeWithin(page, 'article.entry', 'https://example.com/article/1');

    expect(body).not.toContain('alert');
  });

  it('対象が見つからなければ null', async () => {
    expect(await sanitizeWithin(page, 'article.missing', null)).toBeNull();
  });

  it('実際の記事ページから本文を取り出す', async () => {
    const candidates = await scanCandidates(technoEdgeHtml);
    const body = await sanitizeWithin(
      technoEdgeHtml,
      candidates[0].selector,
      'https://www.techno-edge.net/article/2026/08/18/5400.html',
    );

    expect(body).not.toBeNull();
    // 記事ページ 1 枚を渡しているので、doctype が混ざらないことも見ておく
    expect(body).not.toContain('<!doctype');
    // フィードが配信していたのは 117 字の要約だけ。本文はその何倍もある
    expect(body!.length).toBeGreaterThan(1000);
    expect(body).toContain('YouTube');
    // サイドバーの Amazon ランキングやフッタが混ざっていないこと
    expect(body).not.toContain('ランキング');
  });
});

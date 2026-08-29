import { describe, expect, it } from 'vitest';
import kyokoHtml from './__fixtures__/article-kyoko-np.html?raw';
import technoEdgeHtml from './__fixtures__/article-techno-edge.html?raw';
import diaryHtml from './__fixtures__/diary-hyuki.html?raw';
import { fragmentOf, locateFragmentOccurrence, scanCandidates } from './extract';
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

  /**
   * class も id も使わず、p の閉じタグも省く書き方（blog.jxck.io がこれ）。
   * HTML5 として妥当で、実際にこのせいで候補が 1 つも出なかった
   */
  const plain = (closeParagraphs: boolean): string => {
    const end = closeParagraphs ? '</p>' : '';
    const section = (n: number): string => `<section><h2>節 ${n}</h2>
        <p>ここは十分な長さのある段落で、本文として数えられるべき文章が続いている。${end}
        <p>もう一段落。こちらも本文として数えられるだけの長さを持っている文章である。${end}
      </section>`;
    // 節が複数あるのは実物と同じ形にするため。section は名指しできず、
    // 1 つしか無い article が残る
    return `<html><body><main><article>
      <h1>題</h1>
      ${section(1)}
      ${section(2)}
    </article></main></body></html>`;
  };

  it('class も id も無い入れ物は、タグ名で名指しする', async () => {
    const candidates = await scanCandidates(plain(false));

    // article は文書内に 1 つしか無いので名指しできる
    expect(candidates[0].selector).toBe('article');
  });

  it('p の閉じタグが省かれていても段落を数える', async () => {
    // HTMLRewriter は木を組み立てないので暗黙の終了タグはほとんど来ない。
    // </p> だけを頼りにすると加点が丸ごと落ちる
    const closed = await scanCandidates(plain(true));
    const open = await scanCandidates(plain(false));

    expect(open[0].score).toBe(closed[0].score);
    expect(open[0].score).toBeGreaterThan(0);
  });

  it('その記事の文章のごく一部しか持たない入れ物は候補にしない', async () => {
    // 結城浩の日記を、どの記事かを指定せずに読む。本文の入れ物はページ内に 11 個
    // あって一意に名指しできないので落ち、残るのは著者プロフィールの外枠だけになる。
    // それを本文として採ると、全記事が同じプロフィールで埋まる（実際にそうなった）
    const candidates = await scanCandidates(diaryHtml);

    expect(candidates.map((candidate) => candidate.selector)).not.toContain('div.p-2.flex-grow-1');
  });

  /**
   * 本文が `<p>` に入っていないサイト（虚構新聞）。article 直下に素のテキストを置き、
   * 改行は `<br>` だけで作っている。`<p>` からしか点を配らないと候補が 0 件になる
   */
  it('p を使わずに書かれた本文でも、入れ物を 1 位にする', async () => {
    const candidates = await scanCandidates(kyokoHtml);

    expect(candidates[0].selector).toBe('article');
    // 本文の入れ物なのでリンクはほとんど無い
    expect(candidates[0].link / candidates[0].text).toBeLessThan(0.1);
  });

  it('br が段落の切れ目になる', async () => {
    const line = 'ここは十分な長さのある文で、段落として数えられるべきもの。';
    // 同じ文字数を 1 つの塊で置いた場合と、br で割った場合で点が変わらないこと。
    // br を見ないと 1 つの長い段落として数えてしまう
    const joined = await scanCandidates(
      `<html><body><article>${line}${line}</article></body></html>`,
    );
    const split = await scanCandidates(
      `<html><body><article>${line}<br>${line}</article></body></html>`,
    );

    expect(joined[0].selector).toBe('article');
    expect(split[0].selector).toBe('article');
    expect(split[0].score).toBe(joined[0].score);
  });

  it('li で組まれていないリンク列を段落として数えない', async () => {
    // フッタの関連記事一覧が li で組まれていないサイトがある。これを段落として
    // 数えると分母が膨らみ、本文が下限に切られて候補から落ちる
    const links = Array.from(
      { length: 200 },
      (_, i) => `<a href="/${i}">関連記事のタイトルその${i}番目です</a>`,
    ).join('');
    const candidates = await scanCandidates(
      `<html><body><div class="wrap">` +
        `<article><p>${'本文の文字。'.repeat(50)}</p></article>` +
        `<div class="footer">${links}</div>` +
        `</div></body></html>`,
    );

    expect(candidates[0].selector).toBe('article');
  });

  it('br で刻まれた短い行も、まとめて 1 つの段落として数える', async () => {
    // 1 行が短い書き方（日記や詩）だと、br ごとに締めると全ての行が
    // MIN_PARAGRAPH に届かず、本文の加点が丸ごと落ちる
    const lines = ['朝が来た。', '雨が降った。', '風が吹いた。', '空が晴れた。'];
    const candidates = await scanCandidates(
      `<html><body><article><p>${lines.concat(lines).join('<br>')}</p></article></body></html>`,
    );

    expect(candidates[0].selector).toBe('article');
    expect(candidates[0].score).toBeGreaterThan(0);
  });

  it('リンクの並んだ一覧を段落として数えない', async () => {
    // li ごとに区切るので、1 つ 1 つが短ければ段落にならない。区切らないと
    // ナビゲーション全体が 1 つの長い段落になる
    const items = ['トップ', '社会', '政治', '経済', '国際', 'スポーツ', '文化', '社説']
      .map((name) => `<li><a href="/${name}">${name}</a></li>`)
      .join('');
    const candidates = await scanCandidates(
      `<html><body><div class="nav"><ul>${items}</ul></div></body></html>`,
    );

    expect(candidates).toEqual([]);
  });

  it('hr があっても走査が止まらない', async () => {
    // hr は空要素なので、終了タグを待つ形で登録すると HTMLRewriter が
    // 「No end tag」を投げて走査ごと落ちる。例外は crawl の Promise.allSettled に
    // 拾われるので、そのフィードだけ静かに全文が埋まらなくなる（実際に踏んだ）
    const line = 'ここは十分な長さのある文で、段落として数えられるべきもの。';
    const candidates = await scanCandidates(
      `<html><body><article>${line}<hr>${line}</article></body></html>`,
    );

    expect(candidates[0].selector).toBe('article');
  });

  it('SVG の中の自己終了タグがあっても走査が止まらない', async () => {
    // SVG / MathML の中では HTML と違って自己終了タグが有効なので、終了タグを
    // 待つ形で登録すると「No end tag」で走査ごと落ちる。opaque（svg / title）と
    // リンク（a）の両方で再現した
    const line = 'ここは十分な長さのある文で、段落として数えられるべきもの。';
    for (const mark of ['<svg class="i"/>', '<svg><title/></svg>', '<svg><a href="#"/></svg>']) {
      const candidates = await scanCandidates(
        `<html><body><article>${line}${mark}${line}</article></body></html>`,
      );

      // 落ちないだけでなく、印の後ろの文章も数に入っていること。開いた印を
      // 下ろせないまま進むと、以降のテキストが全て漏れる
      expect(candidates[0].selector).toBe('article');
      expect(candidates[0].text).toBe(line.length * 2);
    }
  });

  it('中の文章が同じなら同じ指紋、違えば違う指紋になる', async () => {
    // フィードをまたいだ突き合わせ（src/crawler/repeat.ts）の材料。
    // 文字数だけでは、同じ長さの別の文章を取り違える
    const page = (text: string): string => `<html><body><article>${text}</article></body></html>`;
    const a = 'ここは十分な長さのある文で、段落として数えられるべきもの。';
    const b = 'ここは十分な長さのある文で、段落として数えるべきものです。';

    const [first, second, again] = await Promise.all([
      scanCandidates(page(a)),
      scanCandidates(page(b)),
      scanCandidates(page(a)),
    ]);

    expect(first[0].signature).toBe(again[0].signature);
    expect(first[0].signature).not.toBe(second[0].signature);
  });

  it('段落の無い文書では候補が出ない', async () => {
    const candidates = await scanCandidates(
      '<html><body><div class="nav"><a href="/a">A</a><a href="/b">B</a></div></body></html>',
    );

    expect(candidates).toEqual([]);
  });
});

/**
 * 1 ページに複数の記事が並ぶ日記型のサイト（結城浩の日記）。
 * 記事 URL は `https://d.hyuki.com/202509.html#i20250924072819` の形で、
 * **どの記事かはフラグメントが決める。**
 */
describe('フラグメントで記事を絞る', () => {
  const 記事 = 'i20250921130556';

  it('記事の中だけを見れば、本文の入れ物が一意に名指しできる', async () => {
    const candidates = await scanCandidates(diaryHtml, { fragment: 記事 });

    // div.DIARY-CONTENT はページ内に 11 個あるが、この記事の中には 1 つしかない
    expect(candidates[0].selector).toBe('div.DIARY-CONTENT');
  });

  it('絞った先の文章だけを数える', async () => {
    const scoped = await scanCandidates(diaryHtml, { fragment: 記事 });
    const whole = await scanCandidates(diaryHtml);

    // 絞らなければ、この記事の本文はどの候補にも出てこない
    expect(whole.map((candidate) => candidate.selector)).not.toContain('div.DIARY-CONTENT');
    expect(scoped[0].preview).toContain('編集者さん');
  });

  it('記事ごとに違う id をセレクタにしない', async () => {
    // 繰り返し構造の中の id は記事ごとに違う。これをフィード全体のセレクタとして
    // 覚えると、他の記事が全て当たらなくなって毎クロール判定し直す空回りになる
    const entry = (anchor: string, text: string): string =>
      `<div id="${anchor}" class="section"><h3>見出し</h3><p>${text}</p></div>`;
    const html = `<html><body>${entry('p01', 'ひとつ目の本文。'.repeat(10))}${entry(
      'p02',
      'ふたつ目の本文。'.repeat(10),
    )}</body></html>`;

    const first = await scanCandidates(html, { fragment: 'p01' });
    const second = await scanCandidates(html, { fragment: 'p02' });

    // どの記事から決めても同じセレクタになる
    expect(first[0].selector).toBe('div.section');
    expect(second[0].selector).toBe('div.section');
  });

  it('覚えたセレクタの何番目がその記事かを返す', async () => {
    const first = await locateFragmentOccurrence(diaryHtml, 'div.DIARY-CONTENT', 'i20250924072819');
    const second = await locateFragmentOccurrence(diaryHtml, 'div.DIARY-CONTENT', 記事);

    // アンカーは記事の見出しにあり、本文の入れ物はその後ろにある
    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  it('記事の末尾にアンカーがあっても、その記事の本文を採る', async () => {
    // パーマリンクを記事の末尾に置く作り。「アンカーより後の最初の一致」で
    // 済ませると隣の記事の本文を採ってしまう（エラーにならないので気付けない）
    const entry = (anchor: string, text: string): string =>
      `<div class="entry"><div class="content"><p>${text}</p></div>` +
      `<p class="foot"><a name="${anchor}" id="${anchor}">この記事</a></p></div>`;
    const html = `<html><body>${entry('p01', 'ひとつ目の本文。'.repeat(10))}${entry(
      'p02',
      'ふたつ目の本文。'.repeat(10),
    )}</body></html>`;

    expect(await locateFragmentOccurrence(html, 'div.content', 'p01')).toBe(0);
    expect(await locateFragmentOccurrence(html, 'div.content', 'p02')).toBe(1);
  });

  it('アンカーを抱えている入れ物の外にある一致は採らない', async () => {
    // 目次のリンク先が記事の外にある形。範囲を区切らないと、関係のない
    // 入れ物を「アンカーより後の最初の一致」として掴む
    const html = `<html><body>
      <div class="toc"><p><a name="p01" id="p01">目次</a></p></div>
      <div class="entry"><div class="content"><p>${'本文。'.repeat(20)}</p></div></div>
    </body></html>`;

    expect(await locateFragmentOccurrence(html, 'div.content', 'p01')).toBeNull();
  });

  it('アンカーが見つからなければ null', async () => {
    expect(
      await locateFragmentOccurrence(diaryHtml, 'div.DIARY-CONTENT', 'i19700101000000'),
    ).toBeNull();
  });

  it('セレクタに埋められない形のフラグメントは扱わない', async () => {
    // 属性セレクタを組み立てる先なので、引用符を含むものは通さない
    expect(await locateFragmentOccurrence(diaryHtml, 'div.DIARY-CONTENT', 'a"b')).toBeNull();
  });
});

describe('fragmentOf', () => {
  it('記事 URL の # 以下を取り出す', () => {
    expect(fragmentOf('https://d.hyuki.com/202509.html#i20250921130556')).toBe('i20250921130556');
  });

  it('# が無ければ null', () => {
    expect(fragmentOf('https://www.techno-edge.net/article/2026/08/18/5400.html')).toBeNull();
  });

  it('# だけなら null', () => {
    expect(fragmentOf('https://example.com/a#')).toBeNull();
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

  it('同じセレクタが並ぶページでは、指定した番号のものを採る', async () => {
    const base = 'https://d.hyuki.com/202509.html';
    const first = await sanitizeWithin(diaryHtml, 'div.DIARY-CONTENT', base, 0);
    const second = await sanitizeWithin(diaryHtml, 'div.DIARY-CONTENT', base, 1);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // 番号を渡さなければ全記事が 1 件目の本文になる。それが元の不具合だった
    expect(second).not.toBe(first);
    expect(second).toContain('編集者さん');
    expect(first).not.toContain('編集者さん');
  });

  it('当たった数より大きい番号を渡したら null', async () => {
    expect(await sanitizeWithin(diaryHtml, 'div.DIARY-CONTENT', null, 999)).toBeNull();
  });

  it('p を使わない記事ページからも本文を取り出す', async () => {
    const candidates = await scanCandidates(kyokoHtml);
    const body = await sanitizeWithin(
      kyokoHtml,
      candidates[0].selector,
      'https://kyoko-np.net/2026081401.html',
    );

    expect(body).not.toBeNull();
    // フィードが配信していたのは 100 字ほどの要約だけ
    expect(body!.length).toBeGreaterThan(1000);
    expect(body).toContain('酷暑対策基本法');
    // ヘッダのナビゲーションやフッタが混ざっていないこと
    expect(body).not.toContain('虚構新聞社について');
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

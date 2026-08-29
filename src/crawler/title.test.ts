import { describe, expect, it } from 'vitest';
import { titleFromBody } from './title';

/**
 * タイトルを配らないフィード（Bluesky のプロフィール RSS など）のための見出し。
 * 作るのは本文の書き出しで、要約ではない。
 */

describe('titleFromBody', () => {
  it('本文の書き出しをそのまま使う', async () => {
    expect(await titleFromBody('<p>自治会の夏祭りで買った焼き鳥、美味しかった</p>')).toBe(
      '自治会の夏祭りで買った焼き鳥、美味しかった',
    );
  });

  it('改行を空白に畳む', async () => {
    // Bluesky の投稿は行を並べる書き方が多い（体重ログなど）。
    // 行で切らないのは、1 行目が極端に短い本文で見出しが用を成さなくなるため
    expect(await titleFromBody('今日の体重: 133.4kg<br>連続52日目<br><br>AI「油断は禁物」')).toBe(
      '今日の体重: 133.4kg 連続52日目 AI「油断は禁物」',
    );
  });

  it('段落の切れ目で語がくっつかない', async () => {
    expect(await titleFromBody('<p>ひとつ目</p><p>ふたつ目</p>')).toBe('ひとつ目 ふたつ目');
  });

  it('文の途中に空白を挟まない', async () => {
    // インライン要素で挟むと、日本語の文が不自然に割れる
    expect(await titleFromBody('<p>これは<strong>大事</strong>な話です</p>')).toBe(
      'これは大事な話です',
    );
  });

  it('長い本文は切って、切ったことが分かるようにする', async () => {
    const title = await titleFromBody(`<p>${'あ'.repeat(100)}</p>`);

    expect(title).toBe(`${'あ'.repeat(60)}…`);
  });

  it('ちょうど収まる長さには印を付けない', async () => {
    expect(await titleFromBody(`<p>${'あ'.repeat(60)}</p>`)).toBe('あ'.repeat(60));
  });

  it('絵文字が境目に来ても割らない', async () => {
    // slice は UTF-16 の単位で切るので、サロゲートペアが割れると U+FFFD が出る
    const title = await titleFromBody(`<p>${'あ'.repeat(59)}🍣あとの本文</p>`);

    expect([...title]).toHaveLength(61);
    expect(title.endsWith('🍣…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(title)).toBe(false);
  });

  it('実体参照を文字に戻す', async () => {
    // 本文は v-html で描かれるが見出しはテキスト。戻さないと字面がそのまま出る
    expect(await titleFromBody('<p>A &amp; B &lt;tag&gt; &#128512; &#x3042;</p>')).toBe(
      'A & B <tag> 😀 あ',
    );
  });

  it('&nbsp; は普通の空白として畳む', async () => {
    expect(await titleFromBody('<p>A&nbsp;&nbsp;B</p>')).toBe('A B');
  });

  it('知らない実体参照はそのまま残す', async () => {
    // 消すより字面が出た方が読み手には分かる
    expect(await titleFromBody('<p>1 &unknownentity; 2</p>')).toBe('1 &unknownentity; 2');
  });

  it('単独のサロゲートになる数値参照は戻さない', async () => {
    expect(await titleFromBody('<p>a&#xD800;b</p>')).toBe('a&#xD800;b');
  });

  it('タグを持ち込まない', async () => {
    expect(await titleFromBody('<p><a href="https://example.com/">リンク</a>の記事</p>')).toBe(
      'リンクの記事',
    );
  });

  it('文章の無い本文では空にする（呼び出し側が「(無題)」を出す）', async () => {
    expect(await titleFromBody('<p><img src="https://example.com/a.jpg" alt=""></p>')).toBe('');
    expect(await titleFromBody('')).toBe('');
  });
});

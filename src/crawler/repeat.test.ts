import { describe, expect, it } from 'vitest';
import type { Candidate } from './extract';
import { bodiesCollapsed, repeatedSignatures } from './repeat';

/**
 * 「同じフィードの別の記事に同じ文章が出るなら、それは本文ではない」（issue #9）。
 *
 * ここで見るのは規則そのもの。実際の記事ページに当てた結果は extract.test.ts と
 * fulltext.test.ts が見ている。
 */

function candidate(selector: string, signature: string): Candidate {
  return { selector, text: 100, link: 0, score: 100, preview: selector, signature };
}

describe('repeatedSignatures', () => {
  it('どのページにも同じ文章で出る塊を拾う', () => {
    const chrome = candidate('div.copyright', 'chrome');
    const pages = [
      [candidate('div.body', 'a'), chrome],
      [candidate('div.body', 'b'), chrome],
      [candidate('div.body', 'c'), chrome],
    ];

    const repeated = repeatedSignatures(pages);
    expect([...repeated]).toEqual(['chrome']);
  });

  it('1 ページしか無ければ何も拾わない', () => {
    // 繰り返しは 2 ページ以上を突き合わせて初めて分かる。1 ページのときに
    // 拾ってしまうと、本文が候補から消える
    const repeated = repeatedSignatures([[candidate('div.body', 'a')]]);
    expect(repeated.size).toBe(0);
  });

  it('同じページの中で入れ子に同じ文章が並んでも、1 回しか数えない', () => {
    // 本文の div とそれを包む div は同じ文章を持つ。ページごとに数えないと、
    // 1 ページ渡しただけで本文が「繰り返し」になる
    const pages = [[candidate('div.inner', 'a'), candidate('div.outer', 'a')]];
    expect(repeatedSignatures(pages).size).toBe(0);
  });

  it('2 ページのうち片方にしか出ないものは拾わない', () => {
    const pages = [
      [candidate('div.body', 'a'), candidate('div.intro', 'only-here')],
      [candidate('div.body', 'b')],
    ];

    expect(repeatedSignatures(pages).size).toBe(0);
  });
});

describe('bodiesCollapsed', () => {
  it('どの記事も同じ本文なら、セレクタを疑う', () => {
    expect(
      bodiesCollapsed([
        { url: 'https://example.com/a', fullBody: '<p>外枠</p>' },
        { url: 'https://example.com/b', fullBody: '<p>外枠</p>' },
      ]),
    ).toBe(true);
  });

  it('一部が一致しただけなら疑わない', () => {
    // フィードが同じ記事を別の URL で 2 度配ることがある（転載、パラメータ違い、
    // 別 URL から同じページへのリダイレクト）。外枠を掴んでいるならどの記事も
    // 同じ本文になるので、全一致に絞っても取り逃さない
    expect(
      bodiesCollapsed([
        { url: 'https://example.com/a', fullBody: '<p>同じ記事</p>' },
        { url: 'https://example.com/b', fullBody: '<p>同じ記事</p>' },
        { url: 'https://example.com/c', fullBody: '<p>別の記事</p>' },
      ]),
    ).toBe(false);
  });

  it('同じ記事 URL が 2 つあるだけなら疑わない', () => {
    expect(
      bodiesCollapsed([
        { url: 'https://example.com/a', fullBody: '<p>本文</p>' },
        { url: 'https://example.com/a', fullBody: '<p>本文</p>' },
      ]),
    ).toBe(false);
  });

  it('1 件だけでは判断しない', () => {
    expect(bodiesCollapsed([{ url: 'https://example.com/a', fullBody: '<p>本文</p>' }])).toBe(
      false,
    );
  });

  it('日記型のサイトで、記事ごとに違う本文が採れていれば疑わない', () => {
    expect(
      bodiesCollapsed([
        { url: 'https://example.com/2509.html#p01', fullBody: '<p>ひとつ目</p>' },
        { url: 'https://example.com/2509.html#p02', fullBody: '<p>ふたつ目</p>' },
      ]),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { bookmarkUrl, DEFAULT_BOOKMARK_TEMPLATE, isBookmarkTemplate } from './bookmark';

/**
 * 外部ブックマークへ送る URL の組み立て（issue #22）。
 *
 * ここで作った文字列はそのまま window.open に渡る。記事の URL とタイトルは
 * フィードが配ったもの、ひな形は設定欄に打ったものなので、どちらも形を確かめる。
 */
describe('bookmarkUrl', () => {
  it('既定のひな形では、はてなブックマークの追加画面を指す', () => {
    expect(bookmarkUrl(DEFAULT_BOOKMARK_TEMPLATE, 'https://example.com/a?b=1&c=2', '題')).toBe(
      'https://b.hatena.ne.jp/my/add.confirm?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26c%3D2',
    );
  });

  it('{url} と {title} を、エンコードして差し込む', () => {
    const template = 'https://bm.example.com/add?u={url}&t={title}';
    expect(bookmarkUrl(template, 'https://example.com/', 'A & B')).toBe(
      'https://bm.example.com/add?u=https%3A%2F%2Fexample.com%2F&t=A%20%26%20B',
    );
  });

  it('タイトルに {url} と書いてあっても、もう一度は差し替えない', () => {
    const template = 'https://bm.example.com/add?t={title}&u={url}';
    expect(bookmarkUrl(template, 'https://example.com/', '{url} の話')).toBe(
      'https://bm.example.com/add?t=%7Burl%7D%20%E3%81%AE%E8%A9%B1&u=https%3A%2F%2Fexample.com%2F',
    );
  });

  it('http / https でない記事の URL は送らない', () => {
    expect(bookmarkUrl(DEFAULT_BOOKMARK_TEMPLATE, 'javascript:alert(1)', '')).toBeNull();
    expect(bookmarkUrl(DEFAULT_BOOKMARK_TEMPLATE, 'not a url', '')).toBeNull();
  });

  it('記事の URL は正規化してから差し込む（前後の空白や改行を連れて行かない）', () => {
    expect(bookmarkUrl(DEFAULT_BOOKMARK_TEMPLATE, ' https://example.com/a\n', '')).toBe(
      'https://b.hatena.ne.jp/my/add.confirm?url=https%3A%2F%2Fexample.com%2Fa',
    );
  });

  it('壊れた文字を含むタイトルでも投げない（送れないと答える）', () => {
    // 絵文字の途中で切られたタイトル。encodeURIComponent は URIError を投げる
    const template = 'https://bm.example.com/add?u={url}&t={title}';
    expect(bookmarkUrl(template, 'https://example.com/', '途中で切れた \ud83d')).toBeNull();
    // タイトルを使わないひな形なら、そのまま送れる
    expect(bookmarkUrl(DEFAULT_BOOKMARK_TEMPLATE, 'https://example.com/', '\ud83d')).not.toBeNull();
  });
});

describe('isBookmarkTemplate', () => {
  it('{url} を含む http / https の URL だけを通す', () => {
    expect(isBookmarkTemplate(DEFAULT_BOOKMARK_TEMPLATE)).toBe(true);
    expect(isBookmarkTemplate('https://bm.example.com/add?u={url}&t={title}')).toBe(true);
  });

  it('{url} が無いものは通さない（何を送っても同じ画面が開くだけになる）', () => {
    expect(isBookmarkTemplate('https://bm.example.com/add')).toBe(false);
    expect(isBookmarkTemplate('https://bm.example.com/add?t={title}')).toBe(false);
  });

  it('スクリプトを実行できる形は通さない', () => {
    expect(isBookmarkTemplate('javascript:alert("{url}")')).toBe(false);
    expect(isBookmarkTemplate('{url}')).toBe(false);
  });

  it('{title} が URL の骨組みに掛かるものは通さない（空のタイトルでだけ成り立つ形）', () => {
    expect(isBookmarkTemplate('https://bm.example.com:{title}/add?u={url}')).toBe(false);
    expect(isBookmarkTemplate('{title}https://bm.example.com/?u={url}')).toBe(false);
  });
});

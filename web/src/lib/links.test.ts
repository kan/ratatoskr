import { describe, expect, it } from 'vitest';
import { collectLinks, type Anchor } from './links';

function a(href: string, text = '', alt = ''): Anchor {
  return { href, text, alt };
}

describe('collectLinks', () => {
  it('本文のリンクを出た順に返す', () => {
    expect(
      collectLinks([a('https://example.com/a', 'A'), a('https://example.com/b', 'B')], null),
    ).toEqual([
      { url: 'https://example.com/a', text: 'A' },
      { url: 'https://example.com/b', text: 'B' },
    ]);
  });

  it('同じ URL は先に出た方を残し、文字が無ければ後の文字で埋める', () => {
    // リンクカードは画像とキャプションが同じ先を指す
    expect(
      collectLinks(
        [
          a('https://example.com/item', ''),
          a('https://example.com/item', '紹介先'),
          a('https://example.com/item', '別の文字'),
        ],
        null,
      ),
    ).toEqual([{ url: 'https://example.com/item', text: '紹介先' }]);
  });

  it('#タグと @メンションは除く', () => {
    expect(
      collectLinks(
        [
          a('https://bsky.app/hashtag/foo', '#foo'),
          a('https://bsky.app/profile/did:plc:x', ' @someone.example.com'),
          a('https://example.com/a', 'A'),
        ],
        null,
      ),
    ).toEqual([{ url: 'https://example.com/a', text: 'A' }]);
  });

  it('# や @ で始まっても、1 語だけでないリンク文字は残す', () => {
    expect(
      collectLinks(
        [
          a('https://atmarkit.example.com/a', '@IT の記事'),
          a('https://example.com/rank', '#1 おすすめ'),
        ],
        null,
      ).map((link) => link.text),
    ).toEqual(['@IT の記事', '#1 おすすめ']);
  });

  it('記事そのものの URL は除く（先頭に「この記事」として別に出す）', () => {
    expect(
      collectLinks(
        [a('https://example.com/entry', 'この記事'), a('https://example.com/a', 'A')],
        'https://example.com/entry',
      ),
    ).toEqual([{ url: 'https://example.com/a', text: 'A' }]);
  });

  it('http / https 以外は除く', () => {
    expect(collectLinks([a('mailto:me@example.com', 'mail'), a('not a url', 'x')], null)).toEqual(
      [],
    );
  });

  it('画像だけのリンクは alt を呼び名にする', () => {
    expect(collectLinks([a('https://example.com/a', '  ', '表紙')], null)).toEqual([
      { url: 'https://example.com/a', text: '表紙' },
    ]);
  });

  it('文字の改行と連続した空白を 1 つに畳む', () => {
    expect(collectLinks([a('https://example.com/a', '  紹介\n  先 ')], null)).toEqual([
      { url: 'https://example.com/a', text: '紹介 先' },
    ]);
  });
});

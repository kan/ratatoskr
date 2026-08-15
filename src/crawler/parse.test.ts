import { describe, expect, it } from 'vitest';
import { parseFeed } from './parse';
import { ParseError } from './types';
import rss2Xml from './__fixtures__/rss2.xml?raw';
import atomXml from './__fixtures__/atom.xml?raw';
import rdfXml from './__fixtures__/rdf.xml?raw';
import datesXml from './__fixtures__/dates-broken.xml?raw';

// 日付の足切り（未来すぎる値）を決定的に判定するため、時刻を固定する
const NOW = Math.floor(Date.parse('2026-08-05T00:00:00Z') / 1000);

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('RSS 2.0', () => {
  const feed = parseFeed(rss2Xml, NOW);

  it('チャンネルのメタ情報を読む', () => {
    expect(feed.title).toBe('テストブログ');
    // atom:link rel="self" ではなく、本体の <link> を取ること
    expect(feed.siteUrl).toBe('https://example.com/');
    expect(feed.items).toHaveLength(2);
  });

  it('guid・日付・dc:creator を読む', () => {
    const item = feed.items[0];
    expect(item.guid).toBe('tag:example.com,2026:post-2');
    expect(item.url).toBe('https://example.com/posts/2');
    expect(item.title).toBe('新しい記事');
    expect(item.author).toBe('kan');
    // RFC 822 + タイムゾーン付き
    expect(item.publishedAt).toBe(seconds('2026-08-04T03:34:56Z'));
  });

  it('content:encoded を description より優先する', () => {
    expect(feed.items[0].body).toBe('<p>本文です。<a href="/posts/1">前の記事</a></p>');
  });

  it('guid が無ければ null のまま返す（ハッシュの材料選びは呼び出し側の責務）', () => {
    expect(feed.items[1].guid).toBeNull();
  });

  it('エスケープされた HTML を実体参照から戻す', () => {
    expect(feed.items[1].body).toBe('<p>エスケープされた HTML</p>');
  });
});

describe('Atom', () => {
  const feed = parseFeed(atomXml, NOW);

  it('rel="alternate" の link をサイト URL に選ぶ', () => {
    expect(feed.title).toBe('Atom のテスト');
    expect(feed.siteUrl).toBe('https://atom.example.com/');
    expect(feed.items).toHaveLength(2);
  });

  it('id・author/name・content を読む', () => {
    const item = feed.items[0];
    expect(item.guid).toBe('urn:uuid:entry-2');
    expect(item.url).toBe('https://atom.example.com/entries/2');
    expect(item.author).toBe('kan');
    expect(item.body).toBe('<p>Atom の本文</p>');
    // published があれば updated より優先する
    expect(item.publishedAt).toBe(seconds('2026-08-04T09:00:00Z'));
  });

  it('published が無ければ updated を使う', () => {
    expect(feed.items[1].publishedAt).toBe(seconds('2026-08-03T09:00:00Z'));
    // rel を持たない link も本文へのリンクとして拾う
    expect(feed.items[1].url).toBe('https://atom.example.com/entries/1');
  });
});

describe('RDF (RSS 1.0)', () => {
  const feed = parseFeed(rdfXml, NOW);

  it('channel と兄弟に並ぶ item を拾う', () => {
    expect(feed.title).toBe('RDF のテスト');
    expect(feed.siteUrl).toBe('https://rdf.example.com/');
    expect(feed.items).toHaveLength(2);
  });

  it('rdf:about を guid に使い、dc:date を読む', () => {
    const item = feed.items[0];
    expect(item.guid).toBe('https://rdf.example.com/2');
    expect(item.author).toBe('kan');
    expect(item.body).toBe('<p>RDF の本文</p>');
    expect(item.publishedAt).toBe(seconds('2026-08-04T09:00:00Z'));
  });

  it('content:encoded が無ければ description を使う', () => {
    expect(feed.items[1].body).toBe('説明しか無い記事');
  });
});

describe('日付の異常系', () => {
  const feed = parseFeed(datesXml, NOW);
  const byTitle = new Map(feed.items.map((item) => [item.title, item]));

  it('壊れた日付でも記事自体は取り込む', () => {
    expect(feed.items).toHaveLength(9);
    for (const item of feed.items) {
      expect(item.url).not.toBeNull();
    }
  });

  it.each([
    ['rfc3339', seconds('2026-08-04T03:00:00Z')],
    ['rfc822', seconds('2026-08-04T03:00:00Z')],
    ['space-separated', seconds('2026-08-04T03:00:00Z')],
    ['dc-date-fallback', seconds('2026-08-04T03:00:00Z')],
  ])('%s は Unix 秒に落ちる', (title, expected) => {
    expect(byTitle.get(title)?.publishedAt).toBe(expected);
  });

  it.each(['garbage', 'empty', 'missing', 'too-old', 'too-far-future'])(
    '%s は null になる',
    (title) => {
      expect(byTitle.get(title)?.publishedAt).toBeNull();
    },
  );
});

describe('解釈できない入力', () => {
  it('RSS でも Atom でも RDF でもなければ ParseError', () => {
    expect(() => parseFeed('<html><body>404</body></html>')).toThrow(ParseError);
  });

  it('空の応答は ParseError', () => {
    expect(() => parseFeed('')).toThrow(ParseError);
  });

  it('XML ですらなければ ParseError', () => {
    expect(() => parseFeed('Not Found')).toThrow(ParseError);
  });

  it('多少崩れた XML は読める範囲で取り込む（現実のフィードは大抵どこか壊れている）', () => {
    const feed = parseFeed('<rss><channel><title>閉じ忘れ</channel></rss>');
    expect(feed.title).toBe('閉じ忘れ');
    expect(feed.items).toHaveLength(0);
  });
});

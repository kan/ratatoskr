import { describe, expect, it } from 'vitest';
import { ALLOW_ALL, DISALLOW_ALL, isAllowed, parseRobots, rulesForStatus } from './robots';

/**
 * robots.txt の解釈（RFC 9309）。例は RFC の本文と、実際のサイトでよく見る形から採った。
 */

const allowed = (body: string, url: string): boolean => isAllowed(parseRobots(body), url);

describe('parseRobots / isAllowed', () => {
  it('自分宛ての群があれば、* の群は見ない', () => {
    const body = `User-agent: *
Disallow: /

User-agent: Ratatoskr
Disallow: /private/`;
    expect(allowed(body, 'https://example.com/posts/1')).toBe(true);
    expect(allowed(body, 'https://example.com/private/1')).toBe(false);
  });

  it('自分宛ての群が無ければ * の群に従う', () => {
    const body = `User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /search`;
    expect(allowed(body, 'https://example.com/posts/1')).toBe(true);
    expect(allowed(body, 'https://example.com/search?q=a')).toBe(false);
  });

  it('連続する user-agent 行は 1 つの群になる', () => {
    const body = `User-agent: foo
User-agent: ratatoskr
Disallow: /a`;
    expect(allowed(body, 'https://example.com/a/1')).toBe(false);
  });

  it('同じ宛先の群が複数あれば合わせる', () => {
    const body = `User-agent: *
Disallow: /a

User-agent: *
Disallow: /b`;
    expect(allowed(body, 'https://example.com/a')).toBe(false);
    expect(allowed(body, 'https://example.com/b')).toBe(false);
    expect(allowed(body, 'https://example.com/c')).toBe(true);
  });

  it('最も長いパターンが勝ち、同じ長さなら allow が勝つ', () => {
    const body = `User-agent: *
Disallow: /news
Allow: /news/public
Disallow: /same
Allow: /same`;
    expect(allowed(body, 'https://example.com/news/secret')).toBe(false);
    expect(allowed(body, 'https://example.com/news/public/1')).toBe(true);
    expect(allowed(body, 'https://example.com/same')).toBe(true);
  });

  it('* と $ を解する', () => {
    const body = `User-agent: *
Disallow: /*.pdf$
Disallow: /tmp/*/draft`;
    expect(allowed(body, 'https://example.com/files/a.pdf')).toBe(false);
    expect(allowed(body, 'https://example.com/files/a.pdf?x=1')).toBe(true);
    expect(allowed(body, 'https://example.com/tmp/2026/draft/1')).toBe(false);
    expect(allowed(body, 'https://example.com/tmp/draft')).toBe(true);
  });

  it('中身の空の Disallow は何も禁じない', () => {
    expect(allowed('User-agent: *\nDisallow:', 'https://example.com/a')).toBe(true);
  });

  it('コメント・大文字小文字・CRLF を気にしない', () => {
    const body = 'USER-AGENT: *  # 全員\r\nDISALLOW: /a # ここは駄目\r\n';
    expect(allowed(body, 'https://example.com/a')).toBe(false);
  });

  it('パーセントエンコードの有無を同じものとして比べる', () => {
    const body = 'User-agent: *\nDisallow: /日本語';
    expect(allowed(body, 'https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E/1')).toBe(false);
  });

  it('robots.txt 自体は常に許す', () => {
    expect(allowed('User-agent: *\nDisallow: /', 'https://example.com/robots.txt')).toBe(true);
  });

  it('群に属さない規則は無視する', () => {
    expect(allowed('Disallow: /', 'https://example.com/a')).toBe(true);
  });

  it('* が並んだパターンでも時間がかからない', () => {
    const body = `User-agent: *\nDisallow: /${'*a'.repeat(50)}b`;
    const started = Date.now();
    expect(allowed(body, `https://example.com/${'a'.repeat(5000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('rulesForStatus', () => {
  it('2xx は本文を読み、4xx は全て許し、5xx と 429 は全て禁じる', () => {
    expect(rulesForStatus(200)).toBeNull();
    expect(rulesForStatus(404)).toEqual(ALLOW_ALL);
    expect(rulesForStatus(403)).toEqual(ALLOW_ALL);
    expect(rulesForStatus(429)).toEqual(DISALLOW_ALL);
    expect(rulesForStatus(503)).toEqual(DISALLOW_ALL);
  });
});

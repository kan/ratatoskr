import { describe, expect, it } from 'vitest';
import { bookmarkletFor, pendingSubscription } from './bookmarklet';

describe('pendingSubscription', () => {
  it('add に載った URL を取り出す', () => {
    const search = `?add=${encodeURIComponent('https://example.com/blog/')}`;
    expect(pendingSubscription(search)).toBe('https://example.com/blog/');
  });

  it('付いていなければ null', () => {
    expect(pendingSubscription('')).toBeNull();
    expect(pendingSubscription('?other=1')).toBeNull();
    expect(pendingSubscription('?add=')).toBeNull();
  });

  it('http / https 以外は捨てる', () => {
    // このパラメータは誰でも付けられる。そのまま登録の入力にしない
    expect(pendingSubscription('?add=javascript:alert(1)')).toBeNull();
    expect(pendingSubscription('?add=file:///etc/passwd')).toBeNull();
    expect(pendingSubscription('?add=' + encodeURIComponent('not a url'))).toBeNull();
  });
});

describe('bookmarkletFor', () => {
  it('自分の出どころ宛に、見ているページの URL を載せて開く', () => {
    const code = bookmarkletFor('https://reader.example.com');
    expect(code.startsWith('javascript:')).toBe(true);
    expect(code).toContain('https://reader.example.com/?add=');
    expect(code).toContain('encodeURIComponent(location.href)');
    // 読んでいたページから離れずに登録できる方がよい
    expect(code).toContain("'_blank'");
  });
});

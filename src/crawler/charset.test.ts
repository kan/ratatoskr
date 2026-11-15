import { describe, expect, it } from 'vitest';
import { bytesOf, EUCJP_NIHONGO, SJIS_NIHONGO } from '../test/bytes';
import { decodeMarkup } from './charset';

describe('decodeMarkup', () => {
  it('Content-Type の charset で読む（Shift_JIS）', () => {
    const bytes = bytesOf('<title>', SJIS_NIHONGO, '</title>');
    expect(decodeMarkup(bytes, 'text/html; charset=Shift_JIS')).toBe('<title>日本語</title>');
  });

  it('<meta charset> で読む（EUC-JP）', () => {
    const bytes = bytesOf('<meta charset="euc-jp"><title>', EUCJP_NIHONGO, '</title>');
    expect(decodeMarkup(bytes, 'text/html')).toContain('日本語');
  });

  it('http-equiv の宣言で読む', () => {
    const bytes = bytesOf(
      '<meta http-equiv="Content-Type" content="text/html; charset=x-sjis"><title>',
      SJIS_NIHONGO,
      '</title>',
    );
    expect(decodeMarkup(bytes, null)).toContain('日本語');
  });

  it('XHTML の XML の宣言で読む', () => {
    const bytes = bytesOf(
      '<?xml version="1.0" encoding="Shift_JIS"?>\n<html><title>',
      SJIS_NIHONGO,
      '</title>',
    );
    expect(decodeMarkup(bytes, 'application/xhtml+xml')).toContain('日本語');
  });

  it('XML は、HTTP の charset より文書の宣言を優先する', () => {
    // 既定の charset を一律に付けるサーバ。UTF-8 で書かれ、宣言も合っている
    const utf8 = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><t>日本語</t>');
    expect(decodeMarkup(utf8, 'text/xml; charset=ISO-8859-1')).toContain('日本語');
    // OPML を charset=utf-8 固定で送ってくるクライアント
    const sjis = bytesOf('<?xml version="1.0" encoding="Shift_JIS"?><t>', SJIS_NIHONGO, '</t>');
    expect(decodeMarkup(sjis, 'text/x-opml; charset=utf-8')).toContain('日本語');
  });

  it('XML の中の <meta> では読み替えない', () => {
    const rss = new TextEncoder().encode(
      '<rss><channel><item><description><![CDATA[<meta charset="euc-jp">日本語]]>' +
        '</description></item></channel></rss>',
    );
    expect(decodeMarkup(rss, 'application/rss+xml')).toContain('日本語');
  });

  it('宣言が UTF-16 でも、頭が ASCII で読めたなら UTF-8 として読む', () => {
    const xml = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-16"?><t>日本語</t>');
    expect(decodeMarkup(xml, 'application/rss+xml')).toContain('日本語');
    const html = new TextEncoder().encode('<meta charset="utf-16"><title>日本語</title>');
    expect(decodeMarkup(html, 'text/html')).toContain('日本語');
  });

  it('JSON は UTF-8 として読み、中の文字列の charset では読み替えない', () => {
    const json = new TextEncoder().encode('{"html":"<meta charset=euc-jp>","title":"日本語"}');
    expect(decodeMarkup(json, 'application/json; charset=utf-8')).toContain('日本語');
    expect(decodeMarkup(json, 'application/json')).toContain('日本語');
  });

  it('Content-Type の宣言を <meta> より優先する', () => {
    const bytes = bytesOf('<meta charset="euc-jp"><title>', SJIS_NIHONGO, '</title>');
    expect(decodeMarkup(bytes, 'text/html; charset=shift_jis')).toContain('日本語');
  });

  it('宣言が無ければ UTF-8、知らない名前でも UTF-8 に倒す', () => {
    const bytes = new TextEncoder().encode('<title>日本語</title>');
    expect(decodeMarkup(bytes, null)).toContain('日本語');
    expect(decodeMarkup(bytes, 'text/html; charset=no-such-charset')).toContain('日本語');
  });
});

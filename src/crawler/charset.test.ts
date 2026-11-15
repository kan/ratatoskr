import { describe, expect, it } from 'vitest';
import { bytesOf, EUCJP_NIHONGO, SJIS_NIHONGO } from '../test/bytes';
import { decodeHtml } from './charset';

describe('decodeHtml', () => {
  it('Content-Type の charset で読む（Shift_JIS）', () => {
    const bytes = bytesOf('<title>', SJIS_NIHONGO, '</title>');
    expect(decodeHtml(bytes, 'text/html; charset=Shift_JIS')).toBe('<title>日本語</title>');
  });

  it('<meta charset> で読む（EUC-JP）', () => {
    const bytes = bytesOf('<meta charset="euc-jp"><title>', EUCJP_NIHONGO, '</title>');
    expect(decodeHtml(bytes, 'text/html')).toContain('日本語');
  });

  it('http-equiv の宣言で読む', () => {
    const bytes = bytesOf(
      '<meta http-equiv="Content-Type" content="text/html; charset=x-sjis"><title>',
      SJIS_NIHONGO,
      '</title>',
    );
    expect(decodeHtml(bytes, null)).toContain('日本語');
  });

  it('XHTML の XML の宣言で読む', () => {
    const bytes = bytesOf(
      '<?xml version="1.0" encoding="Shift_JIS"?>\n<html><title>',
      SJIS_NIHONGO,
      '</title>',
    );
    expect(decodeHtml(bytes, 'application/xhtml+xml')).toContain('日本語');
  });

  it('Content-Type の宣言を <meta> より優先する', () => {
    const bytes = bytesOf('<meta charset="euc-jp"><title>', SJIS_NIHONGO, '</title>');
    expect(decodeHtml(bytes, 'text/html; charset=shift_jis')).toContain('日本語');
  });

  it('宣言が無ければ UTF-8、知らない名前でも UTF-8 に倒す', () => {
    const bytes = new TextEncoder().encode('<title>日本語</title>');
    expect(decodeHtml(bytes, null)).toContain('日本語');
    expect(decodeHtml(bytes, 'text/html; charset=no-such-charset')).toContain('日本語');
  });
});

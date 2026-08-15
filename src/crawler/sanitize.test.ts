import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './sanitize';

const BASE = 'https://example.com/posts/1';

describe('sanitizeHtml', () => {
  it('許可タグはそのまま残す', async () => {
    const html = '<p>本文<strong>強調</strong><br>改行</p><ul><li>項目</li></ul>';
    expect(await sanitizeHtml(html, BASE)).toBe(html);
  });

  it('script は中身ごと消す', async () => {
    const out = await sanitizeHtml('<p>前</p><script>alert(1)</script><p>後</p>', BASE);
    expect(out).toBe('<p>前</p><p>後</p>');
  });

  it('style・iframe も中身ごと消す', async () => {
    const out = await sanitizeHtml(
      '<style>p{color:red}</style><iframe src="x"></iframe><p>本文</p>',
      BASE,
    );
    expect(out).toBe('<p>本文</p>');
  });

  it('未知のタグはタグだけ剥がして中身を残す', async () => {
    const out = await sanitizeHtml('<font size="7">文字</font><marquee>流れる</marquee>', BASE);
    expect(out).toBe('文字流れる');
  });

  it('javascript: スキームの href を落とす', async () => {
    const out = await sanitizeHtml('<a href="javascript:alert(1)">危険</a>', BASE);
    expect(out).not.toContain('javascript:');
    expect(out).toContain('危険');
  });

  it('data: URL の画像を落とす', async () => {
    const out = await sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x">', BASE);
    expect(out).not.toContain('data:');
  });

  it('onerror などのイベント属性を落とす', async () => {
    const out = await sanitizeHtml(
      '<img src="https://example.com/a.png" onerror="alert(1)">',
      BASE,
    );
    expect(out).not.toContain('onerror');
    expect(out).toContain('src="https://example.com/a.png"');
  });

  it('相対 URL を記事の URL で解決する', async () => {
    const out = await sanitizeHtml('<a href="../about">紹介</a>', BASE);
    expect(out).toContain('href="https://example.com/about"');
  });

  it('base が無ければ相対 URL は捨てる（自分のオリジンに解決させない）', async () => {
    const out = await sanitizeHtml('<a href="/about">紹介</a>');
    expect(out).not.toContain('href');
  });

  it('img の width / height を落とす', async () => {
    const out = await sanitizeHtml('<img src="/a.png" width="800" height="600" alt="図">', BASE);
    expect(out).not.toContain('width');
    expect(out).not.toContain('height');
    expect(out).toContain('alt="図"');
  });

  it('リンクを別タブで開き、opener を渡さない', async () => {
    const out = await sanitizeHtml('<a href="https://other.example.com/">外部</a>', BASE);
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('class や style 属性を落とす', async () => {
    const out = await sanitizeHtml('<p class="x" style="color:red">本文</p>', BASE);
    expect(out).toBe('<p>本文</p>');
  });

  it('コメントを落とす', async () => {
    const out = await sanitizeHtml('<p>本文</p><!--[if IE]><script>x</script><![endif]-->', BASE);
    expect(out).toBe('<p>本文</p>');
  });

  it('空文字はそのまま空文字', async () => {
    expect(await sanitizeHtml('', BASE)).toBe('');
  });
});

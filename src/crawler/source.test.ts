import { describe, expect, it } from 'vitest';
import { asobiTicket } from './asobiticket';
import { idolmasterNews } from './idolmaster';
import { knownSource } from './source';

describe('knownSource', () => {
  it('既知のソースの URL を、末尾の / の有無によらず受け持つ', () => {
    expect(knownSource('https://idolmaster-official.jp/news')).toBe(idolmasterNews);
    expect(knownSource('https://idolmaster-official.jp/news/')).toBe(idolmasterNews);
    expect(knownSource('https://asobiticket2.asobistore.jp/booths/')).toBe(asobiTicket);
  });

  it('記事のページや別のホストは受け持たない', () => {
    expect(knownSource('https://idolmaster-official.jp/news/01_19877')).toBeNull();
    expect(knownSource('https://idolmaster-official.jp/')).toBeNull();
    expect(knownSource('https://asobiticket2.asobistore.jp/booths/x')).toBeNull();
    expect(knownSource('https://example.com/booths')).toBeNull();
    expect(knownSource('not a url')).toBeNull();
  });
});

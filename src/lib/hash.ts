/**
 * SHA-256 の 16 進文字列。crypto.subtle は Workers に標準で存在する。
 * 記事の同一性判定（guid_hash）と、304 を返さないサーバ向けの
 * content_hash の両方で使う。
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

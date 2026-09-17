/**
 * NHK ONE の偽物。トークンの発行と記事 JSON を返す（src/crawler/nhk.ts のテスト用）。
 *
 * 形（リダイレクトの順とクッキー、記事 JSON の欄と本文の書式）は実際の応答から採ったが、
 * 公開リポジトリに記事を置かないよう、中身は同じ形の作り物にしてある。
 */

const TOKEN = 'token-for-test';

export interface NhkStub {
  impl: typeof fetch;
  calls: string[];
}

/**
 * 発行口 → 認可サーバ → 戻り先 の 3 段をたどってトークンを発行し、記事 JSON を返す。
 *
 * **戻り先は、発行口が渡したクッキーを送り返されたときだけトークンを出す。**
 * 実際の発行口もそうで、クッキーを持ち越さない実装はここで落ちる。
 *
 * @param articles 記事 id → 記事 JSON。無い id は 404 になる
 */
export function stubNhk(
  articles: Record<string, unknown>,
  { authorize = true }: { authorize?: boolean } = {},
): NhkStub {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const headers = new Headers(init?.headers);
    const cookie = headers.get('cookie') ?? '';

    if (url.startsWith('https://news.web.nhk/tix/build_authorize')) {
      if (!authorize) return new Response('unavailable', { status: 503 });
      // 同意のクッキーが無ければ「利用の確認」へ戻される
      if (!cookie.includes('consentToUse=')) return new Response('confirm', { status: 200 });
      return redirect('https://r.authz.ac1.nhk/idp/authorize?client_id=x', [
        '__HOST-bff-code=code-verifier; path=/; secure; HttpOnly',
      ]);
    }
    if (url.startsWith('https://r.authz.ac1.nhk/')) {
      return redirect('https://news.web.nhk/tix/idpresponse?code=abc');
    }
    if (url.startsWith('https://news.web.nhk/tix/idpresponse')) {
      if (!cookie.includes('__HOST-bff-code=code-verifier')) {
        return new Response('bad state', { status: 400 });
      }
      return redirect('https://news.web.nhk/newsweb/', [
        'n_at=; max-age=0; domain=web.nhk; path=/',
        `z_at=${TOKEN}; max-age=2592000; domain=web.nhk; path=/`,
        '__HOST-bff-code=; max-age=0; path=/',
      ]);
    }

    const match = /\/newsarticle\/na\/(.+)\.json$/.exec(url);
    if (match !== null) {
      const article = articles[match[1]];
      if (article === undefined) return new Response('not found', { status: 404 });
      // トークンが無ければ本文の欄を落とす（実際の API と同じ）
      const authorized = headers.get('authorization') === `Bearer ${TOKEN}`;
      const { detailedArticleBody, ...rest } = article as Record<string, unknown>;
      return Response.json(authorized ? { ...rest, detailedArticleBody } : rest);
    }
    return new Response('unexpected', { status: 500 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

/** 記事 JSON。メイン画像とリード・本文の欄だけを持つ */
export function nhkArticle(
  lead: string,
  body: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'NewsArticle',
    image: { medium: { url: 'https://img.example.nhk/main_l.jpg' } },
    detailedArticleBody: { markedLead: lead, markedBody: body, ...extra },
  };
}

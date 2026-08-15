import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { authenticate, resetJwksCache, verifyAccessJwt, type AuthEnv } from './auth';

const TEAM_DOMAIN = 'ratatoskr.cloudflareaccess.com';
const AUD = 'aud-tag-under-test';
const KID = 'test-key-1';

const ENV: AuthEnv = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };

const keyPair = (await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair;

const publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: KID };

function encode(value: object): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface ClaimOverrides {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
}

async function issueJwt(overrides: ClaimOverrides = {}, header: object = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = encode({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const encodedPayload = encode({
    aud: AUD,
    iss: `https://${TEAM_DOMAIN}`,
    exp: now + 3600,
    iat: now,
    sub: 'user-1',
    email: 'kan@example.com',
    ...overrides,
  });
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  return `${encodedHeader}.${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

/** 公開鍵の配布だけを肩代わりする fetch。呼ばれた回数を数える */
function jwksFetch(keys: object[] = [publicJwk]): { fetch: typeof fetch; count: () => number } {
  let count = 0;
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    count += 1;
    const url = typeof input === 'string' ? input : String(input);
    expect(url).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return Response.json({ keys });
  };
  return { fetch: impl as unknown as typeof fetch, count: () => count };
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow(ApiError);
  await expect(promise).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
}

beforeEach(() => {
  resetJwksCache();
});

describe('verifyAccessJwt', () => {
  it('正しい JWT を受け入れる', async () => {
    const identity = await verifyAccessJwt(await issueJwt(), ENV, jwksFetch().fetch);
    expect(identity).toEqual({ subject: 'user-1', email: 'kan@example.com' });
  });

  it('aud が一致しなければ拒否する（同じチームの別アプリの JWT を通さない）', async () => {
    const token = await issueJwt({ aud: 'another-app' });
    await expectUnauthorized(verifyAccessJwt(token, ENV, jwksFetch().fetch));
  });

  it('aud が配列でも一致すれば受け入れる', async () => {
    const token = await issueJwt({ aud: ['another-app', AUD] });
    await expect(verifyAccessJwt(token, ENV, jwksFetch().fetch)).resolves.toMatchObject({
      subject: 'user-1',
    });
  });

  it('iss が一致しなければ拒否する', async () => {
    const token = await issueJwt({ iss: 'https://evil.cloudflareaccess.com' });
    await expectUnauthorized(verifyAccessJwt(token, ENV, jwksFetch().fetch));
  });

  it('期限切れは拒否する', async () => {
    const token = await issueJwt({ exp: Math.floor(Date.now() / 1000) - 3600 });
    await expectUnauthorized(verifyAccessJwt(token, ENV, jwksFetch().fetch));
  });

  it('署名が改竄されていれば拒否する', async () => {
    const token = await issueJwt();
    const [header, payload, signature] = token.split('.');
    const tampered = encode({ aud: AUD, iss: `https://${TEAM_DOMAIN}`, exp: 4102444800 });
    await expectUnauthorized(
      verifyAccessJwt(`${header}.${tampered}.${signature}`, ENV, jwksFetch().fetch),
    );
    await expectUnauthorized(verifyAccessJwt(`${header}.${payload}.xxxx`, ENV, jwksFetch().fetch));
  });

  it('alg を信用しない（alg=none を拒否する）', async () => {
    const token = await issueJwt({}, { alg: 'none' });
    await expectUnauthorized(verifyAccessJwt(token, ENV, jwksFetch().fetch));
  });

  it('対応する公開鍵が無ければ拒否する', async () => {
    const token = await issueJwt({}, { kid: 'unknown-kid' });
    await expectUnauthorized(verifyAccessJwt(token, ENV, jwksFetch().fetch));
  });

  it('JWT の形をしていなければ拒否する', async () => {
    await expectUnauthorized(verifyAccessJwt('not-a-jwt', ENV, jwksFetch().fetch));
  });

  it('署名部が base64url として壊れていても 401（500 にしない）', async () => {
    const [header, payload] = (await issueJwt()).split('.');
    await expectUnauthorized(verifyAccessJwt(`${header}.${payload}.@@@`, ENV, jwksFetch().fetch));
  });

  it('未知の kid で公開鍵を取り直し続けない', async () => {
    const jwks = jwksFetch();
    await verifyAccessJwt(await issueJwt(), ENV, jwks.fetch);
    expect(jwks.count()).toBe(1);

    // kid は署名検証前の値なので、要求元が自由に名乗れる。
    // でたらめな kid を投げられても外部への取得は増えない
    for (const kid of ['a', 'b', 'c']) {
      await expectUnauthorized(verifyAccessJwt(await issueJwt({}, { kid }), ENV, jwks.fetch));
    }
    expect(jwks.count()).toBe(1);
  });

  it('公開鍵をキャッシュする', async () => {
    const jwks = jwksFetch();
    await verifyAccessJwt(await issueJwt(), ENV, jwks.fetch);
    await verifyAccessJwt(await issueJwt(), ENV, jwks.fetch);
    expect(jwks.count()).toBe(1);
  });
});

describe('authenticate', () => {
  const request = (url: string, headers: HeadersInit = {}): Request =>
    new Request(url, { headers });

  it('Cf-Access-Jwt-Assertion ヘッダから読む', async () => {
    const token = await issueJwt();
    const identity = await authenticate(
      request('https://ratatoskr.example.com/api/bootstrap', {
        'cf-access-jwt-assertion': token,
      }),
      ENV,
      jwksFetch().fetch,
    );
    expect(identity.email).toBe('kan@example.com');
  });

  it('cookie の CF_Authorization からも読む', async () => {
    const token = await issueJwt();
    const identity = await authenticate(
      request('https://ratatoskr.example.com/api/bootstrap', {
        cookie: `other=1; CF_Authorization=${token}`,
      }),
      ENV,
      jwksFetch().fetch,
    );
    expect(identity.email).toBe('kan@example.com');
  });

  it('JWT が無ければ拒否する', async () => {
    await expectUnauthorized(
      authenticate(request('https://ratatoskr.example.com/api/bootstrap'), ENV, jwksFetch().fetch),
    );
  });
});

describe('ローカル開発のバイパス', () => {
  const bypassEnv: AuthEnv = { ...ENV, ACCESS_DEV_BYPASS: 'true' };

  it('localhost 宛かつフラグが立っていれば JWT 無しで通る', async () => {
    const identity = await authenticate(
      new Request('http://localhost:8787/api/bootstrap'),
      bypassEnv,
      jwksFetch().fetch,
    );
    expect(identity.subject).toBe('dev');
  });

  it('フラグが立っていても本番のホスト名では効かない', async () => {
    await expectUnauthorized(
      authenticate(
        new Request('https://ratatoskr.example.com/api/bootstrap'),
        bypassEnv,
        jwksFetch().fetch,
      ),
    );
  });

  it('フラグが無ければ localhost でも検証する', async () => {
    await expectUnauthorized(
      authenticate(new Request('http://localhost:8787/api/bootstrap'), ENV, jwksFetch().fetch),
    );
  });
});

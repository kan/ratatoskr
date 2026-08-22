import { ApiError, errorMessage } from './errors';

/**
 * Cloudflare Access（Zero Trust）による認証。
 *
 * アプリ側に認証コードを持たず、Access が付けた JWT を検証するだけにする
 * （docs/DESIGN.md §7）。公開鍵はチームドメインから取得して Worker 内にキャッシュする。
 */

/** Env のうち認証が使う分だけ。テストから最小の値を渡せるように切り出している */
export interface AuthEnv {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /**
   * ローカル開発用のバイパス。`pnpm dev` が --var で渡す（package.json）。
   * wrangler.jsonc の secrets.required に載せていないので、デプロイには含まれない。
   * 万一本番に紛れ込んでも効かないよう、localhost からの要求にしか適用しない
   */
  ACCESS_DEV_BYPASS?: string;
}

export interface AccessIdentity {
  /** JWT の sub。バイパス時は 'dev' */
  subject: string;
  email: string | null;
}

const JWKS_TTL = 3600; // 秒。鍵の入れ替えに追随できる程度に短くする
const JWKS_MIN_REFETCH = 60; // 秒。未知の kid での取り直しはこの間隔以上あける
const CLOCK_SKEW = 60; // 秒

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtPayload {
  aud: string[] | string;
  iss: string;
  exp: number;
  nbf?: number;
  sub?: string;
  email?: string;
}

let jwksCache: { issuer: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

/** テスト間でキャッシュを持ち越さないための入口。本番コードからは呼ばない */
export function resetJwksCache(): void {
  jwksCache = null;
}

/**
 * 要求元を認証する。失敗は全て 401 の ApiError。
 * 理由の切り分けはログに残し、クライアントには漏らさない。
 */
export async function authenticate(
  request: Request,
  env: AuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessIdentity> {
  if (isDevBypass(request, env)) {
    return { subject: 'dev', email: null };
  }

  const token = readToken(request);
  if (token === null) {
    throw unauthorized('Access の JWT が無い');
  }
  return verifyAccessJwt(token, env, fetchImpl);
}

/**
 * バイパスの条件は「フラグが立っている」ことと「localhost 宛の要求である」ことの
 * 両方。本番のホスト名で来た要求はフラグの状態に関わらず必ず検証する
 */
function isDevBypass(request: Request, env: AuthEnv): boolean {
  if (env.ACCESS_DEV_BYPASS !== 'true') return false;
  const { hostname } = new URL(request.url);
  return LOCAL_HOSTS.has(hostname);
}

function readToken(request: Request): string | null {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header !== null && header !== '') return header;

  // ブラウザからの通常アクセスでは cookie にも同じ JWT が入る
  const cookie = request.headers.get('cookie');
  if (cookie === null) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'CF_Authorization' && rest.length > 0) return rest.join('=');
  }
  return null;
}

export async function verifyAccessJwt(
  token: string,
  env: AuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('JWT の形式が不正');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const header = decodeJson<JwtHeader>(encodedHeader, 'ヘッダ');
  // Access は RS256 で署名する。alg を信用して分岐しない（alg=none 攻撃を塞ぐ）
  if (header.alg !== 'RS256') throw unauthorized(`未対応の alg: ${header.alg}`);
  if (typeof header.kid !== 'string') throw unauthorized('kid が無い');

  const issuer = issuerOf(env);
  const key = await resolveKey(header.kid, issuer, fetchImpl);
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  // 署名部が base64url として壊れていることもある。認証の失敗は全て 401 に揃える
  let signature: Uint8Array;
  try {
    signature = decodeBase64Url(encodedSignature);
  } catch {
    throw unauthorized('署名部が読めない');
  }
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!valid) throw unauthorized('署名が一致しない');

  const payload = decodeJson<JwtPayload>(encodedPayload, 'ペイロード');
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW < now) {
    throw unauthorized('期限切れ');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW > now) {
    throw unauthorized('まだ有効でない');
  }
  if (payload.iss !== issuer) {
    throw unauthorized(`iss が一致しない: ${payload.iss}`);
  }
  // aud の検証は必須。これを省くと同じチームの別アプリの JWT が通る（docs/DESIGN.md §7）
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(env.ACCESS_AUD)) {
    throw unauthorized('aud が一致しない');
  }

  return { subject: payload.sub ?? '', email: payload.email ?? null };
}

function issuerOf(env: AuthEnv): string {
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${domain}`;
}

async function resolveKey(
  kid: string,
  issuer: string,
  fetchImpl: typeof fetch,
): Promise<CryptoKey> {
  const now = Math.floor(Date.now() / 1000);
  const cached = jwksCache !== null && jwksCache.issuer === issuer ? jwksCache : null;
  const fresh = cached !== null && now - cached.fetchedAt < JWKS_TTL;

  const key = fresh ? cached.keys.get(kid) : undefined;
  if (key !== undefined) return key;

  // 未知の kid は鍵の入れ替え直後かもしれないので取り直す。ただし kid は署名を
  // 検証する前の値で、要求元が自由に名乗れる。でたらめな kid を投げ続けるだけで
  // 外部への取得を誘発できてしまうため、取り直しの間隔に下限を設ける
  if (cached !== null && now - cached.fetchedAt < JWKS_MIN_REFETCH) {
    throw unauthorized(`kid ${kid} に対応する公開鍵が無い（再取得は待機中）`);
  }

  const keys = await fetchJwks(issuer, fetchImpl);
  jwksCache = { issuer, keys, fetchedAt: now };

  const refreshed = keys.get(kid);
  if (refreshed === undefined) throw unauthorized(`kid ${kid} に対応する公開鍵が無い`);
  return refreshed;
}

// Workers の JsonWebKey 型は kid を持たないので足す
type AccessJwk = JsonWebKey & { kid?: string };

interface JwksResponse {
  keys?: AccessJwk[];
}

async function fetchJwks(issuer: string, fetchImpl: typeof fetch): Promise<Map<string, CryptoKey>> {
  let response: Response;
  try {
    response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw unauthorized(`公開鍵の取得に失敗: ${errorMessage(err)}`);
  }
  if (!response.ok) throw unauthorized(`公開鍵の取得に失敗: HTTP ${response.status}`);

  const body: unknown = await response.json();
  if (!isJwksResponse(body)) throw unauthorized('公開鍵の応答が不正');

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (typeof jwk.kid !== 'string') continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        ),
      );
    } catch (err) {
      // 1 本読めなくても他の鍵で検証できる可能性があるので続ける
      console.error('access jwk import failed', jwk.kid, err);
    }
  }
  if (keys.size === 0) throw unauthorized('利用できる公開鍵が無い');
  return keys;
}

function isJwksResponse(value: unknown): value is JwksResponse {
  if (typeof value !== 'object' || value === null) return false;
  const keys = (value as { keys?: unknown }).keys;
  return keys === undefined || Array.isArray(keys);
}

function decodeJson<T>(segment: string, label: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment))) as T;
  } catch {
    throw unauthorized(`JWT の${label}が読めない`);
  }
}

function decodeBase64Url(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function unauthorized(reason: string): ApiError {
  // 失敗の理由はログにだけ残す。クライアントには一律の文言を返す
  console.warn('access denied:', reason);
  return new ApiError('unauthorized', '認証が必要', 401);
}

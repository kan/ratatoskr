import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * 本番デプロイに要る「アカウント固有の値」を、追跡していないファイルから組み立てる。
 *
 * **このリポジトリは公開なので、wrangler.jsonc にアカウント固有の値を書かない。**
 * 値は環境変数か .prod.vars（git 管理外）から取り、次の 2 つを生成する。
 *
 *   1. wrangler.deploy.json … wrangler.jsonc に D1 の database_id を差し込んだ設定。
 *      デプロイ時に database_id は必須で、名前だけでは解決されない
 *   2. .wrangler/deploy-secrets.env … secret（wrangler deploy --secrets-file に渡す）
 *
 * secret を毎回渡すのは、**Worker を作り直したときに 1 コマンドで戻せるようにする**ため。
 * wrangler.jsonc に secret 名を宣言してあると、デプロイは前の版から値を引き継ごうとする。
 * Worker が消えていると引き継ぎ元が無く `no previous version exists` で止まるので、
 * 新規アカウントでの初回デプロイと、消してしまった後の復旧が詰む。
 */

const SOURCE = 'wrangler.jsonc';
const LOCAL_VARS = '.prod.vars';
const CONFIG_OUT = 'wrangler.deploy.json';
const SECRETS_OUT = '.wrangler/deploy-secrets.env';
const DATABASE_ID = 'D1_DATABASE_ID';

/** .prod.vars（dotenv 形式）を読む。無くても環境変数だけで動く */
function readLocalVars() {
  const values = new Map();
  let text;
  try {
    text = readFileSync(LOCAL_VARS, 'utf8');
  } catch {
    return values;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null) values.set(match[1], match[2].replace(/^["']|["']$/g, ''));
  }
  return values;
}

/** wrangler.jsonc を読む。行頭コメント（// …）だけを落とせば JSON として読める */
function readConfig(path) {
  const source = readFileSync(path, 'utf8');
  const json = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return JSON.parse(json);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const local = readLocalVars();
/** 環境変数が優先。CI や一時的な差し替えのため */
const valueOf = (key) => process.env[key] ?? local.get(key);

const config = readConfig(SOURCE);
const d1 = config.d1_databases?.[0];
if (d1 === undefined) fail(`${SOURCE} に d1_databases が無い`);

const databaseId = valueOf(DATABASE_ID);
if (databaseId === undefined || databaseId === '') {
  fail(
    `${DATABASE_ID} が無い。${LOCAL_VARS} に次の 1 行を置くか、環境変数で渡す:\n` +
      `  ${DATABASE_ID}=<wrangler d1 create ratatoskr が出力した id>\n` +
      '（アカウント固有の値なので git には入れない。README「デプロイ」を参照）',
  );
}
d1.database_id = databaseId;

// secret の名前は wrangler.jsonc の secrets.required が正。ここに一覧を持たない
const required = config.secrets?.required ?? [];
const missing = required.filter((name) => valueOf(name) === undefined);
if (missing.length > 0) {
  fail(
    `secret の値が ${LOCAL_VARS} にも環境変数にも無い: ${missing.join(', ')}\n` +
      `  ${LOCAL_VARS} に「名前=値」の行を足す。値がまだ分からない段階なら「名前=」と空で置いてよい\n` +
      '（空で上げると /api/* は全て 401 になる。Access の設定後に入れ直す）',
  );
}
const secrets = required.map((name) => `${name}=${valueOf(name)}`).join('\n');

// どちらも生成物。手で直しても次のデプロイで消える
writeFileSync(CONFIG_OUT, `${JSON.stringify(config, null, 2)}\n`);
mkdirSync('.wrangler', { recursive: true });
writeFileSync(SECRETS_OUT, `${secrets}\n`);

const empty = required.filter((name) => valueOf(name) === '');
if (empty.length > 0) console.warn(`空のまま上げる secret: ${empty.join(', ')}`);
console.log(`${CONFIG_OUT} と ${SECRETS_OUT} を生成した（${SOURCE} + ${LOCAL_VARS}）`);

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * 本番デプロイに要る「アカウント固有の値」を、追跡していないファイルから組み立てる。
 *
 * **このリポジトリは公開なので、wrangler.jsonc にアカウント固有の値を書かない。**
 * 値は環境変数か .prod.vars（git 管理外）から取り、wrangler.deploy.json を生成する。
 * 差し込むのは 2 種類。
 *
 *   1. D1 の database_id … デプロイ時に必須で、データベース名だけでは解決されない
 *   2. vars の中身 … Access の検証に使う 2 つ（名前は wrangler.jsonc の vars が正で、
 *      Env の型もそこから生成される）。**デプロイのたびに必ず渡す**ので、Worker ごと
 *      消しても .prod.vars さえあれば 1 コマンドで戻せる
 *
 * **Deploy to Cloudflare ボタン経由でもここを通る。** あちらは D1 を先に用意して
 * 設定ファイルへ id を書き戻すので、手元の .prod.vars が無くてもデプロイできる。
 * vars の値はビルドの環境変数から拾い、無ければ空のまま上げる（README「ボタンで入れる」）。
 *
 * **マイグレーションが deploy に入っている**（package.json）のもボタンのため。あちらは
 * `deploy` しか呼ばないので、外に出すと空の D1 に新しいコードが向かう。当てる先は
 * データベース名ではなく**バインディング名**（`DB`）。クローン先では名前が変わり得るが、
 * バインディングはリポジトリ側が決めるので変わらない。
 */

const SOURCE = 'wrangler.jsonc';
const LOCAL_VARS = '.prod.vars';
const CONFIG_OUT = 'wrangler.deploy.json';
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

// 設定ファイルに id が入っているのは Deploy to Cloudflare ボタン経由のとき。
// あちらは D1 をプロビジョニングし、クローンしたリポジトリの wrangler 設定へ
// id を書き戻すので、手元の .prod.vars にあたるものが無くてもデプロイできる
const localDatabaseId = valueOf(DATABASE_ID);
/** 手元の設定から組み立てているか。ボタン経由なら false */
const selfHosted = localDatabaseId !== undefined;
const databaseId = localDatabaseId ?? d1.database_id;
if (databaseId === undefined || databaseId === '') {
  fail(
    `${DATABASE_ID} が無い。${LOCAL_VARS} に次の 1 行を置くか、環境変数で渡す:\n` +
      `  ${DATABASE_ID}=<wrangler d1 create ratatoskr が出力した id>\n` +
      '（アカウント固有の値なので git には入れない。README「デプロイ」を参照）',
  );
}
d1.database_id = databaseId;

// vars の名前は wrangler.jsonc が正。ここに一覧を持たない
const names = Object.keys(config.vars ?? {});
const missing = names.filter((name) => valueOf(name) === undefined);
// 手元から組み立てているのに値が無いのは、たいてい .prod.vars の書き忘れ。そこで止める。
// ボタン経由では値の置き場がビルドの設定しか無く、初回は当然まだ入っていないので進める
if (missing.length > 0 && selfHosted) {
  fail(
    `vars の値が ${LOCAL_VARS} にも環境変数にも無い: ${missing.join(', ')}\n` +
      `  ${LOCAL_VARS} に「名前=値」の行を足す。値がまだ分からない段階なら「名前=」と空で置いてよい\n` +
      '（空で上げると /api/* は全て 401 になる。Access の設定後に入れ直す）',
  );
}
for (const name of names) config.vars[name] = valueOf(name) ?? '';

// 生成物。手で直しても次のデプロイで消える
writeFileSync(CONFIG_OUT, `${JSON.stringify(config, null, 2)}\n`);

const empty = names.filter((name) => config.vars[name] === '');
if (empty.length > 0) console.warn(`空のまま上げる: ${empty.join(', ')}`);
const from = selfHosted ? LOCAL_VARS : 'ビルドの環境変数';
console.log(`${CONFIG_OUT} を生成した（${SOURCE} + ${from}）`);

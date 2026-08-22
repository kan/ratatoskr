import { readFileSync, writeFileSync } from 'node:fs';

/**
 * 本番デプロイ用の設定を組み立てる。
 *
 * **このリポジトリは公開なので、アカウント固有の値を wrangler.jsonc に書かない。**
 * D1 の database_id はデプロイ時に必須（wrangler は名前だけでは解決しない）なので、
 * 追跡している設定に手元の値を差し込んだものを .wrangler/ に書き出し、
 * `wrangler deploy -c` にそれを渡す。
 *
 * 値の出どころは 2 つ。環境変数が優先で、無ければ .prod.vars（git 管理外）。
 *
 * 生成先はリポジトリのルート（git 管理外）。wrangler は main や assets.directory を
 * **設定ファイルの場所を基準に**解決するので、別のディレクトリに置くと軒並み外れる。
 */

const SOURCE = 'wrangler.jsonc';
const LOCAL_VARS = '.prod.vars';
const OUTPUT = 'wrangler.deploy.json';
const KEY = 'D1_DATABASE_ID';

/** .prod.vars（dotenv 形式）から 1 つ読む。無くても環境変数があればよい */
function fromLocalVars(key) {
  let text;
  try {
    text = readFileSync(LOCAL_VARS, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === key) return match[2].replace(/^["']|["']$/g, '');
  }
  return undefined;
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

const databaseId = process.env[KEY] ?? fromLocalVars(KEY);
if (databaseId === undefined || databaseId === '') {
  console.error(
    `${KEY} が無い。${LOCAL_VARS} に次の 1 行を置くか、環境変数で渡す:\n` +
      `  ${KEY}=<wrangler d1 create ratatoskr が出力した id>\n` +
      '（この値はアカウント固有なので git には入れない。README「デプロイ」を参照）',
  );
  process.exit(1);
}

const config = readConfig(SOURCE);
const d1 = config.d1_databases?.[0];
if (d1 === undefined) {
  console.error(`${SOURCE} に d1_databases が無い`);
  process.exit(1);
}
d1.database_id = databaseId;

// 生成物なので、手で直しても次のデプロイで消える
writeFileSync(OUTPUT, `${JSON.stringify(config, null, 2)}\n`);
console.log(`${OUTPUT} を生成した（${SOURCE} + ${KEY}）`);

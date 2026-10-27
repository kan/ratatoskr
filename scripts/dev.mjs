import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * 開発サーバを起動する。画面（vite）と API（wrangler dev）の 2 プロセス構成。
 *
 * **API のポートは起動のたびに空いているものを選ぶ。** 8787 に固定すると、他の
 * Workers のプロジェクトの wrangler dev と同時に動かせない。デバッガのポート
 * （既定 9229）も同じ理由で選ぶ。選んだポートは vite の /api の転送先として
 * 環境変数 `RATATOSKR_API_PORT` で渡す（web/vite.config.ts）。
 *
 * 画面のポートは 2 通り。
 *
 *   - `pnpm dev:roji`（`roji run` の下）… roji が選んだ `PORT` で待ち、
 *     `https://ratatoskr.<roji のドメイン>` で開く。roji はそのポートへ転送するので、
 *     **動かれると繋がらない。** 使用中なら起動に失敗させる（`--strictPort`）
 *   - `pnpm dev` … vite の設定どおり 5173。埋まっていれば vite が次へ逃げる
 *
 * Access の検証を飛ばす `ACCESS_DEV_BYPASS` はここで渡す（wrangler.jsonc の vars に
 * 載せるとデプロイに含まれるため）。roji の URL で開いたときにも効く理由は
 * web/vite.config.ts の `/api` の転送設定に書いてある。
 */

/** 互いに重ならない空きポートを `count` 個。全部を選び終えるまで握っておく */
async function freePorts(count) {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise((resolve, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolve(server));
        }),
    ),
  );
  const ports = servers.map((server) => String(server.address().port));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

const underRoji = Boolean(process.env.ROJI_URL && process.env.PORT);
const viteArgs = underRoji ? ['--port', process.env.PORT, '--strictPort'] : [];

// roji の PORT は roji が握っていない（vite が待ち受けるまで空いている）ので、
// OS が同じ番号を返すことがある。重なったら選び直す
let apiPort, inspectorPort;
do {
  [apiPort, inspectorPort] = await freePorts(2);
} while (underRoji && [apiPort, inspectorPort].includes(process.env.PORT));

const windows = process.platform === 'win32';
// npm / pnpm の shim は Windows では .cmd なので、シェル経由でないと起動できない
const shell = windows;

const children = [
  // キーボードを読むのは wrangler だけにする。2 つで読むと打鍵が取り合いになる。
  // 待ち受け先を 127.0.0.1 に固定するのは、空きを確かめた先と vite の転送先に合わせるため
  // （既定の localhost だと、環境によっては ::1 側だけで待ち受ける）
  // 実体はパスで指す。pnpm を通さずに起動すると node_modules/.bin が PATH に無い
  spawn(
    join('node_modules', '.bin', 'wrangler'),
    [
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      apiPort,
      '--inspector-port',
      inspectorPort,
      '--var',
      'ACCESS_DEV_BYPASS:true',
    ],
    { stdio: 'inherit', shell },
  ),
  // **vite は pnpm を挟まずに起動する。** 挟むと pnpm → sh → vite の孫になり、
  // 止める合図が vite まで届かない（wrangler だけが落ちたとき、vite がポートを握ったまま残った）
  spawn(join('node_modules', '.bin', 'vite'), viteArgs, {
    cwd: 'web',
    stdio: ['ignore', 'inherit', 'inherit'],
    shell,
    env: { ...process.env, RATATOSKR_API_PORT: apiPort },
  }),
];

/**
 * 子を止める。Windows はシェル（cmd.exe）経由で起動しているので、cmd.exe だけを止めると
 * その下のサーバが残る。プロセスの木ごと止める
 */
function kill(child, signal) {
  if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill(signal);
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) kill(child, 'SIGTERM');
  // SIGTERM を無視するサーバにポートを握らせたままにしない
  setTimeout(() => {
    for (const child of children) kill(child, 'SIGKILL');
  }, 5000).unref();
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(error);
    stop(1);
  });
  // 片方だけでは動かない（画面だけでは /api が繋がらず、API だけでは開く画面が無い）。
  // Ctrl+C は子にも同時に届くので、子がそれで終わったのは正常終了として扱う
  // （親の SIGINT の処理より先にこちらが走ると、止めただけで失敗に見える）
  child.once('exit', (code, signal) => stop(signal === 'SIGINT' || code === 130 ? 0 : (code ?? 1)));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));

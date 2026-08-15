/**
 * D1 への疎通確認。SQL は src/db/ の外に書かないという規約に従い、
 * health 用の 1 文もここに置く。
 */
export async function ping(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return row?.ok === 1;
  } catch (err) {
    // 疎通確認自体の失敗はレスポンスで表現するので、ここでは記録だけして握らない
    console.error('d1 ping failed', err);
    return false;
  }
}

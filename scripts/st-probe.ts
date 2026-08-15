// TEMPORARY Phase-0 probe (deleted before commit). READ-ONLY.
import { loadRootEnv } from '../apps/api/src/env.js';
import { makePool } from '../apps/api/src/db.js';

loadRootEnv();

async function probe(label: string, url: string | undefined): Promise<void> {
  if (!url) return console.log(`${label}: (unset)`);
  console.log(`\n=== ${label} ===`);
  const pool = makePool(url);
  const safe = async (name: string, fn: () => Promise<string>) => {
    try {
      console.log(`  ${name}: ${await fn()}`);
    } catch (e) {
      console.log(`  ${name}: ERROR ${(e as Error).message}`);
    }
  };
  await safe('orders total / by status', async () => {
    const { rows } = await pool.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM standing_orders GROUP BY status`,
    );
    const total = rows.reduce((n, r) => n + Number(r.n), 0);
    return `${total} total (${rows.map((r) => `${r.status}=${r.n}`).join(', ') || 'none'})`;
  });
  await safe('orders whose room has an ACTIVE briefing', async () => {
    const { rows } = await pool.query<{ n: string; total: string }>(
      `SELECT count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM room_briefings b
                 WHERE b.room_id = o.room_id AND b.cleared_at IS NULL)) AS n,
              count(*) AS total
         FROM standing_orders o`,
    );
    return `${rows[0].n}/${rows[0].total}`;
  });
  await safe('order.created events ever', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE event_type = 'order.created'`,
    );
    return rows[0].n;
  });
  await safe('standing_orders columns', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'standing_orders' ORDER BY ordinal_position`,
    );
    return rows.map((r) => r.column_name).join(', ');
  });
  await safe('tasks carrying an order-rooted intent (sample)', async () => {
    const { rows } = await pool.query<{ intent: string; n: string }>(
      `SELECT intent, count(*) AS n FROM tasks WHERE intent LIKE 'standing order%' GROUP BY intent LIMIT 3`,
    );
    return rows.map((r) => `${r.n}× "${r.intent}"`).join(' | ') || '(none)';
  });
  await pool.end();
}

async function main(): Promise<void> {
  await probe('PROD (DATABASE_URL)', process.env.DATABASE_URL);
  await probe('TEST (TEST_DATABASE_URL)', process.env.TEST_DATABASE_URL);
}
void main();

import { loadEnvironment } from '../src/config/env.js';
import { getRuntimePool, closePools } from '../src/db/pools.js';
import { createContext } from '../src/shared/correlation.js';
import { refundCapturedOrderItem, releaseReservation, reverseTopup } from '../src/domain/wallet/service.js';

if (process.env.CONFIRM_PRELAUNCH_CLOSEOUT !== 'I_UNDERSTAND_COMPENSATING_TRANSACTIONS') {
  throw new Error('Set CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS after Owner review');
}
const env = loadEnvironment();
const pool = getRuntimePool(env);
const context = (key) => createContext({ actorType: 'OWNER', actorId: env.OWNER_ID,
  guildId: env.DISCORD_GUILD_ID, idempotencyKey: `prelaunch-closeout:${key}` });
const report = { released: 0, refundedCaptured: 0, reversedTopups: 0, failures: [] };
try {
  const reserved = (await pool.query(`SELECT i.id FROM order_items i JOIN orders o ON o.id=i.order_id
    JOIN wallet_reservations r ON r.order_item_id=i.id WHERE o.prelaunch=true AND r.state='RESERVED'`)).rows;
  for (const item of reserved) {
    try { await releaseReservation({ orderItemId: item.id, terminalState: 'STOPPED_RELEASED',
      reason: 'PRELAUNCH_CLOSEOUT' }, context(`release:${item.id}`), { pool }); report.released += 1; }
    catch (error) { report.failures.push({ itemId: item.id, code: error.code ?? error.name }); }
  }
  const captured = (await pool.query(`SELECT i.id,r.state_version FROM order_items i
    JOIN orders o ON o.id=i.order_id JOIN wallet_reservations r ON r.order_item_id=i.id
    WHERE o.prelaunch=true AND r.state='CAPTURED'`)).rows;
  for (const item of captured) {
    try { await refundCapturedOrderItem({ orderItemId: item.id,
      expectedReservationVersion: item.state_version, reason: 'PRELAUNCH_CAPTURE_COMPENSATION' },
    context(`capture-refund:${item.id}`), { pool }); report.refundedCaptured += 1; }
    catch (error) { report.failures.push({ itemId: item.id, code: error.code ?? error.name }); }
  }
  const topups = (await pool.query("SELECT id FROM topups WHERE prelaunch=true AND status='CREDITED'")).rows;
  for (const topup of topups) {
    try { const result = await reverseTopup({ topupId: topup.id, reason: 'PRELAUNCH_CLOSEOUT' },
      context(`topup-reversal:${topup.id}`), { pool });
    if (result.status === 'REVERSED') report.reversedTopups += 1;
    else report.failures.push({ topupId: topup.id, code: 'REVERSAL_MANUAL_REVIEW' }); }
    catch (error) { report.failures.push({ topupId: topup.id, code: error.code ?? error.name }); }
  }
  console.log(JSON.stringify(report));
  if (report.failures.length) throw new Error('Pre-launch closeout requires manual review');
} finally { await closePools(); }

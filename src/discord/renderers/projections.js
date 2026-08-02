import { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { decryptSecret } from '../../adapters/crypto/keyring.js';
import { supportCode } from '../../shared/correlation.js';

const color = { pending: 0xf0b232, success: 0x23a55a, failure: 0xf23f43, info: 0x5865f2 };
const escape = (value) => escapeMarkdown(String(value ?? 'ไม่ระบุ').replaceAll('@', '@\u200b')).slice(0, 1000);
const baht = (cents) => `${(Number(cents ?? 0) / 100).toFixed(2)} บาท`;

export async function renderProjection(pool, projection, { env, client } = {}) {
  if (projection.projection_type === 'REFUND_LOG') {
    const refund = (await pool.query(`SELECT f.*,i.order_id,i.quest_id,i.quest_name,
      w.available_before_cents,w.available_after_cents,w.id AS transaction_id
      FROM refunds f JOIN order_items i ON i.id=f.order_item_id
      JOIN wallet_transactions w ON w.id=f.wallet_transaction_id WHERE f.id=$1`,
    [projection.aggregate_id])).rows[0];
    const user = await client.users.fetch(refund.discord_user_id).catch(() => null);
    const embed = new EmbedBuilder().setColor(color.success).setTitle('↩️ คืนเงิน Order Item')
      .setDescription(`**ผู้ได้รับเงินคืน:** <@${refund.discord_user_id}> (\`${refund.discord_user_id}\`)\n**Order:** \`${refund.order_id}\`\n**Item:** \`${refund.order_item_id}\`\n**Quest:** ${escape(refund.quest_name)} (\`${escape(refund.quest_id)}\`)\n**จำนวน:** ${baht(refund.amount_cents)}\n**Wallet ก่อน/หลัง:** ${baht(refund.available_before_cents)} → ${baht(refund.available_after_cents)}\n**เหตุผล:** ${escape(refund.reason)}\n**ดำเนินการโดย:** <@${refund.actor_id}> (\`${refund.actor_id}\`)\n**Refund ID:** \`${refund.id}\`\n**Wallet transaction:** \`${refund.transaction_id}\`\n**Trace:** \`${refund.trace_id}\``)
      .setTimestamp(refund.created_at);
    if (user) embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
    const mentions = [refund.discord_user_id];
    if (/^\d{17,20}$/.test(refund.actor_id)) mentions.push(refund.actor_id);
    return { embeds: [embed], allowedMentions: { users: mentions, parse: [] } };
  }
  if (projection.projection_type === 'TOPUP_RECEIPT') {
    const topup = (await pool.query(`SELECT t.*,w.available_cents FROM topups t
      JOIN wallets w ON w.discord_user_id=t.discord_user_id WHERE t.id=$1`, [projection.aggregate_id])).rows[0];
    return { embeds: [new EmbedBuilder().setColor(color.success).setTitle('ใบเสร็จเติมเงิน Questshop')
      .setDescription(`**Top-up ID:** \`${topup.id}\`\n**Provider transaction:** \`${escape(topup.provider_transaction_id)}\`\n**เงินต้น:** ${baht(topup.amount_cents)}\n**โบนัส:** ${baht(topup.bonus_cents)}\n**ยอดคงเหลือ:** ${baht(topup.available_cents)}`)
      .setFooter({ text: 'ใบเสร็จ Discord Embed — ไม่ใช่ใบกำกับภาษี' }).setTimestamp(topup.credited_at)],
    allowedMentions: { parse: [] } };
  }
  if (projection.projection_type === 'ORDER_DM') {
    const aggregate = (await pool.query(`SELECT a.*,o.id,o.account_username FROM order_aggregates a
      JOIN orders o ON o.id=a.order_id WHERE a.order_id=$1`, [projection.aggregate_id])).rows[0];
    return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('สรุป Order Questshop')
      .setDescription(`**Order ID:** \`${aggregate.id}\`\n**บัญชี:** ${escape(aggregate.account_username)}\n**ทั้งหมด:** ${aggregate.total_items}\n**สำเร็จ:** ${aggregate.captured_items}\n**คืนยอด:** ${aggregate.released_items}\n**ตรวจสอบ:** ${aggregate.review_items}`)],
    allowedMentions: { parse: [] } };
  }
  if (['PAYMENT_LOG', 'PAYMENT_STATUS_LOG'].includes(projection.projection_type)) {
    const topup = (await pool.query(`SELECT t.*,p.key_version,p.nonce,p.ciphertext,p.auth_tag,
      r.encrypted_phone,r.encryption_key_version,r.nonce AS receiver_nonce,r.auth_tag AS receiver_auth_tag,
      (SELECT count(*)::integer FROM payment_attempts a WHERE a.topup_id=t.id) AS attempts,
      l.available_before,l.available_after,l.reserved_before,l.reserved_after,l.id AS wallet_transaction_id
      FROM topups t LEFT JOIN topup_sensitive_payloads p ON p.topup_id=t.id
      JOIN receiver_versions r ON r.id=t.receiver_version_id
      LEFT JOIN LATERAL (SELECT w.* FROM wallet_transactions w WHERE w.reference_type='TOPUP'
        AND w.reference_id=t.id ORDER BY w.created_at DESC LIMIT 1) l ON true
      WHERE t.id=$1`, [projection.aggregate_id])).rows[0];
    const sensitive = topup.key_version == null ? null : JSON.parse(decryptSecret({
      keyVersion: topup.key_version, nonce: topup.nonce,
      ciphertext: topup.ciphertext, authTag: topup.auth_tag }, env.DATA_ENCRYPTION_KEYS_JSON,
    `topup:${topup.id}:${env.DISCORD_GUILD_ID}`));
    const receiverPhone = decryptSecret({ keyVersion: topup.encryption_key_version,
      nonce: topup.receiver_nonce, ciphertext: topup.encrypted_phone, authTag: topup.receiver_auth_tag },
    env.DATA_ENCRYPTION_KEYS_JSON, `receiver:${topup.receiver_version_id}:${env.DISCORD_GUILD_ID}`);
    const user = await client.users.fetch(topup.discord_user_id).catch(() => null);
    const embed = new EmbedBuilder().setColor(topup.status === 'CREDITED' ? color.success : color.failure)
      .setTitle(topup.status === 'CREDITED' ? '✅ เติมเงินสำเร็จ' : `⚠️ Top-up ${escape(topup.status)}`)
      .setDescription(`**ผู้เติม:** <@${topup.discord_user_id}> (\`${topup.discord_user_id}\`)\n**Top-up ID:** \`${topup.id}\`\n**Provider transaction:** \`${escape(topup.provider_transaction_id)}\`\n**Wallet transaction:** \`${escape(topup.wallet_transaction_id)}\`\n**ยอดเงินต้น:** ${baht(topup.amount_cents)}\n**โบนัส:** ${baht(topup.bonus_cents)}\n**Wallet ก่อน/หลัง:** ${baht(topup.available_before)} → ${baht(topup.available_after)}\n**Reserved ก่อน/หลัง:** ${baht(topup.reserved_before)} → ${baht(topup.reserved_after)}\n**Attempts:** ${topup.attempts}\n**Receiver snapshot:** \`${receiverPhone}\`\n**เจ้าของซอง:** ${escape(topup.sender_name)} / ${escape(topup.sender_phone)}\n**ลิงก์ซอง:** ${sensitive?.url ?? 'encrypted payload ถูกลบตามอายุข้อมูลแล้ว'}\n**Warning/Error:** ${escape(topup.warning_code ?? topup.failure_code)}`)
      .setTimestamp(topup.updated_at);
    if (user) embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
    return { embeds: [embed], allowedMentions: { users: [topup.discord_user_id], parse: [] } };
  }
  if (projection.projection_type === 'QUEST_NEW') {
    const quest = (await pool.query(`SELECT q.*,resolved.amount_cents AS price_cents FROM quests q
      LEFT JOIN LATERAL (SELECT p.amount_cents FROM price_rules p WHERE p.enabled=true
        AND (p.starts_at IS NULL OR p.starts_at<=clock_timestamp())
        AND (p.ends_at IS NULL OR p.ends_at>clock_timestamp()) AND (
          (p.rule_type='TEMPORARY' AND (p.quest_id IS NULL OR p.quest_id=q.quest_id)
            AND (p.task_type IS NULL OR p.task_type=q.task_type)) OR
          (p.rule_type='QUEST' AND p.quest_id=q.quest_id) OR
          (p.rule_type='TYPE' AND p.task_type=q.task_type) OR p.rule_type='DEFAULT')
        ORDER BY CASE p.rule_type WHEN 'TEMPORARY' THEN 1 WHEN 'QUEST' THEN 2
          WHEN 'TYPE' THEN 3 ELSE 4 END,p.priority DESC,p.created_at DESC LIMIT 1) resolved ON true
      WHERE q.quest_id=$1`, [projection.aggregate_id])).rows[0];
    const embed = new EmbedBuilder().setColor(color.info).setTitle(escape(quest.name))
      .setDescription(`**Quest ID:** \`${escape(quest.quest_id)}\`\n**ประเภท:** ${escape(quest.task_type)}\n**เป้าหมาย:** ${escape(quest.task_target)}\n**Orbs:** ${quest.orbs ?? 'ไม่ระบุ'}\n**ราคา:** ${quest.price_cents == null ? 'ยังไม่กำหนด' : baht(quest.price_cents)}\n**สถานะซื้อ:** ${escape(quest.sale_state)}\n**ตรวจพบ:** <t:${Math.floor(new Date(quest.detected_at).getTime() / 1000)}:F>\n**อัปเดต:** <t:${Math.floor(new Date(quest.updated_at).getTime() / 1000)}:R>\n**หมดอายุ:** ${quest.expires_at ? `<t:${Math.floor(new Date(quest.expires_at).getTime() / 1000)}:F>` : 'ไม่ระบุ'}`)
      .setTimestamp(quest.updated_at);
    if (quest.url) embed.setURL(quest.url);
    if (quest.artwork_url) embed.setImage(quest.artwork_url);
    return { embeds: [embed], allowedMentions: { parse: [] } };
  }
  if (projection.projection_type === 'QUEST_OPERATION') {
    const quest = (await pool.query(`SELECT q.*,
      (SELECT count(*)::integer FROM quest_test_runs t WHERE t.quest_id=q.quest_id) AS test_attempts,
      (SELECT state FROM quest_test_runs t WHERE t.quest_id=q.quest_id
        ORDER BY created_at DESC LIMIT 1) AS latest_test_state
      FROM quests q WHERE q.quest_id=$1`, [projection.aggregate_id])).rows[0];
    return { embeds: [new EmbedBuilder().setColor(color.info).setTitle('Quest Operation Summary')
      .setDescription(`**Quest:** ${escape(quest.name)} (\`${escape(quest.quest_id)}\`)\n**Analysis:** ${escape(quest.analysis_state)} v${quest.analysis_version}\n**Sale:** ${escape(quest.sale_state)} v${quest.sale_version}\n**Announcement:** ${escape(quest.announcement_state)}\n**Executor:** ${escape(quest.executor_id)} / ${escape(quest.executor_version)}\n**Contract:** ${escape(quest.contract_version)}\n**Background tests:** ${quest.test_attempts} • ${escape(quest.latest_test_state)}\n**Trace source:** ดู Attempts/Evidence ฉบับเต็มใน PostgreSQL`)
      .setTimestamp(quest.updated_at)], allowedMentions: { parse: [] } };
  }
  if (projection.projection_type === 'MANUAL_REVIEW') {
    const review = (await pool.query(`SELECT r.*,
      (SELECT count(*)::integer FROM review_evidence e WHERE e.review_id=r.id) AS evidence_count
      FROM manual_reviews r WHERE r.id=$1`, [projection.aggregate_id])).rows[0];
    return { embeds: [new EmbedBuilder().setColor(review.financial ? color.failure : color.pending)
      .setTitle(`Manual Review • ${escape(review.state)}`)
      .setDescription(`**Review ID:** \`${review.id}\`\n**Subject:** ${escape(review.subject_type)} / \`${escape(review.subject_id)}\`\n**เหตุผล:** ${escape(review.opened_reason)}\n**Financial:** ${review.financial ? 'ใช่' : 'ไม่'}\n**Owner-only:** ${review.owner_only ? 'ใช่' : 'ไม่'}\n**Assignee:** ${escape(review.assigned_to)}\n**Evidence:** ${review.evidence_count}\n**Trace:** \`${review.trace_id}\`\n**เตือนอีกครั้ง:** <t:${Math.floor(new Date(review.remind_at).getTime() / 1000)}:R>`)
      .setTimestamp(review.created_at)], allowedMentions: { parse: [] } };
  }
  if (projection.projection_type === 'RUNNER_SUMMARY') {
    const job = (await pool.query(`SELECT j.*,i.quest_name,i.state AS item_state,i.progress_actual,
      i.progress_bucket,i.price_cents,o.account_id,o.account_username
      FROM runner_jobs j JOIN order_items i ON i.id=j.order_item_id JOIN orders o ON o.id=i.order_id
      WHERE j.id=$1`, [projection.aggregate_id])).rows[0];
    return { embeds: [new EmbedBuilder().setColor(['COMPLETED'].includes(job.state) ? color.success
      : job.state === 'FAILED' ? color.failure : color.info).setTitle(`Runner • ${escape(job.state)}`)
      .setDescription(`**Job:** \`${job.id}\`\n**Account:** ${escape(job.account_username)} (\`${job.account_id}\`)\n**Quest:** ${escape(job.quest_name)}\n**Item state:** ${escape(job.item_state)}\n**Progress:** ${job.progress_bucket}% (${escape(job.progress_actual)}%)\n**ราคา:** ${baht(job.price_cents)}\n**Attempts:** ${job.attempt_count}`)
      .setTimestamp(job.updated_at)], allowedMentions: { parse: [] } };
  }
  if (projection.projection_type === 'SYSTEM_INCIDENT') {
    const incident = (await pool.query('SELECT * FROM incidents WHERE id=$1', [projection.aggregate_id])).rows[0];
    return { embeds: [new EmbedBuilder().setColor(incident.severity === 'CRITICAL' ? color.failure : color.pending)
      .setTitle(`System • ${escape(incident.incident_code)}`)
      .setDescription(`**สถานะ:** ${escape(incident.state)}\n**Severity:** ${escape(incident.severity)}\n**Scope:** ${escape(incident.scope)}\n**Trace:** \`${incident.trace_id}\`\n**Evidence:** \`${escape(JSON.stringify(incident.evidence))}\``)
      .setTimestamp(incident.updated_at)], allowedMentions: { parse: [] } };
  }
  if (projection.projection_type === 'ADMIN_AUDIT') {
    const audit = (await pool.query('SELECT * FROM admin_audit_logs WHERE id=$1', [projection.aggregate_id])).rows[0];
    const actorIsUser = /^\d{17,20}$/.test(audit.actor_id);
    return { embeds: [new EmbedBuilder().setColor(color.info).setTitle(`Admin • ${escape(audit.action)}`)
      .setDescription(`**Actor:** ${actorIsUser ? `<@${audit.actor_id}>` : escape(audit.actor_id)} (\`${audit.actor_id}\`)\n**Target:** ${escape(audit.target_type)} / \`${escape(audit.target_id)}\`\n**เหตุผล:** ${escape(audit.reason)}\n**Correlation:** \`${audit.correlation_code}\``)
      .setTimestamp(audit.created_at)], allowedMentions: actorIsUser ? { users: [audit.actor_id], parse: [] } : { parse: [] } };
  }
  if (projection.projection_type === 'QUEST_HISTORY') {
    const item = (await pool.query(`SELECT i.*, o.account_id, o.account_username, o.account_avatar_url,o.trace_id
      FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.id = $1`, [projection.aggregate_id])).rows[0];
    const embed = new EmbedBuilder().setColor(item.state === 'READY_TO_CLAIM' ? color.success : color.pending)
      .setTitle(item.state === 'READY_TO_CLAIM' ? '✅ Quest เสร็จสมบูรณ์' : `⏳ ${escape(item.state)}`)
      .setDescription(`**บัญชี:** ${escape(item.account_username)}\n**Account ID:** \`${escape(item.account_id)}\`\n**Quest:** ${escape(item.quest_name)}\n**Order:** \`${escape(item.order_id)}\`\n**Progress:** ${item.progress_bucket}%\n**Support:** \`${supportCode(item.trace_id)}\``)
      .setTimestamp(item.updated_at);
    if (item.account_avatar_url) embed.setThumbnail(item.account_avatar_url);
    const components = item.state === 'READY_TO_CLAIM' && item.claim_url
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(item.claim_url).setLabel('รับรางวัล Quest นี้'))] : [];
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
  }
  const embed = new EmbedBuilder().setColor(color.info).setTitle(escape(projection.projection_type))
    .setDescription(`Aggregate: **${escape(projection.aggregate_id)}**\nอัปเดตจากสถานะล่าสุดใน PostgreSQL`).setTimestamp();
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

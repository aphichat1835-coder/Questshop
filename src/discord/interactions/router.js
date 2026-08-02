import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { createContext } from '../../shared/correlation.js';
import { safeError } from '../../shared/redaction.js';
import { QuestshopError } from '../../shared/errors.js';
import { submitVoucher } from '../../domain/payments/service.js';
import {
  buildQuote, confirmOrder, createSession, getSelectionPage, selectAll, updateSelection,
} from '../../domain/checkout/service.js';
import { SURFACE_COMMANDS } from '../commands/definitions.js';
import { customId, parseCustomId } from '../components/custom-id.js';
import { setupSurface } from '../surfaces/setup.js';
import { assertRateLimitAvailable, consumeRateLimit } from '../../domain/admin/rate-limits.js';
import { minimumSellablePrice } from '../../domain/pricing/resolver.js';
import { withTransaction } from '../../db/transaction.js';
import { FEATURE_GATES } from '../../config/feature-gates.js';
import { createAdminSession, loadAdminSession } from '../../domain/admin/session-service.js';
import {
  createPromotion, setPriceRule, setPriceRuleEnabled, setPromotionState, updateFeatureGate, updateRuntimeConfig,
} from '../../domain/admin/config-service.js';
import { adjustWalletAsAdmin } from '../../domain/admin/money-service.js';
import { refundCapturedOrderItem } from '../../domain/wallet/service.js';
import { blockUser, unblockUser } from '../../domain/blocklist/service.js';
import { resolveSubjectReview } from '../../domain/reviews/service.js';
import { parseBahtToCents } from '../../shared/money.js';
import { repairPermissionDrift } from '../permissions/drift.js';
import { activateReceiver } from '../../domain/admin/receiver-service.js';
import { addMonitor, rotateMonitorCredential, setMonitorState } from '../../domain/admin/monitor-service.js';
import {
  openOrderItemReview, setCircuitBreakerState, setQuestSaleState,
} from '../../domain/admin/operations-service.js';
import { discardDeadLetter, replayDeadLetter } from '../../domain/outbox/dlq-service.js';
import { loadRuntimeConfig } from '../../config/runtime-config.js';

function money(cents) { return `${(Number(cents) / 100).toFixed(2)} บาท`; }
function runnerConcurrency(runtime) {
  return Math.max(1, Math.min(runtime.env.RUNNER_CONCURRENCY_HARD_MAX,
    Number(runtime.config.values?.runnerConcurrency ?? runtime.env.RUNNER_CONCURRENCY)));
}
function actorTypeFor(interaction, runtime) {
  if (interaction.user.id === runtime.env.OWNER_ID) return 'OWNER';
  const adminRoleId = runtime.config.values?.adminRoleId;
  if (adminRoleId && interaction.member?.roles?.cache?.has(adminRoleId)) return 'ADMIN';
  return 'CUSTOMER';
}
function contextFor(interaction, operation) {
  const runtime = interaction.client.questshop;
  const actorType = actorTypeFor(interaction, runtime);
  return createContext({ actorType,
    actorId: interaction.user.id, guildId: interaction.guildId,
    idempotencyKey: `${operation}:${interaction.id}`,
    messageId: interaction.message?.id ?? null });
}
function isBackoffice(interaction, runtime) {
  if (interaction.user.id === runtime.env.OWNER_ID) return true;
  const roleId = runtime.config.values?.adminRoleId;
  return Boolean(roleId && interaction.member?.roles?.cache?.has(roleId));
}
async function ephemeralError(interaction, error) {
  const support = error?.traceId?.slice(0, 8) ?? interaction.id.slice(-8);
  const message = `ไม่สามารถดำเนินการได้: ${error?.message ?? 'เกิดข้อผิดพลาด'}\nSupport: \`${support}\``;
  if (interaction.deferred || interaction.replied) return interaction.editReply({ content: message, embeds: [], components: [] });
  return interaction.reply({ content: message, ephemeral: true });
}
function tokenModal(sessionId) {
  return new ModalBuilder().setCustomId(customId('token_submit', sessionId)).setTitle('ตรวจบัญชี Quest').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('token').setLabel('Discord Token')
      .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(20).setMaxLength(300)),
  );
}
function voucherModal(sessionId) {
  return new ModalBuilder().setCustomId(customId('voucher_submit', sessionId)).setTitle('เติมเงิน TrueMoney Gift').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('ลิงก์ซองอั่งเปา')
      .setPlaceholder('https://gift.truemoney.com/campaign/?v=...').setStyle(TextInputStyle.Short).setRequired(true)),
  );
}
function gateReasonModal(sessionId, enabled) {
  return new ModalBuilder().setCustomId(customId(enabled ? 'gate_enable_submit' : 'gate_disable_submit', sessionId))
    .setTitle(enabled ? 'เปิด Feature Gate' : 'ปิด Feature Gate').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('เหตุผลการเปลี่ยนแปลง')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(5).setMaxLength(500)),
    );
}
function fieldsModal(route, sessionId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId(route, sessionId)).setTitle(title);
  for (const field of fields) {
    const input = new TextInputBuilder().setCustomId(field.id).setLabel(field.label)
      .setStyle(field.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required !== false).setMaxLength(field.max ?? 500);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}
function parseSignedBaht(value) {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const amount = parseBahtToCents(negative ? text.slice(1) : text);
  return negative ? -amount : amount;
}
function renderSelection(page) {
  const select = new StringSelectMenuBuilder().setCustomId(customId('quest_select', page.session.id))
    .setPlaceholder(page.count ? 'เลือก Quest ในหน้านี้' : 'ไม่มี Quest ที่ซื้อได้').setMinValues(0)
    .setMaxValues(Math.max(1, page.rows.length)).setDisabled(!page.rows.length);
  if (page.rows.length) select.addOptions(page.rows.map((row) => ({
    label: row.quest_name.slice(0, 100), value: row.line_id,
    description: `${row.task_type} • ${money(row.price_cents)}`.slice(0, 100), default: row.selected,
  })));
  return { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('เลือก Quest ที่ต้องการ')
    .setDescription(`บัญชี: **${page.session.payload.username}**\nหน้า ${page.page + 1}/${page.pages} • ทั้งหมด ${page.count} Quest`)],
  components: [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('quest_prev', page.session.id)).setLabel('ก่อนหน้า').setStyle(ButtonStyle.Secondary).setDisabled(page.page === 0),
    new ButtonBuilder().setCustomId(customId('quest_next', page.session.id)).setLabel('ถัดไป').setStyle(ButtonStyle.Secondary).setDisabled(page.page + 1 >= page.pages),
    new ButtonBuilder().setCustomId(customId('quest_all', page.session.id)).setLabel('เลือกทั้งหมด').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('quest_quote', page.session.id)).setLabel('ดูราคา').setStyle(ButtonStyle.Success),
  )] };
}

function orderConfirmationContent(orderId, historyLink) {
  const history = historyLink ? `\nติดตามความคืบหน้า: ${historyLink}` : '';
  return `สร้าง Order สำเร็จ \`${orderId}\`${history}`;
}

function listRows(rows, formatter, empty = 'ไม่มี') {
  const content = rows.map(formatter).join('\n');
  return content || empty;
}

function backupSummary(backups, drills) {
  const backupRows = listRows(backups, (row) => `• ${row.backup_type} • ${row.state} • ${row.completed_at?.toISOString?.() ?? row.started_at.toISOString()}`);
  const drillRows = listRows(drills, (row) => `• ${row.state} • ${row.completed_at?.toISOString?.() ?? row.started_at.toISOString()}`);
  return `**Backups**\n${backupRows}\n\n**Restore drills**\n${drillRows}\n\nการ Restore drill สร้างฐานข้อมูลชั่วคราวผ่านสคริปต์ \`npm run restore:drill\` เพื่อไม่ให้ Interaction ถือ process ยาว`;
}

function brandingSummary(runtime) {
  const values = runtime.config.values ?? {};
  const adminRole = values.adminRoleId ? `<@&${values.adminRoleId}>` : 'ยังไม่ตั้ง';
  const questRole = values.questAnnouncementRoleId ? `<@&${values.questAnnouncementRoleId}>` : 'ปิด';
  return `Config version: **${runtime.config.version}**\nRunner concurrency: **${runnerConcurrency(runtime)}** / ${runtime.env.RUNNER_CONCURRENCY_HARD_MAX}\nAdmin role: ${adminRole}\nQuest announcement role: ${questRole}\nBranding: ${JSON.stringify(values.branding ?? {})}`;
}

async function handleSurfaceCommand(interaction, runtime) {
  if (!interaction.isChatInputCommand()) return false;
  const surface = SURFACE_COMMANDS[interaction.commandName];
  if (!surface) return true;
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'คำสั่งนี้ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const message = await setupSurface({ interaction, surfaceKey: surface, config: runtime.config }, contextFor(interaction, 'setup'), { pool: runtime.pool });
  await interaction.editReply(`ติดตั้ง ${surface} ที่ <#${message.channelId}> เรียบร้อย`);
  return true;
}

async function assertSurfaceBinding(interaction, route, runtime) {
  if (!['start', 'topup', 'admin'].includes(route.route)) return;
  const surfaceKey = route.route === 'admin' ? 'ADMIN_PANEL' : 'QUEST_AUTO';
  const surface = (await runtime.pool.query("SELECT * FROM surfaces WHERE surface_key=$1 AND state='ACTIVE'", [surfaceKey])).rows[0];
  if (!surface || surface.guild_id !== interaction.guildId || surface.channel_id !== interaction.channelId
    || surface.message_id !== interaction.message?.id) {
    throw new QuestshopError('SURFACE_BINDING_INVALID', 'ปุ่มนี้ไม่ใช่แผงที่ใช้งานอยู่');
  }
}

function isBackofficeRoute(route) {
  const prefixes = ['admin', 'gate_', 'wallet_', 'refund_', 'block_', 'review_', 'perm_',
    'price_', 'promo_', 'receiver_', 'monitor_', 'catalog_', 'adminorder_', 'dlq_', 'config_', 'breaker_'];
  return prefixes.some((prefix) => route === prefix || route.startsWith(prefix));
}

async function authorizeRoute(interaction, route, runtime) {
  await assertSurfaceBinding(interaction, route, runtime);
  if (interaction.isButton() && ['start', 'topup'].includes(route.route)) {
    await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'BUTTON' }, contextFor(interaction, 'button_rate'));
  }
  const gates = Object.fromEntries((await runtime.pool.query('SELECT gate, enabled FROM feature_gates')).rows.map((row) => [row.gate, row.enabled]));
  const backofficeRoute = isBackofficeRoute(route.route);
  if (backofficeRoute && !isBackoffice(interaction, runtime)) throw new QuestshopError('ADMIN_ONLY', 'เมนูนี้ใช้ได้เฉพาะ Owner/Admin');
  if (!backofficeRoute && (!gates.STORE_OPEN || !gates.CUSTOMER_INTERACTIONS_ENABLED)) throw new QuestshopError('STORE_CLOSED', 'ร้านปิดรับรายการชั่วคราว');
  if (['payment_method', 'voucher_submit'].includes(route.route) && !gates.TOPUP_ACCEPTING) throw new QuestshopError('TOPUP_CLOSED', 'ระบบเติมเงินปิดชั่วคราว');
  if (['token_submit', 'quest_confirm'].includes(route.route) && !gates.ORDER_ACCEPTING) throw new QuestshopError('ORDER_CLOSED', 'ระบบรับ Quest ปิดชั่วคราว');
  return gates;
}

async function handleStart({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'start' && interaction.isButton()) {
  if (!_gates.ORDER_ACCEPTING) throw new QuestshopError('ORDER_CLOSED', 'ระบบรับ Quest ปิดชั่วคราว');
  const minimum = await withTransaction({ pool: runtime.pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
    (client) => minimumSellablePrice(client));
  if (minimum == null) throw new QuestshopError('NO_SELLABLE_QUEST', 'ขณะนี้ยังไม่มี Quest ที่เปิดขาย');
  const wallet = (await runtime.pool.query('SELECT available_cents FROM wallets WHERE discord_user_id = $1', [interaction.user.id])).rows[0];
  if (BigInt(wallet?.available_cents ?? 0) < BigInt(minimum)) throw new QuestshopError('WALLET_INSUFFICIENT', `ต้องมีเครดิตขั้นต่ำ ${money(minimum)}`);
  const entry = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'TOKEN_ENTRY',
    payload: {}, configVersion: runtime.config.version, ttlMinutes: 15 },
  contextFor(interaction, 'token_entry'), { pool: runtime.pool });
  return interaction.showModal(tokenModal(entry.id));
}
}

async function handleTopup({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'topup' && interaction.isButton()) {
  if (!_gates.TOPUP_ACCEPTING) throw new QuestshopError('TOPUP_CLOSED', 'ระบบเติมเงินปิดชั่วคราว');
  const entry = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'TOPUP_ENTRY',
    payload: {}, configVersion: runtime.config.version, ttlMinutes: 15 },
  contextFor(interaction, 'topup_entry'), { pool: runtime.pool });
  await interaction.reply({ ephemeral: true,
  content: 'เลือกช่องทางการชำระเงิน', components: [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId('payment_method', entry.id)).setPlaceholder('เลือกช่องทาง').addOptions({ label: 'TrueMoney Gift', value: 'truemoney', emoji: '💰' }),
  )] });
  const reply = await interaction.fetchReply();
  await runtime.pool.query(`UPDATE interaction_sessions SET message_id=$2,
    updated_at=clock_timestamp() WHERE id=$1 AND state='ACTIVE'`, [entry.id, reply.id]);
  return reply;
}
}

async function handlePaymentMethod({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'payment_method' && interaction.isStringSelectMenu()) {
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOPUP_ENTRY' }, contextFor(interaction, 'topup_entry_load'), { pool: runtime.pool });
  await assertRateLimitAvailable({ discordUserId: interaction.user.id, operation: 'VOUCHER_INVALID' },
    contextFor(interaction, 'voucher_invalid_check'), { pool: runtime.pool });
  return interaction.showModal(voucherModal(route.sessionId));
}
}

async function handleVoucherSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'voucher_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOPUP_ENTRY' }, contextFor(interaction, 'topup_entry_load'), { pool: runtime.pool });
  await assertRateLimitAvailable({ discordUserId: interaction.user.id, operation: 'VOUCHER_INVALID' },
    contextFor(interaction, 'voucher_invalid_submit_check'), { pool: runtime.pool });
  let result;
  try {
    result = await submitVoucher({ discordUserId: interaction.user.id,
      voucherUrl: interaction.fields.getTextInputValue('url'), env: runtime.env }, contextFor(interaction, 'topup'),
    { pool: runtime.pool });
  } catch (error) {
    if (['INVALID_VOUCHER_URL','INVALID_VOUCHER_CODE'].includes(error.code)) {
      await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'VOUCHER_INVALID' },
        contextFor(interaction, 'voucher_invalid'));
    }
    throw error;
  }
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [route.sessionId]);
  return interaction.editReply(`รับรายการเติมเงินแล้ว\nTop-up ID: \`${result.topup.id}\`\nสถานะ: **${result.topup.status}**`);
}
}

async function handleTokenSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'token_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOKEN_ENTRY' }, contextFor(interaction, 'token_entry_load'), { pool: runtime.pool });
  await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'TOKEN_VALIDATE' }, contextFor(interaction, 'token_rate'));
  const created = await createSession({ discordUserId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    token: interaction.fields.getTextInputValue('token'), env: runtime.env,
    runnerConcurrency: runnerConcurrency(runtime) }, contextFor(interaction, 'checkout'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [route.sessionId]);
  const page = await getSelectionPage({ sessionId: created.session.id, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  const reply = await interaction.editReply(renderSelection(page));
  await runtime.pool.query(`UPDATE interaction_sessions SET message_id=$2,
    updated_at=clock_timestamp() WHERE id=$1 AND message_id IS NULL`, [created.session.id, reply.id]);
  return reply;
}
}

async function handleQuestPaging({ interaction, route, runtime, gates: _gates }) {
if (['quest_prev', 'quest_next'].includes(route.route)) {
  await interaction.deferUpdate();
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null,
    direction: route.route === 'quest_next' ? 1 : -1 }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(page));
}
}

async function handleQuestSelect({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_select' && interaction.isStringSelectMenu()) {
  await interaction.deferUpdate();
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  const pageIds = page.rows.map((row) => row.line_id);
  await updateSelection({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null, lineIds: pageIds,
    selected: false }, contextFor(interaction, 'selection'), { pool: runtime.pool });
  await updateSelection({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null, lineIds: interaction.values,
    selected: true }, contextFor(interaction, 'selection'), { pool: runtime.pool });
  const refreshed = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(refreshed));
}
}

async function handleQuestAll({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_all') {
  await interaction.deferUpdate();
  await selectAll({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'selection_all'), { pool: runtime.pool });
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(page));
}
}

async function handleQuestQuote({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_quote') {
  await interaction.deferUpdate();
  const quote = await buildQuote({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null,
    runnerConcurrency: runnerConcurrency(runtime) },
  contextFor(interaction, 'quote'), { pool: runtime.pool });
  return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x23a55a).setTitle('ตรวจสอบรายการ')
    .setDescription(quote.items.map((item) => `• ${item.quest_name} — ${money(item.price_cents)}`).join('\n') + `\n\nรวม **${money(quote.totalCents)}**`)],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('quest_confirm', route.sessionId)).setLabel('ยืนยันทำ Quest').setStyle(ButtonStyle.Success))] });
}
}

async function handleQuestConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_confirm') {
  await interaction.deferUpdate();
  await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'ORDER_CONFIRM' }, contextFor(interaction, 'confirm_rate'));
  const order = await confirmOrder({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null,
    env: runtime.env, runnerConcurrency: runnerConcurrency(runtime) }, contextFor(interaction, 'confirm'), { pool: runtime.pool });
  const history = (await runtime.pool.query("SELECT * FROM surfaces WHERE surface_key='QUEST_HISTORY' AND state='ACTIVE'")).rows[0];
  const historyLink = history ? `https://discord.com/channels/${interaction.guildId}/${history.channel_id}` : null;
  return interaction.editReply({ content: orderConfirmationContent(order.orderId, historyLink), embeds: [], components: [] });
}
}

async function handleAdminPanel({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'admin') {
  if (!isBackoffice(interaction, runtime)) throw new QuestshopError('ADMIN_ONLY', 'เมนูนี้ใช้ได้เฉพาะ Owner/Admin');
  await interaction.deferReply({ ephemeral: true });
  if (interaction.values?.[0] === 'gates') {
    if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Feature Gates ใช้ได้เฉพาะ Owner');
    const rows = (await runtime.pool.query('SELECT * FROM feature_gates ORDER BY gate')).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Store และ Feature Gates')
      .setDescription(rows.map((row) => `${row.enabled ? '🟢' : '🔴'} **${row.gate}** — v${row.version}\n${row.reason}`).join('\n'))],
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(customId('admin_gate_pick'))
      .setPlaceholder('เลือก Gate ที่ต้องการแก้').addOptions(FEATURE_GATES.map((gate) => ({ label: gate, value: gate }))))] });
  }
  if (interaction.values?.[0] === 'wallet') {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xf0b232)
      .setTitle('Wallet / Refund / Adjustment')
      .setDescription('การแก้ยอดใช้ Compensating ledger เท่านั้น ต้องดู Before/After และยืนยันซ้ำภายใน 5 นาที\nReserved balance แก้ตรงจากเมนูนี้ไม่ได้')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('wallet_adjust')).setLabel('ปรับ Available balance').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(customId('refund_prepare')).setLabel('คืนเงิน Item ที่ Capture แล้ว').setStyle(ButtonStyle.Primary),
    )] });
  }
  if (interaction.values?.[0] === 'blocklist') {
    const blocks = (await runtime.pool.query(`SELECT * FROM blocklist_entries WHERE revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY created_at DESC LIMIT 10`)).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xf0b232).setTitle('Blocklist')
      .setDescription((blocks.map((row) => `• \`${row.discord_user_id}\` • **${row.block_type}** • ${row.reason}`).join('\n')
        || 'ยังไม่มีรายการ Block ที่ใช้งานอยู่') + '\n\nBlock ไม่ริบ Wallet และไม่หยุดงานเดิม')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('block_add')).setLabel('Block').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(customId('block_remove')).setLabel('Unblock').setStyle(ButtonStyle.Secondary),
    )] });
  }
  if (interaction.values?.[0] === 'payments') {
    const reviews = (await runtime.pool.query(`SELECT * FROM manual_reviews WHERE state<>'RESOLVED'
      ORDER BY financial DESC,created_at LIMIT 10`)).rows;
    const breaker = (await runtime.pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xf0b232)
      .setTitle('Payments และ Manual Review')
      .setDescription(`Circuit: **${breaker.state}** v${breaker.state_version} • ${breaker.reason ?? 'ปกติ'}\n\n${listRows(reviews, (row) => `• \`${row.id}\` • **${row.subject_type}** • ${row.state}${row.owner_only ? ' • Owner-only' : ''}`, 'ไม่มี Review ค้าง')}`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('review_resolve')).setLabel('ตัดสิน Manual Review')
        .setStyle(ButtonStyle.Danger).setDisabled(!reviews.length),
      new ButtonBuilder().setCustomId(customId('breaker_prepare')).setLabel('Recovery probe / Close circuit')
        .setStyle(ButtonStyle.Secondary).setDisabled(interaction.user.id !== runtime.env.OWNER_ID),
    )] });
  }
  if (interaction.values?.[0] === 'surfaces') {
    const surfaces = (await runtime.pool.query('SELECT * FROM surfaces ORDER BY surface_key')).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2)
      .setTitle('Surfaces และ Permission Drift')
      .setDescription(surfaces.map((surface) => `${surface.state === 'ACTIVE' ? '🟢' : '🔴'} **${surface.surface_key}** • <#${surface.channel_id}> • v${surface.state_version}`).join('\n') || 'ยังไม่ได้ติดตั้ง Surface')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('perm_repair'))
      .setLabel('Preview / Repair Permission').setStyle(ButtonStyle.Danger)
      .setDisabled(interaction.user.id !== runtime.env.OWNER_ID || !surfaces.some((row) => row.state === 'DRIFTED')))] });
  }
  if (interaction.values?.[0] === 'pricing') {
    const rules = (await runtime.pool.query(`SELECT * FROM price_rules
      ORDER BY enabled DESC, created_at DESC LIMIT 10`)).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Pricing')
      .setDescription(rules.map((rule) => `• \`${rule.id}\` • **${rule.rule_type}** ${rule.quest_id ?? rule.task_type ?? 'ทั้งหมด'} — ${money(rule.amount_cents)} • ${rule.enabled ? '🟢 ON' : '🔴 OFF'}`).join('\n') || 'ยังไม่มีกฎราคา')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('price_create')).setLabel('สร้าง Price rule').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(customId('price_manage')).setLabel('เปิด / ปิด Rule').setStyle(ButtonStyle.Secondary)
        .setDisabled(!rules.length),
    )] });
  }
  if (interaction.values?.[0] === 'promotions') {
    const promotions = (await runtime.pool.query('SELECT * FROM promotions ORDER BY version DESC LIMIT 10')).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Promotions')
      .setDescription(promotions.map((promotion) => `• \`${promotion.id}\` • v${promotion.version} **${promotion.name}** • ${promotion.state} • <t:${Math.floor(new Date(promotion.ends_at).getTime() / 1000)}:R>`).join('\n') || 'ยังไม่มี Promotion')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('promo_create')).setLabel('สร้าง Promotion').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(customId('promo_manage')).setLabel('เปิด / ปิด Promotion').setStyle(ButtonStyle.Secondary)
        .setDisabled(!promotions.length),
    )] });
  }
  if (interaction.values?.[0] === 'receivers') {
    if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Receiver Versions ใช้ได้เฉพาะ Owner');
    const receivers = (await runtime.pool.query('SELECT * FROM receiver_versions ORDER BY version DESC LIMIT 10')).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Receiver Versions')
      .setDescription(receivers.map((receiver) => `• v${receiver.version} • ***-***-${receiver.phone_last4} • **${receiver.state}**`).join('\n') || 'ยังไม่ได้ตั้ง Receiver')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('receiver_activate'))
      .setLabel('เปิด Receiver version ใหม่').setStyle(ButtonStyle.Danger))] });
  }
  if (interaction.values?.[0] === 'monitors') {
    if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Monitor Accounts ใช้ได้เฉพาะ Owner');
    const monitors = (await runtime.pool.query('SELECT * FROM monitor_accounts ORDER BY priority DESC,created_at')).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Monitor Accounts')
      .setDescription(monitors.map((monitor) => `• **${monitor.username}** (\`${monitor.account_id}\`) • ${monitor.state} • ${monitor.capabilities.join(', ')}`).join('\n') || 'ยังไม่มี Monitor')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('monitor_add'))
      .setLabel('เพิ่ม Monitor').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(customId('monitor_manage')).setLabel('State / Rotate token')
      .setStyle(ButtonStyle.Secondary).setDisabled(!monitors.length))] });
  }
  if (interaction.values?.[0] === 'catalog') {
    const quests = (await runtime.pool.query(`SELECT * FROM quests ORDER BY updated_at DESC LIMIT 10`)).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Quest Catalog')
      .setDescription(quests.map((quest) => `• \`${quest.quest_id}\` • **${quest.name ?? 'ไม่ระบุ'}** • ${quest.analysis_state}/${quest.sale_state}`).join('\n') || 'ยังไม่มี Quest')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('catalog_sale'))
      .setLabel('เปลี่ยนสถานะขาย Quest').setStyle(ButtonStyle.Primary))] });
  }
  if (interaction.values?.[0] === 'orders') {
    const items = (await runtime.pool.query(`SELECT i.*,o.account_username FROM order_items i
      JOIN orders o ON o.id=i.order_id WHERE i.state NOT IN ('READY_TO_CLAIM','EXPIRED_RELEASED',
      'EXTERNAL_COMPLETED_RELEASED','STOPPED_RELEASED','FAILED_RELEASED')
      ORDER BY i.updated_at LIMIT 10`)).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Orders และ Runner')
      .setDescription(items.map((item) => `• \`${item.id}\` • **${item.quest_name}** • ${item.state} • ${item.progress_bucket}%`).join('\n') || 'ไม่มี Item ที่กำลังทำงาน')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('adminorder_review'))
      .setLabel('เปิด Manual Review / Stop / Retry').setStyle(ButtonStyle.Danger).setDisabled(!items.length))] });
  }
  if (interaction.values?.[0] === 'backup') {
    const [backups, drills] = await Promise.all([
      runtime.pool.query('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 5'),
      runtime.pool.query('SELECT * FROM restore_drills ORDER BY started_at DESC LIMIT 5'),
    ]);
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Backup / Restore')
      .setDescription(backupSummary(backups.rows, drills.rows))] });
  }
  if (interaction.values?.[0] === 'branding') {
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Branding / Config')
      .setDescription(brandingSummary(runtime))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('config_branding')).setLabel('แก้ Branding').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(customId('config_concurrency')).setLabel('Runner concurrency').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(customId('config_roles')).setLabel('Admin / Announcement Roles')
        .setStyle(ButtonStyle.Danger).setDisabled(interaction.user.id !== runtime.env.OWNER_ID),
    )], allowedMentions: { parse: [] } });
  }
  if (interaction.values?.[0] === 'secrets') {
    if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Secret status ใช้ได้เฉพาะ Owner');
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Secret / Key version status')
      .setDescription(`Data encryption key: **v${runtime.env.DATA_ENCRYPTION_KEYS_JSON.current}** (${Object.keys(runtime.env.DATA_ENCRYPTION_KEYS_JSON.keys).length} retained)\nVoucher HMAC key: **v${runtime.env.VOUCHER_HMAC_KEYS_JSON.current}** (${Object.keys(runtime.env.VOUCHER_HMAC_KEYS_JSON.keys).length} retained)\nBackup key: **v${runtime.env.BACKUP_ENCRYPTION_KEYS_JSON.current}** (${Object.keys(runtime.env.BACKUP_ENCRYPTION_KEYS_JSON.keys).length} retained)\n\nค่าจริงไม่ถูกอ่านกลับหรือแสดงใน Discord และ Rotation ต้องเปลี่ยนผ่าน Environment/Secret manager`)] });
  }
  if (interaction.values?.[0] === 'dlq') {
    const dlq = (await runtime.pool.query(`SELECT * FROM dead_letter_items
      WHERE state IN ('DEAD_LETTER','PENDING') ORDER BY created_at DESC LIMIT 10`)).rows;
    const activeIncidents = (await runtime.pool.query(`SELECT * FROM incidents WHERE state<>'RESOLVED'
      ORDER BY severity DESC,opened_at DESC LIMIT 10`)).rows;
    return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xf23f43).setTitle('DLQ และ Incidents')
      .setDescription(`**DLQ**\n${listRows(dlq, (row) => `• \`${row.id}\` • ${row.category} • ${row.state} • ${row.error_code}`)}\n\n**Incidents**\n${listRows(activeIncidents, (row) => `• ${row.severity} • **${row.incident_code}** / ${row.scope}`)}`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('dlq_replay')).setLabel('Replay DLQ').setStyle(ButtonStyle.Primary).setDisabled(!dlq.length),
      new ButtonBuilder().setCustomId(customId('dlq_discard')).setLabel('Discard non-financial').setStyle(ButtonStyle.Danger)
        .setDisabled(interaction.user.id !== runtime.env.OWNER_ID || !dlq.length),
    )] });
  }
  const [wallets, queue, reviews, incidents, backup] = await Promise.all([
    runtime.pool.query('SELECT count(*)::integer AS users,COALESCE(sum(available_cents),0)::bigint AS available,COALESCE(sum(reserved_cents),0)::bigint AS reserved FROM wallets'),
    runtime.pool.query("SELECT count(*)::integer AS count FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')"),
    runtime.pool.query("SELECT count(*)::integer AS count FROM manual_reviews WHERE state<>'RESOLVED'"),
    runtime.pool.query("SELECT count(*)::integer AS count FROM incidents WHERE state<>'RESOLVED'"),
    runtime.pool.query("SELECT completed_at FROM backup_runs WHERE state='VERIFIED' ORDER BY completed_at DESC LIMIT 1"),
  ]);
  const row = wallets.rows[0];
  return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Admin • ${interaction.values?.[0] ?? 'overview'}`)
    .setDescription(`Wallet users: **${row.users}**\nAvailable: **${money(row.available)}**\nReserved: **${money(row.reserved)}**\nQueue: **${queue.rows[0].count}**\nReviews: **${reviews.rows[0].count}**\nIncidents: **${incidents.rows[0].count}**\nBackup ล่าสุด: **${backup.rows[0]?.completed_at?.toISOString?.() ?? 'ยังไม่มี'}**`)] });
}
}

async function handleWalletAdjust({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_WALLET_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'wallet_prepare'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('wallet_adjust_submit', session.id, 'ปรับยอด Wallet', [
    { id: 'user_id', label: 'Discord User ID', max: 20 },
    { id: 'amount', label: 'จำนวนบาท (+ เพิ่ม / - ลด)', placeholder: '100.00 หรือ -50.00', max: 24 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handleWalletAdjustSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_WALLET_PREPARE' },
  contextFor(interaction, 'wallet_prepare_load'), { pool: runtime.pool });
  const discordUserId = interaction.fields.getTextInputValue('user_id').trim();
  if (!/^\d{17,20}$/.test(discordUserId)) throw new TypeError('Discord User ID ไม่ถูกต้อง');
  const amountCents = parseSignedBaht(interaction.fields.getTextInputValue('amount'));
  if (amountCents === 0n) throw new TypeError('จำนวนเงินต้องไม่เป็นศูนย์');
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const before = (await runtime.pool.query(`SELECT available_cents,reserved_cents,state_version
    FROM wallets WHERE discord_user_id=$1`, [discordUserId])).rows[0]
    ?? { available_cents: '0', reserved_cents: '0', state_version: '0' };
  const after = BigInt(before.available_cents) + amountCents;
  if (after < 0n) throw new QuestshopError('INSUFFICIENT_BALANCE', 'ยอดหลังปรับห้ามติดลบ');
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'ADMIN_WALLET_CONFIRM', payload: { discordUserId, amountCents: String(amountCents),
      expectedVersion: String(before.state_version), reason }, configVersion: runtime.config.version },
  contextFor(interaction, 'wallet_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยันปรับ Wallet \`${discordUserId}\`\nAvailable: **${money(before.available_cents)} → ${money(after)}**\nReserved: **${money(before.reserved_cents)}**\nเหตุผล: ${reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('wallet_adjust_confirm', confirm.id)).setLabel('ยืนยันการแก้ยอด')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleWalletAdjustConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust_confirm' && interaction.isButton()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_WALLET_CONFIRM' },
  contextFor(interaction, 'wallet_confirm_load'), { pool: runtime.pool });
  const current = (await runtime.pool.query('SELECT state_version FROM wallets WHERE discord_user_id=$1',
    [session.payload.discordUserId])).rows[0];
  if (String(current?.state_version ?? '0') !== session.payload.expectedVersion) {
    throw new QuestshopError('STALE_STATE', 'Wallet เปลี่ยนหลัง Preview กรุณาเริ่มใหม่');
  }
  const wallet = await adjustWalletAsAdmin({ discordUserId: session.payload.discordUserId,
    amountCents: BigInt(session.payload.amountCents), reason: session.payload.reason,
    expectedVersion: session.payload.expectedVersion },
  contextFor(interaction, 'wallet_adjust_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply({ content: `ปรับยอดสำเร็จ Available = **${money(wallet.available_cents)}**`, components: [] });
}
}

async function handleRefundPrepare({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_prepare' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_REFUND_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'refund_prepare'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('refund_prepare_submit', session.id, 'คืนเงิน Order Item', [
    { id: 'item_id', label: 'Order Item ID', max: 36 },
    { id: 'reason', label: 'เหตุผลการคืนเงิน', long: true, max: 500 },
  ]));
}
}

async function handleRefundPrepareSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_prepare_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REFUND_PREPARE' },
  contextFor(interaction, 'refund_prepare_load'), { pool: runtime.pool });
  const orderItemId = interaction.fields.getTextInputValue('item_id').trim();
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const row = (await runtime.pool.query(`SELECT r.*,i.order_id,i.quest_name,w.available_cents,
    EXISTS(SELECT 1 FROM refunds f WHERE f.order_item_id=r.order_item_id) AS refunded
    FROM wallet_reservations r JOIN order_items i ON i.id=r.order_item_id
    JOIN wallets w ON w.discord_user_id=r.discord_user_id WHERE r.order_item_id=$1`, [orderItemId])).rows[0];
  if (!row) throw new QuestshopError('RESERVATION_NOT_FOUND', 'ไม่พบ Order Item หรือยอดจอง');
  if (row.refunded) throw new QuestshopError('ALREADY_REFUNDED', 'Item นี้คืนเงินแล้ว');
  if (row.state !== 'CAPTURED') throw new QuestshopError('REFUND_NOT_CAPTURED', 'คืนเงินได้เฉพาะ Item ที่ Capture แล้ว');
  const after = BigInt(row.available_cents) + BigInt(row.amount_cents);
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'ADMIN_REFUND_CONFIRM', payload: { orderItemId, reason,
      expectedReservationVersion: String(row.state_version) }, configVersion: runtime.config.version },
  contextFor(interaction, 'refund_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยันคืนเงิน **${row.quest_name}**\nOrder: \`${row.order_id}\`\nItem: \`${orderItemId}\`\nจำนวน: **${money(row.amount_cents)}**\nAvailable: **${money(row.available_cents)} → ${money(after)}**\nเหตุผล: ${reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('refund_confirm', confirm.id)).setLabel('ยืนยันคืนเงิน')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleRefundConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_confirm' && interaction.isButton()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REFUND_CONFIRM' },
  contextFor(interaction, 'refund_confirm_load'), { pool: runtime.pool });
  const refund = await refundCapturedOrderItem({ orderItemId: session.payload.orderItemId,
    reason: session.payload.reason, expectedReservationVersion: session.payload.expectedReservationVersion },
  contextFor(interaction, 'refund_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply({ content: `คืนเงินสำเร็จ **${money(refund.amount_cents)}**\nRefund ID: \`${refund.id}\`\nAvailable ปัจจุบัน: **${money(refund.available_cents)}**`, components: [] });
}
}

async function handleBlockAction({ interaction, route, runtime, gates: _gates }) {
if (['block_add', 'block_remove'].includes(route.route) && interaction.isButton()) {
  const operation = route.route === 'block_add' ? 'ADMIN_BLOCK' : 'ADMIN_UNBLOCK';
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation,
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'block_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal(route.route === 'block_add' ? 'block_add_submit' : 'block_remove_submit',
    session.id, route.route === 'block_add' ? 'Block ผู้ใช้' : 'Unblock ผู้ใช้', [
      { id: 'user_id', label: 'Discord User ID', max: 20 },
      { id: 'block_type', label: 'ประเภท', placeholder: 'TOPUP_BLOCKED หรือ ORDER_BLOCKED', max: 20 },
      ...(route.route === 'block_add' ? [{ id: 'hours', label: 'หมดอายุในกี่ชั่วโมง (เว้นว่าง=ถาวร)', required: false, max: 8 }] : []),
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]));
}
}

async function handleBlockSubmit({ interaction, route, runtime, gates: _gates }) {
if (['block_add_submit', 'block_remove_submit'].includes(route.route) && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const adding = route.route === 'block_add_submit';
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    operation: adding ? 'ADMIN_BLOCK' : 'ADMIN_UNBLOCK' }, contextFor(interaction, 'block_load'), { pool: runtime.pool });
  const input = { discordUserId: interaction.fields.getTextInputValue('user_id').trim(),
    blockType: interaction.fields.getTextInputValue('block_type').trim().toUpperCase(),
    reason: interaction.fields.getTextInputValue('reason').trim() };
  if (!/^\d{17,20}$/.test(input.discordUserId)) throw new TypeError('Discord User ID ไม่ถูกต้อง');
  if (adding) {
    const hoursText = interaction.fields.getTextInputValue('hours').trim();
    const hours = hoursText ? Number(hoursText) : null;
    if (hours != null && (!Number.isInteger(hours) || hours <= 0 || hours > 8760)) throw new TypeError('จำนวนชั่วโมงไม่ถูกต้อง');
    input.expiresInHours = hours;
    await blockUser(input, contextFor(interaction, 'block_add_execute'), { pool: runtime.pool });
  } else await unblockUser(input, contextFor(interaction, 'block_remove_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`${adding ? 'Block' : 'Unblock'} \`${input.discordUserId}\` / **${input.blockType}** เรียบร้อย`);
}
}

async function handleReviewResolve({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_resolve' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_REVIEW_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'review_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('review_resolve_submit', session.id, 'ตัดสิน Manual Review', [
    { id: 'review_id', label: 'Review ID', max: 36 },
    { id: 'decision', label: 'คำตัดสิน', placeholder: 'CREDIT/REJECT/RETRY/CAPTURE/RELEASE/STOP/FAIL', max: 12 },
    { id: 'amount', label: 'ยอดบาท (เฉพาะ CREDIT)', required: false, max: 24 },
    { id: 'provider_id', label: 'Provider transaction (เฉพาะ CREDIT)', required: false, max: 200 },
    { id: 'reason', label: 'เหตุผลและหลักฐาน', long: true, max: 500 },
  ]));
}
}

async function handleReviewResolveSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_resolve_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REVIEW_PREPARE' },
  contextFor(interaction, 'review_prepare_load'), { pool: runtime.pool });
  const reviewId = interaction.fields.getTextInputValue('review_id').trim();
  const review = (await runtime.pool.query(`SELECT * FROM manual_reviews WHERE id=$1
    AND state<>'RESOLVED'`, [reviewId])).rows[0];
  if (!review) throw new QuestshopError('REVIEW_NOT_FOUND', 'ไม่พบ Manual Review ที่ยังเปิดอยู่');
  if (review.owner_only && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'รายการนี้ให้ Owner ตัดสินเท่านั้น');
  const decision = interaction.fields.getTextInputValue('decision').trim().toUpperCase();
  const amountText = interaction.fields.getTextInputValue('amount').trim();
  const payload = { reviewId, expectedVersion: String(review.state_version), decision,
    amountCents: amountText ? String(parseBahtToCents(amountText)) : null,
    providerTransactionId: interaction.fields.getTextInputValue('provider_id').trim() || null,
    reason: interaction.fields.getTextInputValue('reason').trim() };
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'ADMIN_REVIEW_CONFIRM', payload, configVersion: runtime.config.version },
  contextFor(interaction, 'review_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยัน Review \`${review.id}\`\nSubject: **${review.subject_type}** / \`${review.subject_id}\`\nDecision: **${decision}**\nFinancial: **${review.financial ? 'ใช่' : 'ไม่'}**\nเหตุผล: ${payload.reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('review_resolve_confirm', confirm.id)).setLabel('ยืนยันคำตัดสิน')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleReviewResolveConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_resolve_confirm' && interaction.isButton()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REVIEW_CONFIRM' },
  contextFor(interaction, 'review_confirm_load'), { pool: runtime.pool });
  const current = (await runtime.pool.query('SELECT state_version FROM manual_reviews WHERE id=$1',
    [session.payload.reviewId])).rows[0];
  if (String(current?.state_version) !== session.payload.expectedVersion) {
    throw new QuestshopError('STALE_STATE', 'Review เปลี่ยนหลัง Preview กรุณาเริ่มใหม่');
  }
  const result = await resolveSubjectReview({ reviewId: session.payload.reviewId,
    decision: session.payload.decision, reason: session.payload.reason,
    expectedVersion: session.payload.expectedVersion,
    isOwner: interaction.user.id === runtime.env.OWNER_ID,
    amountCents: session.payload.amountCents == null ? null : BigInt(session.payload.amountCents),
    providerTransactionId: session.payload.providerTransactionId },
  contextFor(interaction, 'review_resolve_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply({ content: `Review สำเร็จ: **${result.review.state}** • ${session.payload.decision}`, components: [] });
}
}

async function handlePermissionRepair({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'perm_repair' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Permission repair ใช้ได้เฉพาะ Owner');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PERMISSION_REPAIR_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'permission_repair_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('perm_repair_submit', session.id, 'Permission Repair', [
    { id: 'surface', label: 'Surface key', placeholder: 'LOG_PAYMENTS', max: 32 },
    { id: 'reason', label: 'เหตุผลการซ่อม', long: true, max: 500 },
  ]));
}
}

async function handlePermissionRepairSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'perm_repair_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Permission repair ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PERMISSION_REPAIR_PREPARE' },
  contextFor(interaction, 'permission_repair_load'), { pool: runtime.pool });
  const surfaceKey = interaction.fields.getTextInputValue('surface').trim().toUpperCase();
  const surface = (await runtime.pool.query('SELECT * FROM surfaces WHERE surface_key=$1', [surfaceKey])).rows[0];
  if (surface?.state !== 'DRIFTED') throw new QuestshopError('SURFACE_NOT_DRIFTED', 'Surface นี้ไม่อยู่ในสถานะ Drifted');
  const payload = { surfaceKey, expectedVersion: String(surface.state_version),
    reason: interaction.fields.getTextInputValue('reason').trim() };
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'PERMISSION_REPAIR_CONFIRM', payload, configVersion: runtime.config.version },
  contextFor(interaction, 'permission_repair_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยันซ่อม **${surfaceKey}** ที่ <#${surface.channel_id}>\nระบบจะจำกัด View Channel ของ @everyone/overwrite ที่ไม่คาดหมาย และคืนสิทธิ์ Bot/Owner/Admin\nเหตุผล: ${payload.reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('perm_repair_confirm', confirm.id)).setLabel('ยืนยันซ่อม Permission')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handlePermissionRepairConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'perm_repair_confirm' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Permission repair ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PERMISSION_REPAIR_CONFIRM' },
  contextFor(interaction, 'permission_repair_confirm_load'), { pool: runtime.pool });
  const current = (await runtime.pool.query('SELECT state_version FROM surfaces WHERE surface_key=$1',
    [session.payload.surfaceKey])).rows[0];
  if (String(current?.state_version) !== session.payload.expectedVersion) throw new QuestshopError('STALE_STATE', 'Surface เปลี่ยนหลัง Preview');
  await repairPermissionDrift({ client: interaction.client, pool: runtime.pool, env: runtime.env,
    surfaceKey: session.payload.surfaceKey, adminRoleId: runtime.config.values?.adminRoleId,
    reason: session.payload.reason }, contextFor(interaction, 'permission_repair_execute'));
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`ซ่อมและตรวจ Permission ของ **${session.payload.surfaceKey}** ผ่านแล้ว`);
}
}

async function handleCatalogSale({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'catalog_sale' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'QUEST_SALE_CHANGE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'catalog_sale_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('catalog_sale_submit', session.id, 'สถานะขาย Quest', [
    { id: 'quest_id', label: 'Quest ID', max: 100 },
    { id: 'state', label: 'สถานะใหม่', placeholder: 'OPEN / PAUSED / EXPIRED', max: 10 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handleCatalogSaleSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'catalog_sale_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'QUEST_SALE_CHANGE' },
  contextFor(interaction, 'catalog_sale_load'), { pool: runtime.pool });
  const quest = await setQuestSaleState({ questId: interaction.fields.getTextInputValue('quest_id').trim(),
    nextState: interaction.fields.getTextInputValue('state').trim().toUpperCase(),
    runnerConcurrency: runnerConcurrency(runtime),
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'catalog_sale_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`Quest \`${quest.quest_id}\` เปลี่ยนเป็น **${quest.sale_state}** แล้ว`);
}
}

async function handleOrderReview({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'adminorder_review' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ORDER_REVIEW_OPEN',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'order_review_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('adminorder_review_submit', session.id, 'เปิด Manual Review', [
    { id: 'item_id', label: 'Order Item ID', max: 36 },
    { id: 'owner_only', label: 'Owner-only?', placeholder: 'yes หรือ no', max: 3 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handleOrderReviewSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'adminorder_review_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ORDER_REVIEW_OPEN' },
  contextFor(interaction, 'order_review_load'), { pool: runtime.pool });
  const ownerOnly = interaction.fields.getTextInputValue('owner_only').trim().toLowerCase() === 'yes';
  const review = await openOrderItemReview({ orderItemId: interaction.fields.getTextInputValue('item_id').trim(),
    reason: interaction.fields.getTextInputValue('reason').trim(), ownerOnly },
  contextFor(interaction, 'order_review_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`เปิด Manual Review \`${review.id}\` แล้ว${review.owner_only ? ' (Owner-only)' : ''}`);
}
}

async function handlePriceCreate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_create' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PRICE_CREATE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'price_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('price_create_submit', session.id, 'สร้าง Price rule', [
    { id: 'scope', label: 'Scope', placeholder: 'DEFAULT / TYPE / QUEST / TEMPORARY', max: 16 },
    { id: 'target', label: 'Target (เว้นว่างได้)', placeholder: 'WATCH_VIDEO, Quest ID, type:... หรือ quest:...', required: false, max: 100 },
    { id: 'amount', label: 'ราคา (บาท)', placeholder: '5.00', max: 24 },
    { id: 'period', label: 'เริ่ม | จบ (ISO 8601, เว้นว่างได้)', placeholder: '2026-08-01T00:00:00+07:00 | 2026-08-31T23:59:59+07:00', required: false, max: 120 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handlePriceCreateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_create_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PRICE_CREATE' },
  contextFor(interaction, 'price_load'), { pool: runtime.pool });
  const ruleType = interaction.fields.getTextInputValue('scope').trim().toUpperCase();
  const target = interaction.fields.getTextInputValue('target').trim();
  let questId = ruleType === 'QUEST' ? target : null;
  let taskType = ruleType === 'TYPE' ? target.toUpperCase() : null;
  if (ruleType === 'TEMPORARY' && target.startsWith('quest:')) questId = target.slice(6);
  if (ruleType === 'TEMPORARY' && target.startsWith('type:')) taskType = target.slice(5).toUpperCase();
  const period = interaction.fields.getTextInputValue('period').trim();
  const [startText, endText] = period ? period.split('|').map((value) => value.trim()) : [];
  const startsAt = startText ? new Date(startText) : null;
  const endsAt = endText ? new Date(endText) : null;
  if ((startText && (!Number.isFinite(startsAt.getTime()))) || (endText && (!Number.isFinite(endsAt.getTime())))
    || (startsAt && endsAt && endsAt <= startsAt)) throw new TypeError('ช่วงเวลา Price rule ไม่ถูกต้อง');
  const rule = await setPriceRule({ ruleType,
    questId: questId || null, taskType: taskType || null,
    amountCents: parseBahtToCents(interaction.fields.getTextInputValue('amount')),
    startsAt, endsAt,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'price_create_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`สร้าง Price rule **${rule.rule_type}** ราคา **${money(rule.amount_cents)}** แล้ว`);
}
}

async function handlePriceManage({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_manage' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PRICE_MANAGE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'price_manage_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('price_manage_submit', session.id, 'เปิด / ปิด Price rule', [
    { id: 'rule_id', label: 'Price rule ID', max: 36 },
    { id: 'action', label: 'Action', placeholder: 'ENABLE หรือ DISABLE', max: 7 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handlePriceManageSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_manage_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PRICE_MANAGE' },
  contextFor(interaction, 'price_manage_load'), { pool: runtime.pool });
  const action = interaction.fields.getTextInputValue('action').trim().toUpperCase();
  if (!['ENABLE', 'DISABLE'].includes(action)) throw new TypeError('Action ต้องเป็น ENABLE หรือ DISABLE');
  const priceRuleId = interaction.fields.getTextInputValue('rule_id').trim();
  const current = (await runtime.pool.query('SELECT state_version FROM price_rules WHERE id=$1', [priceRuleId])).rows[0];
  if (!current) throw new QuestshopError('PRICE_RULE_NOT_FOUND', 'ไม่พบ Price rule');
  const rule = await setPriceRuleEnabled({ priceRuleId: interaction.fields.getTextInputValue('rule_id').trim(),
    enabled: action === 'ENABLE', expectedVersion: current.state_version,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'price_manage_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`Price rule \`${rule.id}\` เป็น **${rule.enabled ? 'ENABLE' : 'DISABLE'}** แล้ว`);
}
}

async function handlePromotionCreate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_create' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PROMOTION_CREATE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'promo_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('promo_create_submit', session.id, 'สร้าง Promotion', [
    { id: 'name', label: 'ชื่อ Promotion', max: 100 },
    { id: 'period', label: 'เริ่ม | จบ (ISO 8601)', placeholder: '2026-08-01T00:00:00+07:00 | 2026-09-01T00:00:00+07:00', max: 120 },
    { id: 'tiers', label: 'Tier: บาท=เปอร์เซ็นต์', placeholder: '100=10, 300=15, 600=20', max: 300 },
    { id: 'limits', label: 'ครั้ง/User | โบนัสสูงสุด/วัน', placeholder: '1 | 500.00 (เว้นว่างได้)', required: false, max: 80 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handlePromotionCreateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_create_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PROMOTION_CREATE' },
  contextFor(interaction, 'promo_load'), { pool: runtime.pool });
  const [startText, endText] = interaction.fields.getTextInputValue('period').split('|').map((value) => value.trim());
  const startsAt = new Date(startText); const endsAt = new Date(endText);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new TypeError('ช่วงเวลา Promotion ไม่ถูกต้อง');
  const tiers = interaction.fields.getTextInputValue('tiers').split(',').map((entry) => {
    const [amount, percent] = entry.split('=').map((value) => value.trim());
    const basisPoints = Math.round(Number(percent) * 100);
    if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) throw new TypeError('Promotion tier ไม่ถูกต้อง');
    return { minimumAmountCents: parseBahtToCents(amount), basisPoints };
  });
  const limitsText = interaction.fields.getTextInputValue('limits').trim();
  const [usesText, bonusText] = limitsText ? limitsText.split('|').map((value) => value.trim()) : [];
  const maxUsesPerUser = usesText ? Number(usesText) : null;
  if (maxUsesPerUser != null && (!Number.isInteger(maxUsesPerUser) || maxUsesPerUser <= 0)) throw new TypeError('Promotion usage limit ไม่ถูกต้อง');
  const promotion = await createPromotion({ name: interaction.fields.getTextInputValue('name'),
    startsAt, endsAt, tiers, maxUsesPerUser,
    maxBonusPerDayCents: bonusText ? parseBahtToCents(bonusText) : null,
    activate: true, reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'promo_create_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`สร้างและเปิด Promotion **${promotion.name}** v${promotion.version} แล้ว`);
}
}

async function handlePromotionManage({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_manage' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PROMOTION_MANAGE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'promo_manage_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('promo_manage_submit', session.id, 'เปิด / ปิด Promotion', [
    { id: 'promotion_id', label: 'Promotion ID', max: 36 },
    { id: 'state', label: 'State', placeholder: 'DRAFT / ACTIVE / DISABLED', max: 8 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handlePromotionManageSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_manage_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PROMOTION_MANAGE' },
  contextFor(interaction, 'promo_manage_load'), { pool: runtime.pool });
  const promotionId = interaction.fields.getTextInputValue('promotion_id').trim();
  const current = (await runtime.pool.query('SELECT state_version FROM promotions WHERE id=$1', [promotionId])).rows[0];
  if (!current) throw new QuestshopError('PROMOTION_NOT_FOUND', 'ไม่พบ Promotion');
  const promotion = await setPromotionState({ promotionId,
    state: interaction.fields.getTextInputValue('state').trim().toUpperCase(),
    expectedVersion: current.state_version,
    reason: interaction.fields.getTextInputValue('reason').trim() }, contextFor(interaction, 'promo_manage_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`Promotion **${promotion.name}** เป็น **${promotion.state}** แล้ว`);
}
}

async function handleReceiverActivate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Receiver ใช้ได้เฉพาะ Owner');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'RECEIVER_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'receiver_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('receiver_activate_submit', session.id, 'Receiver version ใหม่', [
    { id: 'phone', label: 'เบอร์ TrueMoney 10 หลัก', max: 10 },
    { id: 'reason', label: 'เหตุผลการเปลี่ยน Receiver', long: true, max: 500 },
  ]));
}
}

async function handleReceiverActivateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Receiver ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'RECEIVER_PREPARE' },
  contextFor(interaction, 'receiver_load'), { pool: runtime.pool });
  const phone = interaction.fields.getTextInputValue('phone').trim();
  if (!/^0\d{9}$/.test(phone)) throw new TypeError('เบอร์ Receiver ไม่ถูกต้อง');
  const payload = { phone, reason: interaction.fields.getTextInputValue('reason').trim() };
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'RECEIVER_CONFIRM', payload, configVersion: runtime.config.version },
  contextFor(interaction, 'receiver_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยันเปิด Receiver ใหม่ ***-***-${phone.slice(-4)}**\nรายการใหม่จะใช้เบอร์นี้ทันที ส่วนรายการเดิมคง Snapshot เดิม\nเหตุผล: ${payload.reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('receiver_activate_confirm', confirm.id)).setLabel('ยืนยัน Receiver ใหม่')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleReceiverActivateConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate_confirm' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Receiver ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'RECEIVER_CONFIRM' },
  contextFor(interaction, 'receiver_confirm_load'), { pool: runtime.pool });
  const receiver = await activateReceiver({ phone: session.payload.phone, env: runtime.env,
    reason: session.payload.reason }, contextFor(interaction, 'receiver_activate_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`เปิด Receiver v${receiver.version} (***-***-${receiver.phone_last4}) แล้ว`);
}
}

async function handleMonitorAdd({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_add' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Monitor ใช้ได้เฉพาะ Owner');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'MONITOR_ADD',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'monitor_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('monitor_add_submit', session.id, 'เพิ่ม Monitor Account', [
    { id: 'token', label: 'Discord Token', long: true, max: 300 },
    { id: 'capabilities', label: 'Capabilities', placeholder: 'SCAN,TEST', max: 20 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handleMonitorAddSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_add_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Monitor ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'MONITOR_ADD' },
  contextFor(interaction, 'monitor_load'), { pool: runtime.pool });
  const monitor = await addMonitor({ token: interaction.fields.getTextInputValue('token'),
    capabilities: interaction.fields.getTextInputValue('capabilities').split(',').map((value) => value.trim().toUpperCase()),
    env: runtime.env, reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'monitor_add_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`เพิ่ม Monitor **${monitor.username}** (\`${monitor.account_id}\`) แล้ว โดย Token ถูกเข้ารหัสและไม่สามารถเปิดดูจาก Admin ได้`);
}
}

async function handleMonitorManage({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_manage' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Monitor ใช้ได้เฉพาะ Owner');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'MONITOR_MANAGE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'monitor_manage_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('monitor_manage_submit', session.id, 'Manage Monitor', [
    { id: 'monitor_id', label: 'Monitor ID', max: 36 },
    { id: 'state', label: 'State', placeholder: 'ACTIVE / QUARANTINED / DISABLED', max: 16 },
    { id: 'token', label: 'Token ใหม่ (เว้นว่างถ้าไม่ Rotate)', long: true, required: false, max: 300 },
    { id: 'reason', label: 'เหตุผล / หลักฐาน', long: true, max: 500 },
  ]));
}
}

async function handleMonitorManageSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_manage_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Monitor ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'MONITOR_MANAGE' },
  contextFor(interaction, 'monitor_manage_load'), { pool: runtime.pool });
  const monitorId = interaction.fields.getTextInputValue('monitor_id').trim();
  const state = interaction.fields.getTextInputValue('state').trim().toUpperCase();
  const token = interaction.fields.getTextInputValue('token').trim();
  const reason = interaction.fields.getTextInputValue('reason').trim();
  let monitor;
  if (token) monitor = await rotateMonitorCredential({ monitorId, token, env: runtime.env, reason },
    contextFor(interaction, 'monitor_rotate_execute'), { pool: runtime.pool });
  if (!token || state !== 'ACTIVE') monitor = await setMonitorState({ monitorId, state, reason },
    contextFor(interaction, 'monitor_state_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`Monitor \`${monitor.id}\` เป็น **${monitor.state}** แล้ว${token ? ' และ Token ถูก Rotate แบบเข้ารหัส' : ''}`);
}
}

async function handleDlqAction({ interaction, route, runtime, gates: _gates }) {
if (['dlq_replay', 'dlq_discard'].includes(route.route) && interaction.isButton()) {
  if (route.route === 'dlq_discard' && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Discard DLQ ใช้ได้เฉพาะ Owner');
  const operation = route.route === 'dlq_replay' ? 'DLQ_REPLAY' : 'DLQ_DISCARD';
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation,
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'dlq_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal(route.route === 'dlq_replay' ? 'dlq_replay_submit' : 'dlq_discard_submit',
    session.id, operation, [
      { id: 'dlq_id', label: 'DLQ ID', max: 36 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]));
}
}

async function handleDlqSubmit({ interaction, route, runtime, gates: _gates }) {
if (['dlq_replay_submit', 'dlq_discard_submit'].includes(route.route) && interaction.isModalSubmit()) {
  const replay = route.route === 'dlq_replay_submit';
  if (!replay && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Discard DLQ ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const operation = replay ? 'DLQ_REPLAY' : 'DLQ_DISCARD';
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation },
  contextFor(interaction, 'dlq_load'), { pool: runtime.pool });
  const input = { dlqId: interaction.fields.getTextInputValue('dlq_id').trim(),
    reason: interaction.fields.getTextInputValue('reason').trim() };
  const result = replay
    ? await replayDeadLetter(input, contextFor(interaction, 'dlq_replay_execute'), { pool: runtime.pool })
    : await discardDeadLetter({ ...input, isOwner: true }, contextFor(interaction, 'dlq_discard_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`${operation} สำเร็จ: \`${replay ? result.replayOutboxId : result.id}\``);
}
}

async function handleConcurrency({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'config_concurrency' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'CONFIG_CONCURRENCY',
    payload: { expectedVersion: runtime.config.version }, configVersion: runtime.config.version },
  contextFor(interaction, 'config_concurrency_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('config_concurrency_submit', session.id, 'Runner Concurrency', [
    { id: 'concurrency', label: `จำนวน Worker (1-${runtime.env.RUNNER_CONCURRENCY_HARD_MAX})`, max: 1 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

async function handleConcurrencySubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'config_concurrency_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'CONFIG_CONCURRENCY' },
  contextFor(interaction, 'config_concurrency_load'), { pool: runtime.pool });
  const concurrency = Number(interaction.fields.getTextInputValue('concurrency').trim());
  if (!Number.isInteger(concurrency) || concurrency < 1
    || concurrency > runtime.env.RUNNER_CONCURRENCY_HARD_MAX) throw new TypeError('Runner concurrency ไม่ถูกต้อง');
  const changed = await updateRuntimeConfig({ patch: { runnerConcurrency: concurrency },
    expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'config_concurrency_execute'), { pool: runtime.pool });
  runtime.config = await loadRuntimeConfig(runtime.pool);
  interaction.client.questshop.config = runtime.config;
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`ตั้ง Runner concurrency เป็น **${concurrency}** แล้ว (Config v${changed.version})`);
}
}

async function handleConfig({ interaction, route, runtime, gates: _gates }) {
if (['config_branding', 'config_roles'].includes(route.route) && interaction.isButton()) {
  const roles = route.route === 'config_roles';
  if (roles && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Role config ใช้ได้เฉพาะ Owner');
  const operation = roles ? 'CONFIG_ROLES' : 'CONFIG_BRANDING';
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation,
    payload: { expectedVersion: runtime.config.version }, configVersion: runtime.config.version },
  contextFor(interaction, 'config_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal(roles ? 'config_roles_submit' : 'config_branding_submit',
    session.id, roles ? 'Roles Config' : 'Branding Config', roles ? [
      { id: 'admin_role', label: 'Admin Role ID (เว้นว่าง=ปิด)', required: false, max: 20 },
      { id: 'quest_role', label: 'Quest announcement Role ID', required: false, max: 20 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ] : [
      { id: 'title', label: 'ชื่อแผง Quest Auto', max: 256 },
      { id: 'description', label: 'คำอธิบาย', long: true, max: 2000 },
      { id: 'media_url', label: 'Media URL (เว้นว่างได้)', required: false, max: 500 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]));
}
}

async function handleConfigSubmit({ interaction, route, runtime, gates: _gates }) {
if (['config_roles_submit', 'config_branding_submit'].includes(route.route) && interaction.isModalSubmit()) {
  const roles = route.route === 'config_roles_submit';
  if (roles && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Role config ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const operation = roles ? 'CONFIG_ROLES' : 'CONFIG_BRANDING';
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation },
  contextFor(interaction, 'config_load'), { pool: runtime.pool });
  let patch;
  if (roles) {
    const adminRoleId = interaction.fields.getTextInputValue('admin_role').trim() || null;
    const questAnnouncementRoleId = interaction.fields.getTextInputValue('quest_role').trim() || null;
    if ([adminRoleId, questAnnouncementRoleId].some((id) => id && !/^\d{17,20}$/.test(id))) throw new TypeError('Role ID ไม่ถูกต้อง');
    patch = { adminRoleId, questAnnouncementRoleId };
  } else {
    const mediaUrl = interaction.fields.getTextInputValue('media_url').trim() || null;
    if (mediaUrl) {
      const parsed = new URL(mediaUrl);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new TypeError('Media URL ต้องเป็น HTTP(S)');
    }
    patch = { branding: { title: interaction.fields.getTextInputValue('title').trim(),
      description: interaction.fields.getTextInputValue('description').trim(), mediaUrl } };
  }
  const changed = await updateRuntimeConfig({ patch, expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'config_execute'), { pool: runtime.pool });
  runtime.config = await loadRuntimeConfig(runtime.pool);
  interaction.client.questshop.config = runtime.config;
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`อัปเดต Config เป็น v${changed.version} แล้ว การเปลี่ยน Branding จะใช้ในการ Refresh/Setup Surface รอบถัดไป`);
}
}

async function handleBreakerPrepare({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'breaker_prepare' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Circuit breaker ใช้ได้เฉพาะ Owner');
  const breaker = (await runtime.pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'BREAKER_CHANGE',
    payload: { breakerKey: breaker.breaker_key, expectedVersion: String(breaker.state_version),
      beforeState: breaker.state }, configVersion: runtime.config.version },
  contextFor(interaction, 'breaker_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('breaker_submit', session.id, `Circuit ${breaker.state}`, [
    { id: 'state', label: 'สถานะใหม่', placeholder: 'HALF_OPEN หรือ CLOSED', max: 10 },
    { id: 'reason', label: 'หลักฐานและเหตุผล', long: true, max: 500 },
  ]));
}
}

async function handleBreakerSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'breaker_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Circuit breaker ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'BREAKER_CHANGE' },
  contextFor(interaction, 'breaker_load'), { pool: runtime.pool });
  const breaker = await setCircuitBreakerState({ breakerKey: session.payload.breakerKey,
    nextState: interaction.fields.getTextInputValue('state').trim().toUpperCase(),
    expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'breaker_execute'), { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`Circuit **${breaker.breaker_key}** เป็น **${breaker.state}** แล้ว${breaker.state === 'HALF_OPEN' ? ' โดย Payment worker จะทำ Probe หนึ่งรายการ' : ''}`);
}
}

async function handleGatePick({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'admin_gate_pick' && interaction.isStringSelectMenu()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Feature Gates ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const gate = (await runtime.pool.query('SELECT * FROM feature_gates WHERE gate=$1', [interaction.values[0]])).rows[0];
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_GATE',
    payload: { gate: gate.gate, expectedVersion: Number(gate.version) }, configVersion: runtime.config.version },
  contextFor(interaction, 'admin_gate_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `**${gate.gate}** ขณะนี้ ${gate.enabled ? 'เปิด' : 'ปิด'} (v${gate.version})`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('gate_enable', session.id)).setLabel('เปิด').setStyle(ButtonStyle.Success).setDisabled(gate.enabled),
      new ButtonBuilder().setCustomId(customId('gate_disable', session.id)).setLabel('ปิด').setStyle(ButtonStyle.Danger).setDisabled(!gate.enabled),
    )] });
}
}

async function handleGateToggle({ interaction, route, runtime, gates: _gates }) {
if (['gate_enable','gate_disable'].includes(route.route) && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Feature Gates ใช้ได้เฉพาะ Owner');
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_GATE' }, contextFor(interaction, 'admin_gate_load'), { pool: runtime.pool });
  return interaction.showModal(gateReasonModal(route.sessionId, route.route === 'gate_enable'));
}
}

async function handleGateSubmit({ interaction, route, runtime, gates: _gates }) {
if (['gate_enable_submit','gate_disable_submit'].includes(route.route) && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'Feature Gates ใช้ได้เฉพาะ Owner');
  await interaction.deferReply({ ephemeral: true });
  const context = contextFor(interaction, 'admin_gate_change');
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_GATE' }, context, { pool: runtime.pool });
  const changed = await updateFeatureGate({ gate: session.payload.gate,
    enabled: route.route === 'gate_enable_submit', reason: interaction.fields.getTextInputValue('reason'),
    expectedVersion: session.payload.expectedVersion }, context, { pool: runtime.pool });
  await runtime.pool.query("UPDATE interaction_sessions SET state='TERMINAL',state_version=state_version+1 WHERE id=$1", [session.id]);
  return interaction.editReply(`อัปเดต **${changed.gate}** เป็น ${changed.enabled ? 'เปิด' : 'ปิด'} (v${changed.version}) แล้ว`);
}
}

const ROUTE_HANDLERS = Object.freeze({
  "start": handleStart,
  "topup": handleTopup,
  "payment_method": handlePaymentMethod,
  "voucher_submit": handleVoucherSubmit,
  "token_submit": handleTokenSubmit,
  "quest_prev": handleQuestPaging,
  "quest_next": handleQuestPaging,
  "quest_select": handleQuestSelect,
  "quest_all": handleQuestAll,
  "quest_quote": handleQuestQuote,
  "quest_confirm": handleQuestConfirm,
  "admin": handleAdminPanel,
  "wallet_adjust": handleWalletAdjust,
  "wallet_adjust_submit": handleWalletAdjustSubmit,
  "wallet_adjust_confirm": handleWalletAdjustConfirm,
  "refund_prepare": handleRefundPrepare,
  "refund_prepare_submit": handleRefundPrepareSubmit,
  "refund_confirm": handleRefundConfirm,
  "block_add": handleBlockAction,
  "block_remove": handleBlockAction,
  "block_add_submit": handleBlockSubmit,
  "block_remove_submit": handleBlockSubmit,
  "review_resolve": handleReviewResolve,
  "review_resolve_submit": handleReviewResolveSubmit,
  "review_resolve_confirm": handleReviewResolveConfirm,
  "perm_repair": handlePermissionRepair,
  "perm_repair_submit": handlePermissionRepairSubmit,
  "perm_repair_confirm": handlePermissionRepairConfirm,
  "catalog_sale": handleCatalogSale,
  "catalog_sale_submit": handleCatalogSaleSubmit,
  "adminorder_review": handleOrderReview,
  "adminorder_review_submit": handleOrderReviewSubmit,
  "price_create": handlePriceCreate,
  "price_create_submit": handlePriceCreateSubmit,
  "price_manage": handlePriceManage,
  "price_manage_submit": handlePriceManageSubmit,
  "promo_create": handlePromotionCreate,
  "promo_create_submit": handlePromotionCreateSubmit,
  "promo_manage": handlePromotionManage,
  "promo_manage_submit": handlePromotionManageSubmit,
  "receiver_activate": handleReceiverActivate,
  "receiver_activate_submit": handleReceiverActivateSubmit,
  "receiver_activate_confirm": handleReceiverActivateConfirm,
  "monitor_add": handleMonitorAdd,
  "monitor_add_submit": handleMonitorAddSubmit,
  "monitor_manage": handleMonitorManage,
  "monitor_manage_submit": handleMonitorManageSubmit,
  "dlq_replay": handleDlqAction,
  "dlq_discard": handleDlqAction,
  "dlq_replay_submit": handleDlqSubmit,
  "dlq_discard_submit": handleDlqSubmit,
  "config_concurrency": handleConcurrency,
  "config_concurrency_submit": handleConcurrencySubmit,
  "config_branding": handleConfig,
  "config_roles": handleConfig,
  "config_roles_submit": handleConfigSubmit,
  "config_branding_submit": handleConfigSubmit,
  "breaker_prepare": handleBreakerPrepare,
  "breaker_submit": handleBreakerSubmit,
  "admin_gate_pick": handleGatePick,
  "gate_enable": handleGateToggle,
  "gate_disable": handleGateToggle,
  "gate_enable_submit": handleGateSubmit,
  "gate_disable_submit": handleGateSubmit,
});

async function dispatchRoute(context) {
  const handler = ROUTE_HANDLERS[context.route.route];
  if (!handler) return null;
  return handler(context);
}

export async function routeInteraction(interaction) {
  const runtime = interaction.client.questshop;
  try {
    if (!interaction.inGuild() || interaction.guildId !== runtime.env.DISCORD_GUILD_ID) return;
    if (await handleSurfaceCommand(interaction, runtime)) return;
    const route = parseCustomId(interaction.customId);
    if (!route) return;
    const gates = await authorizeRoute(interaction, route, runtime);
    return dispatchRoute({ interaction, route, runtime, gates });
  } catch (error) {
    runtime.logger.error({ error: safeError(error), interactionId: interaction.id }, 'interaction failed');
    return ephemeralError(interaction, error).catch(() => null);
  }
}

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, ModalBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown,
} from 'discord.js';
import { v7 as uuidv7 } from 'uuid';
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
import { minimumConfiguredPrice, minimumSellablePrice } from '../../domain/pricing/resolver.js';
import { withTransaction } from '../../db/transaction.js';
import { FEATURE_GATES } from '../../config/feature-gates.js';
import {
  bindSessionMessage,
  createAdminSession,
  loadAdminSession,
  terminateAdminSession,
} from '../../domain/admin/session-service.js';
import {
  createPromotion, setPriceRule, setPriceRuleEnabled, setPromotionState, updateFeatureGate, updateRuntimeConfig,
} from '../../domain/admin/config-service.js';
import { adjustWalletAsAdmin } from '../../domain/admin/money-service.js';
import { refundCapturedOrderItem } from '../../domain/wallet/service.js';
import { blockUser, unblockUser } from '../../domain/blocklist/service.js';
import { addEvidence, assignReview, resolveSubjectReview } from '../../domain/reviews/service.js';
import { parseBahtToCents } from '../../shared/money.js';
import { activateReceiver } from '../../domain/admin/receiver-service.js';
import {
  addMonitor, checkAllMonitorHealth, checkMonitorHealth, rotateMonitorCredential, setMonitorState,
} from '../../domain/admin/monitor-service.js';
import {
  forcePublishFailedMonitorTest, openOrderItemReview, setCircuitBreakerState, setQuestSaleState,
} from '../../domain/admin/operations-service.js';
import { loadTestFailureAlert, retryFailedTestAlert } from '../../domain/catalog/test-gate.js';
import { discardDeadLetter, replayDeadLetter } from '../../domain/outbox/dlq-service.js';
import { loadRuntimeConfig } from '../../config/runtime-config.js';
import { APP_VERSION, ENGINE_VERSION } from '../../config/versions.js';
import {
  baht,
  renderOrderConfirmation,
  renderPaymentMethod,
  renderQuote,
  renderSelection,
  renderTopupProcessing,
  renderTopupResult,
} from '../renderers/checkout.js';
import { waitForCustomerTopup } from '../../domain/payments/customer-status.js';
import { adminNavigationComponents } from '../renderers/admin.js';
import { featureGateLabel, orderStateLabel, saleStateLabel } from '../renderers/labels.js';

function money(cents) { return baht(cents); }
function escapedText(value, fallback = 'ไม่ระบุ') {
  return escapeMarkdown(String(value ?? fallback).replaceAll('@', '@\u200b'));
}

export function parsePromotionBasisPoints(rawPercent) {
  const text = String(rawPercent).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new TypeError('ระดับโบนัสโปรโมชั่นไม่ถูกต้อง');
  const [whole, fraction = ''] = text.split('.');
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new TypeError('ระดับโบนัสโปรโมชั่นไม่ถูกต้อง');
  }
  return basisPoints;
}
function monitorHealthLabel(monitorState, healthState) {
  if (monitorState === 'DISABLED') {
    return healthState === 'READY' ? '⚪ พักใช้งาน (Token ปกติ)' : '⚪ พักใช้งาน (Token มีปัญหา)';
  }
  if (healthState === 'READY') return '🟢 พร้อม';
  if (healthState === 'DEGRADED') return '🟡 มีปัญหาชั่วคราว';
  return '🔴 ใช้ไม่ได้';
}
function monitorDetailHealthLabel(healthState) {
  if (healthState === 'READY') return '🟢 พร้อมใช้งาน';
  if (healthState === 'DEGRADED') return '🟡 มีปัญหาชั่วคราว';
  if (healthState === 'INVALID') return '🔴 Token ใช้ไม่ได้';
  return '⚫ ยังไม่ตรวจ';
}
const DISPLAY_STATES = Object.freeze({
  ACTIVE: 'เปิดใช้งาน', INACTIVE: 'ไม่ได้ใช้งาน', DISABLED: 'พักใช้งาน', DRAFT: 'แบบร่าง',
  SCHEDULED: 'ตั้งเวลาไว้', OPEN: 'เปิดอยู่', CLOSED: 'ปิดอยู่', PAUSED: 'พักชั่วคราว', EXPIRED: 'หมดอายุ',
  READY: 'พร้อม', DEGRADED: 'มีปัญหาชั่วคราว', INVALID: 'ใช้ไม่ได้', QUARANTINED: 'ระงับอัตโนมัติ',
  PENDING: 'รอดำเนินการ', LEASED: 'กำลังดำเนินการ', RUNNING: 'กำลังทำงาน', COMPLETED: 'เสร็จแล้ว',
  VERIFIED: 'ตรวจสอบแล้ว', FAILED: 'ไม่สำเร็จ', RESOLVED: 'จัดการแล้ว', DEAD_LETTER: 'รอตรวจสอบงานค้าง',
  HALF_OPEN: 'กำลังทดสอบการกลับมาใช้งาน', CREDITED: 'เพิ่มเครดิตแล้ว', REJECTED: 'ปฏิเสธรายการ',
  ASSIGNED: 'มีผู้รับผิดชอบแล้ว', EVIDENCE_PENDING: 'รอหลักฐาน', DECISION_READY: 'พร้อมสรุปผล',
});
const PRICE_RULE_LABELS = Object.freeze({ TEMPORARY: 'ราคาพิเศษชั่วคราว', QUEST: 'ราคาเฉพาะ Quest',
  TYPE: 'ราคาตามประเภท', DEFAULT: 'ราคาเริ่มต้น' });
const ANALYSIS_LABELS = Object.freeze({ DETECTED: 'ตรวจพบแล้ว', METADATA_RETRY: 'กำลังอ่านข้อมูลใหม่',
  ANALYZED: 'วิเคราะห์แล้ว', SUPPORTED: 'ระบบรองรับ', UNSUPPORTED: 'ระบบยังไม่รองรับ',
  MANUAL_REVIEW: 'รอแอดมินตรวจสอบ', EXPIRED: 'หมดอายุแล้ว' });
const SURFACE_LABELS = Object.freeze({ QUEST_AUTO: 'ห้องเริ่มทำ Quest', QUEST_NEW: 'ห้องประกาศ Quest ใหม่',
  QUEST_HISTORY: 'ห้องประวัติการทำ Quest', ADMIN_PANEL: 'แผงควบคุมแอดมิน', LOG_PAYMENTS: 'บันทึกการเติมเงิน',
  LOG_QUEST_OPERATIONS: 'บันทึกการทำ Quest', LOG_ADMIN: 'บันทึกการทำงานของแอดมิน', LOG_SYSTEM: 'บันทึกเหตุขัดข้อง' });
const BLOCK_LABELS = Object.freeze({ TOPUP_BLOCKED: 'ระงับการเติมเงิน', ORDER_BLOCKED: 'ระงับการสั่งทำ Quest' });
const SUBJECT_LABELS = Object.freeze({ TOPUP: 'รายการเติมเงิน', ORDER: 'ออเดอร์', ORDER_ITEM: 'งาน Quest', QUEST: 'Quest' });
const REVIEW_DECISION_LABELS = Object.freeze({ CREDIT: 'เพิ่มเครดิต', REJECT: 'ปฏิเสธ', RETRY: 'ลองใหม่',
  CAPTURE: 'คิดค่าบริการ', RELEASE: 'คืนเครดิต', STOP: 'หยุดงาน', FAIL: 'บันทึกว่าล้มเหลว' });
function displayState(value) { return DISPLAY_STATES[value] ?? 'กำลังตรวจสอบ'; }
function breakerStateLabel(value) {
  return { CLOSED: 'เปิดทำงานปกติ', OPEN: 'หยุดรับรายการอัตโนมัติ', HALF_OPEN: 'กำลังทดสอบการกลับมาใช้งาน' }[value]
    ?? 'กำลังตรวจสอบ';
}
function normalizedChoice(value, aliases) {
  const normalized = String(value).trim().toUpperCase();
  return aliases[normalized] ?? normalized;
}
function latestBackupTime(rows) {
  const completedAt = rows[0]?.completed_at;
  return typeof completedAt?.toISOString === 'function' ? completedAt.toISOString() : 'ยังไม่มี';
}
function websocketPing(client) {
  const ping = client.ws?.ping;
  return Number.isFinite(ping) && ping >= 0 ? `${ping} ms` : 'กำลังเชื่อมต่อ';
}
function overviewRuntimeMetrics(interaction, runtime) {
  const health = runtime.health ?? {};
  const overview = health.overview ?? {};
  const workers = Object.values(health.workers ?? {});
  const healthyWorkers = workers.filter((worker) => worker.state === 'RUNNING').length;
  const uptimeMs = Math.max(0, Date.now() - Date.parse(health.startedAt ?? Date.now()));
  return {
    overview,
    workers,
    healthyWorkers,
    uptimeMinutes: Math.floor(uptimeMs / 60_000),
    backupAge: overview.backupAgeMs == null ? 'ยังไม่มี' : `${Math.floor(overview.backupAgeMs / 3_600_000)} ชม.`,
    rssMb: overview.memoryRssBytes == null ? 'ยังไม่มี' : `${Math.round(overview.memoryRssBytes / 1024 / 1024)} MB`,
    ping: websocketPing(interaction.client),
  };
}
function overviewDescription({ backup, incidents, metrics, queue, reviews, row }) {
  const { workers, healthyWorkers, uptimeMinutes, backupAge, ping } = metrics;
  return [
    '**ภาพรวมการเงิน**',
    `ลูกค้าที่มีเครดิต: **${row.users} คน**`, `เครดิตพร้อมใช้รวม: **${money(row.available)}**`, `เครดิตที่จองรวม: **${money(row.reserved)}**`,
    '', '**งานที่ต้องดูแล**',
    `งานในคิว: **${queue.rows[0].count}** • รอตรวจสอบ: **${reviews.rows[0].count}** • เหตุขัดข้อง: **${incidents.rows[0].count}**`,
    '', '**สุขภาพระบบ**',
    `Worker พร้อมทำงาน: **${healthyWorkers}/${workers.length}** • Ping: **${ping}** • เปิดมาแล้ว: **${uptimeMinutes} นาที**`,
    `สำรองข้อมูลล่าสุด: **${latestBackupTime(backup.rows)}** • อายุไฟล์สำรอง: **${backupAge}**`,
  ].join('\n');
}
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
async function completeInteractionSession(session, interaction, runtime) {
  return terminateAdminSession({ sessionId: session.id, actorId: interaction.user.id,
    guildId: interaction.guildId, expectedVersion: session.state_version },
  contextFor(interaction, 'interaction_session_complete'), { pool: runtime.pool });
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
  const input = new TextInputBuilder().setCustomId('token').setStyle(TextInputStyle.Paragraph)
    .setRequired(true).setMinLength(20).setMaxLength(300).setPlaceholder('วาง Token ของบัญชีที่ต้องการทำ Quest');
  return new ModalBuilder().setCustomId(customId('token_submit', sessionId)).setTitle('ตรวจบัญชี Quest')
    .addLabelComponents(new LabelBuilder().setLabel('Discord Token')
      .setDescription('Token จะถูกเข้ารหัส ใช้เฉพาะ Order นี้ และไม่แสดงให้แอดมินเห็น').setTextInputComponent(input));
}
function voucherModal(sessionId) {
  const input = new TextInputBuilder().setCustomId('url')
    .setPlaceholder('https://gift.truemoney.com/campaign/?v=...').setStyle(TextInputStyle.Short).setRequired(true);
  return new ModalBuilder().setCustomId(customId('voucher_submit', sessionId)).setTitle('เติมเงิน TrueMoney Gift')
    .addLabelComponents(new LabelBuilder().setLabel('ลิงก์ซองอั่งเปา')
      .setDescription('รองรับซองผู้รับคนเดียว กรุณาตรวจยอดก่อนส่ง').setTextInputComponent(input));
}
function gateReasonModal(sessionId, enabled) {
  const input = new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph)
    .setRequired(true).setMinLength(5).setMaxLength(500);
  return new ModalBuilder().setCustomId(customId(enabled ? 'gate_enable_submit' : 'gate_disable_submit', sessionId))
    .setTitle(enabled ? 'เปิดระบบ' : 'ปิดระบบ')
    .addLabelComponents(new LabelBuilder().setLabel('เหตุผลการเปลี่ยนแปลง').setTextInputComponent(input));
}
function fieldsModal(route, sessionId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId(route, sessionId)).setTitle(title);
  for (const field of fields) {
    const input = new TextInputBuilder().setCustomId(field.id)
      .setStyle(field.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required !== false).setMaxLength(field.max ?? 500);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    const label = new LabelBuilder().setLabel(field.label).setTextInputComponent(input);
    if (field.description) label.setDescription(field.description);
    modal.addLabelComponents(label);
  }
  return modal;
}
function parseSignedBaht(value) {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const amount = parseBahtToCents(negative ? text.slice(1) : text);
  return negative ? -amount : amount;
}
function listRows(rows, formatter, empty = 'ไม่มี') {
  const content = rows.map(formatter).join('\n');
  return content || empty;
}

function backupSummary(backups, drills) {
  const backupRows = listRows(backups, (row) => `• ${row.backup_type === 'PRE_MIGRATION' ? 'ก่อนอัปเดตฐานข้อมูล' : 'สำรองข้อมูลประจำวัน'} • ${displayState(row.state)} • <t:${Math.floor(new Date(row.completed_at ?? row.started_at).getTime() / 1000)}:R>`);
  const drillRows = listRows(drills, (row) => `• ${displayState(row.state)} • <t:${Math.floor(new Date(row.completed_at ?? row.started_at).getTime() / 1000)}:R>`);
  return `**ไฟล์สำรองล่าสุด**\n${backupRows}\n\n**ผลทดสอบกู้ข้อมูลล่าสุด**\n${drillRows}\n\nการทดสอบกู้ข้อมูลทำในฐานข้อมูลชั่วคราวและไม่กระทบร้านที่กำลังเปิดอยู่`;
}

function brandingSummary(runtime) {
  const values = runtime.config.values ?? {};
  const adminRole = values.adminRoleId ? `<@&${values.adminRoleId}>` : 'ยังไม่ตั้ง';
  const questRole = values.questAnnouncementRoleId ? `<@&${values.questAnnouncementRoleId}>` : 'ปิด';
  const branding = values.branding ?? {};
  const description = String(branding.description ?? 'ใช้ข้อความเริ่มต้น').replaceAll('\n', ' ').slice(0, 180);
  return [
    `**เวอร์ชันการตั้งค่า:** ${runtime.config.version}`,
    `**จำนวนงานพร้อมกัน:** ${runnerConcurrency(runtime)} / ${runtime.env.RUNNER_CONCURRENCY_HARD_MAX}`,
    `**ยศแอดมิน:** ${adminRole}`,
    `**ยศแจ้ง Quest ใหม่:** ${questRole}`,
    '',
    `**ชื่อหน้าร้าน:** ${branding.title ?? 'ใช้ชื่อเริ่มต้น'}`,
    `**คำอธิบาย:** ${description}`,
    `**รูปหรือวิดีโอ:** ${branding.mediaUrl ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้ง'}`,
  ].join('\n');
}

function paymentReviewLine(row) {
  const ownerOnly = row.owner_only ? ' • เจ้าของร้านเป็นผู้สรุปผล' : '';
  const assignee = row.assigned_to ? ` • <@${row.assigned_to}>` : '';
  const evidence = Number(row.evidence_count ?? 0) ? ` • หลักฐาน ${row.evidence_count}` : '';
  return `• \`${row.id}\` • **${SUBJECT_LABELS[row.subject_type] ?? 'รายการตรวจสอบ'}** • ${displayState(row.state)}${assignee}${evidence}${ownerOnly}`;
}

function paymentSummary(breaker, reviews) {
  const header = `ระบบรับซอง: **${breakerStateLabel(breaker.state)}** • ${breaker.reason ?? 'ทำงานปกติ'}`;
  return [header, listRows(reviews, paymentReviewLine, 'ไม่มีรายการรอตรวจสอบ')].join('\n\n');
}

function deadLetterLine(row) {
  return `• \`${row.id}\` • ${row.category === 'FINANCIAL' ? 'เกี่ยวกับเงิน' : 'การแจ้งเตือนทั่วไป'} • ${displayState(row.state)} • รหัสตรวจสอบ \`${row.error_code ?? 'ไม่ระบุ'}\``;
}

function blocklistLine(row) {
  return `• \`${row.discord_user_id}\` • **${BLOCK_LABELS[row.block_type] ?? 'ระงับการใช้งาน'}** • ${row.reason}`;
}

function incidentLine(row) {
  const severity = { CRITICAL: 'วิกฤต', HIGH: 'รุนแรง', WARNING: 'เฝ้าระวัง', INFO: 'แจ้งข้อมูล' }[row.severity] ?? 'ตรวจสอบ';
  return `• ${severity} • **${row.scope ?? 'ระบบ'}** • รหัสตรวจสอบ \`${row.incident_code}\``;
}

function dlqSummary(dlq, incidents) {
  return ['**งานที่ส่งไม่สำเร็จและต้องตรวจ**', listRows(dlq, deadLetterLine, 'ไม่มีงานค้าง'), '',
    '**เหตุขัดข้องที่ยังเปิดอยู่**', listRows(incidents, incidentLine, 'ไม่มีเหตุขัดข้อง')].join('\n');
}

function ownerOnly(interaction, runtime, message) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', message);
}

function panelEmbed(color, title, description) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

function adminReply(interaction, selected, payload) {
  return interaction.editReply({ ...payload,
    components: adminNavigationComponents(selected, payload.components ?? []),
    allowedMentions: { parse: [] } });
}

async function renderGatePanel(interaction, runtime) {
  ownerOnly(interaction, runtime, 'เมนูเปิด–ปิดระบบใช้ได้เฉพาะเจ้าของร้าน');
  const rows = (await runtime.pool.query('SELECT * FROM feature_gates ORDER BY gate')).rows;
  return adminReply(interaction, 'gates', { embeds: [panelEmbed(0x5865f2, 'เปิด–ปิดระบบ',
    listRows(rows, (row) => `${row.enabled ? '🟢' : '🔴'} **${featureGateLabel(row.gate)}**\n${row.reason}`))],
  components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(customId('admin_gate_pick'))
    .setPlaceholder('เลือกระบบที่ต้องการเปิดหรือปิด').addOptions(FEATURE_GATES.map((gate) => ({ label: featureGateLabel(gate), value: gate,
      description: 'แตะเพื่อดูและเปลี่ยนสถานะ' }))))] });
}

function renderWalletPanel(interaction) {
  return adminReply(interaction, 'wallet', { embeds: [panelEmbed(0xf0b232, 'ปรับยอดและคืนเครดิต',
    'การปรับยอดทุกครั้งจะสร้างธุรกรรมชดเชยใหม่ โดยไม่แก้ประวัติเดิม\nระบบจะแสดงยอดก่อน–หลังและให้ยืนยันซ้ำภายใน 5 นาที\nเครดิตที่กำลังจองแก้ตรงจากเมนูนี้ไม่ได้')],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('wallet_adjust')).setLabel('ปรับเครดิตพร้อมใช้').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(customId('refund_prepare')).setLabel('คืนเครดิตงานที่คิดเงินแล้ว').setStyle(ButtonStyle.Primary),
  )] });
}

async function renderBlocklistPanel(interaction, runtime) {
  const blocks = (await runtime.pool.query(`SELECT * FROM blocklist_entries WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY created_at DESC LIMIT 10`)).rows;
  const blockRows = listRows(blocks, blocklistLine, 'ยังไม่มีผู้ใช้ที่ถูกระงับ');
  const description = [blockRows, 'การระงับไม่ริบเครดิตและไม่หยุดงานเดิม'].join('\n\n');
  return adminReply(interaction, 'blocklist', { embeds: [panelEmbed(0xf0b232, 'ระงับการใช้งาน', description)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('block_add')).setLabel('ระงับผู้ใช้').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(customId('block_remove')).setLabel('ยกเลิกการระงับ').setStyle(ButtonStyle.Secondary),
  )] });
}

async function renderPaymentsPanel(interaction, runtime) {
  const reviews = (await runtime.pool.query(`SELECT r.*,count(e.id)::integer AS evidence_count
    FROM manual_reviews r LEFT JOIN review_evidence e ON e.review_id=r.id WHERE r.state<>'RESOLVED'
    GROUP BY r.id ORDER BY r.financial DESC,r.created_at LIMIT 10`)).rows;
  const breaker = (await runtime.pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  return adminReply(interaction, 'payments', { embeds: [panelEmbed(0xf0b232, 'รายการเติมเงินที่ต้องตรวจ', paymentSummary(breaker, reviews))],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('review_assign')).setLabel('รับผิดชอบรายการ')
      .setStyle(ButtonStyle.Primary).setDisabled(!reviews.length),
    new ButtonBuilder().setCustomId(customId('review_evidence')).setLabel('เพิ่มหลักฐาน')
      .setStyle(ButtonStyle.Secondary).setDisabled(!reviews.length),
    new ButtonBuilder().setCustomId(customId('review_resolve')).setLabel('สรุปผลการตรวจ')
      .setStyle(ButtonStyle.Danger).setDisabled(!reviews.length),
    new ButtonBuilder().setCustomId(customId('breaker_prepare')).setLabel('ทดสอบและเปิดระบบรับซองอีกครั้ง')
      .setStyle(ButtonStyle.Secondary).setDisabled(interaction.user.id !== runtime.env.OWNER_ID),
  )] });
}

async function renderSurfacesPanel(interaction, runtime) {
  const surfaces = (await runtime.pool.query('SELECT * FROM surfaces ORDER BY surface_key')).rows;
  return adminReply(interaction, 'surfaces', { embeds: [panelEmbed(0x5865f2, 'ห้องและแผงข้อความ',
    listRows(surfaces, (surface) => `${surface.state === 'ACTIVE' ? '🟢' : '🟠'} **${SURFACE_LABELS[surface.surface_key] ?? 'ห้องของระบบ'}** • <#${surface.channel_id}> • ${displayState(surface.state)}`, 'ยังไม่ได้ติดตั้งห้องหรือแผงข้อความ'))],
    components: [] });
}

async function renderPricingPanel(interaction, runtime) {
  const rules = (await runtime.pool.query(`SELECT * FROM price_rules ORDER BY enabled DESC, created_at DESC LIMIT 10`)).rows;
  return adminReply(interaction, 'pricing', { embeds: [panelEmbed(0x5865f2, 'ตั้งราคา',
    listRows(rules, (rule) => `• \`${rule.id}\` • **${PRICE_RULE_LABELS[rule.rule_type] ?? 'กฎราคา'}** ${rule.quest_id ?? rule.task_type ?? 'ทุก Quest'} — ${money(rule.amount_cents)} • ${rule.enabled ? '🟢 เปิดใช้' : '🔴 ปิดใช้'}`, 'ยังไม่มีกฎราคา'))],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('price_create')).setLabel('สร้างกฎราคา').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('price_manage')).setLabel('เปิด / ปิดกฎราคา').setStyle(ButtonStyle.Secondary).setDisabled(!rules.length),
  )] });
}

async function renderPromotionsPanel(interaction, runtime) {
  const promotions = (await runtime.pool.query('SELECT * FROM promotions ORDER BY version DESC LIMIT 10')).rows;
  return adminReply(interaction, 'promotions', { embeds: [panelEmbed(0x5865f2, 'โปรโมชั่น',
    listRows(promotions, (promotion) => `• \`${promotion.id}\` • **${promotion.name}** • ${displayState(promotion.state)} • สิ้นสุด <t:${Math.floor(new Date(promotion.ends_at).getTime() / 1000)}:R>`, 'ยังไม่มีโปรโมชั่น'))],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('promo_create')).setLabel('สร้างโปรโมชั่น').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('promo_manage')).setLabel('เปิด / ปิดโปรโมชั่น').setStyle(ButtonStyle.Secondary).setDisabled(!promotions.length),
  )] });
}

async function renderReceiversPanel(interaction, runtime) {
  ownerOnly(interaction, runtime, 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  const receivers = (await runtime.pool.query('SELECT * FROM receiver_versions ORDER BY version DESC LIMIT 10')).rows;
  return adminReply(interaction, 'receivers', { embeds: [panelEmbed(0x5865f2, 'เบอร์รับเงิน TrueMoney',
    listRows(receivers, (receiver) => `• รุ่น ${receiver.version} • ***-***-${receiver.phone_last4} • **${displayState(receiver.state)}**`, 'ยังไม่ได้ตั้งเบอร์รับเงิน'))],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('receiver_activate'))
    .setLabel('เพิ่มและเปิดใช้เบอร์ใหม่').setStyle(ButtonStyle.Danger))] });
}

async function renderMonitorsPanel(interaction, runtime) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const [monitorsResult, testsResult] = await Promise.all([
    runtime.pool.query('SELECT * FROM monitor_accounts ORDER BY priority DESC,created_at'),
    runtime.pool.query(`SELECT count(*)::integer AS count FROM quest_test_runs
      WHERE state IN ('TEST_QUEUED','TESTING')`),
  ]);
  const monitors = monitorsResult.rows;
  const summary = {
    ready: monitors.filter((row) => row.health_state === 'READY' && row.state === 'ACTIVE').length,
    degraded: monitors.filter((row) => row.health_state === 'DEGRADED').length,
    unavailable: monitors.filter((row) => ['INVALID', 'QUARANTINED', 'DISABLED'].includes(row.health_state)
      || ['QUARANTINED', 'DISABLED'].includes(row.state)).length,
  };
  const status = (monitor) => {
    if (monitor.state === 'DISABLED') return '⚪ พักใช้งาน';
    if (monitor.state === 'QUARANTINED' || monitor.health_state === 'INVALID') return '🔴 ใช้ไม่ได้';
    if (monitor.health_state === 'READY') return '🟢 พร้อม';
    if (monitor.health_state === 'DEGRADED') return '🟡 ตรวจพบปัญหา';
    return '⚫ ยังไม่ตรวจ';
  };
  const recent = listRows(monitors.slice(0, 10), (monitor) => `• ${status(monitor)} **${escapedText(monitor.username)}** (\`${escapedText(monitor.account_id)}\`)`, 'ยังไม่มี Token สำหรับตรวจสอบ Quest');
  const description = [
    `ทั้งหมด **${monitors.length}** • พร้อม **${summary.ready}** • มีปัญหา **${summary.degraded}** • ใช้ไม่ได้/พัก **${summary.unavailable}**`,
    `กำลังทดสอบ Quest: **${testsResult.rows[0].count}** งาน`, '', recent,
    '', 'ทุกบัญชีใช้ทั้งตรวจหาและทดสอบ Quest • ระบบไม่แสดง Token ในหน้าแอดมิน',
  ].join('\n');
  return adminReply(interaction, 'monitors', { embeds: [panelEmbed(0x5865f2, 'บัญชีตรวจสอบ Quest',
    description)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('monitor_add')).setLabel('เพิ่ม Token').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('monitor_check_all')).setLabel('เช็คระบบ Token').setStyle(ButtonStyle.Secondary).setDisabled(!monitors.length),
    new ButtonBuilder().setCustomId(customId('monitor_list')).setLabel('ดูบัญชีทั้งหมด').setStyle(ButtonStyle.Secondary).setDisabled(!monitors.length),
  )] });
}

function monitorHealthLine(result) {
  const monitor = result.monitor;
  const state = monitorHealthLabel(monitor.state, result.healthState);
  const detail = result.healthState === 'READY'
    ? `อ่าน Quest ได้ ${result.questCount} รายการ`
    : `สาเหตุ: ${result.errorCode}`;
  return `${state} **${escapedText(monitor.username)}** (\`${escapedText(monitor.account_id)}\`) — ${escapedText(detail)}`;
}

async function renderMonitorList(interaction, runtime) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const monitors = (await runtime.pool.query(`SELECT * FROM monitor_accounts
    ORDER BY priority DESC,created_at LIMIT 25`)).rows;
  const description = monitors.length
    ? 'เลือกบัญชีเพื่อดูสถานะ เช็ค Token เปลี่ยน Token หรือพักใช้งาน'
    : 'ยังไม่มี Token สำหรับตรวจสอบ Quest';
  const selectionSession = monitors.length ? await createAdminSession({ actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_SELECT', payload: { monitorIds: monitors.map((monitor) => monitor.id) },
    configVersion: runtime.config.version }, contextFor(interaction, 'monitor_select_session'), { pool: runtime.pool }) : null;
  const components = monitors.length ? [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId('monitor_select', selectionSession.id)).setPlaceholder('เลือกบัญชีตรวจสอบ Quest')
      .addOptions(monitors.map((monitor) => ({
        label: String(monitor.username ?? monitor.account_id).slice(0, 100), value: monitor.id,
        description: `${monitor.account_id} • ${monitorHealthLabel(monitor.state, monitor.health_state)}`.slice(0, 100),
      }))),
  )] : [];
  return adminReply(interaction, 'monitors', { embeds: [panelEmbed(0x5865f2, 'รายการบัญชีตรวจสอบ Quest', description)], components });
}

async function renderMonitorDetail(interaction, runtime, monitorId) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const monitor = (await runtime.pool.query('SELECT * FROM monitor_accounts WHERE id=$1', [monitorId])).rows[0];
  if (!monitor) throw new QuestshopError('MONITOR_NOT_FOUND', 'ไม่พบบัญชี Monitor');
  const health = monitorDetailHealthLabel(monitor.health_state);
  const checked = monitor.last_health_checked_at
    ? `<t:${Math.floor(new Date(monitor.last_health_checked_at).getTime() / 1000)}:R>` : 'ยังไม่เคยตรวจ';
  const description = [
    `**บัญชี:** ${escapedText(monitor.username)}`, `**Account ID:** \`${escapedText(monitor.account_id)}\``,
    `**สถานะบัญชี:** ${displayState(monitor.state)}`, `**สถานะ Token:** ${health}`,
    `**ตรวจล่าสุด:** ${checked}`, `**Quest ตอนตรวจ:** ${monitor.last_health_quest_count ?? 'ไม่ระบุ'}`,
    `**ผลตรวจล่าสุด:** ${monitor.last_health_error_code ? `พบปัญหา • รหัส \`${monitor.last_health_error_code}\`` : 'ไม่พบปัญหา'}`,
    '', 'ปุ่มเช็คบัญชีนี้อ่านข้อมูลบัญชี/Quest เท่านั้น ไม่ทำ Quest จริง',
  ].join('\n');
  const toggle = monitor.state === 'DISABLED' ? 'เปิดใช้งาน' : 'พักบัญชี';
  const session = (operation) => createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null, operation,
    payload: { monitorId: monitor.id }, configVersion: runtime.config.version },
  contextFor(interaction, 'monitor_detail_session'), { pool: runtime.pool });
  const [check, rotate, state] = await Promise.all([
    session('MONITOR_CHECK_ONE'), session('MONITOR_ROTATE'), session('MONITOR_TOGGLE'),
  ]);
  return adminReply(interaction, 'monitors', { embeds: [panelEmbed(0x5865f2, 'รายละเอียดบัญชีตรวจสอบ Quest', description)],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('monitor_check_one', check.id)).setLabel('เช็คบัญชีนี้').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('monitor_rotate', rotate.id)).setLabel('เปลี่ยน Token').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId('monitor_toggle', state.id)).setLabel(toggle).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(customId('monitor_list')).setLabel('กลับไปรายการ').setStyle(ButtonStyle.Secondary),
  )] });
}

async function renderCatalogPanel(interaction, runtime) {
  const quests = (await runtime.pool.query('SELECT * FROM quests ORDER BY updated_at DESC LIMIT 10')).rows;
  return adminReply(interaction, 'catalog', { embeds: [panelEmbed(0x5865f2, 'จัดการ Quest',
    listRows(quests, (quest) => `• \`${quest.quest_id}\` • **${quest.name ?? 'ไม่ระบุ'}**\n${ANALYSIS_LABELS[quest.analysis_state] ?? 'กำลังวิเคราะห์'} • ${saleStateLabel(quest.sale_state)}`, 'ยังไม่มี Quest'))],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('catalog_sale'))
    .setLabel('เปลี่ยนสถานะรับทำ Quest').setStyle(ButtonStyle.Primary))] });
}

async function renderOrdersPanel(interaction, runtime) {
  const items = (await runtime.pool.query(`SELECT i.*,o.account_username FROM order_items i
    JOIN orders o ON o.id=i.order_id WHERE i.state NOT IN ('READY_TO_CLAIM','EXPIRED_RELEASED',
    'EXTERNAL_COMPLETED_RELEASED','STOPPED_RELEASED','FAILED_RELEASED') ORDER BY i.updated_at LIMIT 10`)).rows;
  return adminReply(interaction, 'orders', { embeds: [panelEmbed(0x5865f2, 'งานลูกค้าและคิว',
    listRows(items, (item) => `• \`${item.id}\` • **${item.quest_name}** • ${orderStateLabel(item.state)} • ${item.progress_bucket}%`, 'ไม่มีงาน Quest ที่กำลังดำเนินการ'))],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId('adminorder_review'))
    .setLabel('ตรวจสอบ / หยุด / ลองใหม่').setStyle(ButtonStyle.Danger).setDisabled(!items.length))] });
}

async function renderBackupPanel(interaction, runtime) {
  const [backups, drills] = await Promise.all([
    runtime.pool.query('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 5'),
    runtime.pool.query('SELECT * FROM restore_drills ORDER BY started_at DESC LIMIT 5'),
  ]);
  return adminReply(interaction, 'backup', { embeds: [panelEmbed(0x5865f2, 'สำรองและกู้ข้อมูล', backupSummary(backups.rows, drills.rows))] });
}

function renderBrandingPanel(interaction, runtime) {
  return adminReply(interaction, 'branding', { embeds: [panelEmbed(0x5865f2, 'ตั้งค่าหน้าร้าน', brandingSummary(runtime))],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('config_branding')).setLabel('แก้หน้าร้าน').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(customId('config_concurrency')).setLabel('จำนวนงานพร้อมกัน').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(customId('config_roles')).setLabel('ตั้งยศแอดมิน / แจ้ง Quest').setStyle(ButtonStyle.Danger)
      .setDisabled(interaction.user.id !== runtime.env.OWNER_ID),
  )] });
}

function renderSecretsPanel(interaction, runtime) {
  ownerOnly(interaction, runtime, 'สถานะกุญแจระบบใช้ได้เฉพาะเจ้าของร้าน');
  const keys = runtime.env;
  const backupKeyring = keys.BACKUP_ENCRYPTION_KEYS_JSON;
  const description = [
    `กุญแจเข้ารหัสข้อมูล: **รุ่น ${keys.DATA_ENCRYPTION_KEYS_JSON.current}** • เก็บรุ่นเดิม ${Object.keys(keys.DATA_ENCRYPTION_KEYS_JSON.keys).length} รุ่น`,
    `กุญแจตรวจซองซ้ำ: **รุ่น ${keys.VOUCHER_HMAC_KEYS_JSON.current}** • เก็บรุ่นเดิม ${Object.keys(keys.VOUCHER_HMAC_KEYS_JSON.keys).length} รุ่น`,
    backupKeyring
      ? `กุญแจสำรองข้อมูล: **รุ่น ${backupKeyring.current}** • เก็บรุ่นเดิม ${Object.keys(backupKeyring.keys).length} รุ่น`
      : 'กุญแจสำรองข้อมูล: **ไม่ได้ตั้งค่า** เพราะปิดระบบสำรองข้อมูลไว้',
    'หน้านี้แสดงเฉพาะสถานะและหมายเลขรุ่น ไม่สามารถเปิดดูค่ากุญแจจริงได้',
  ].join('\n');
  return adminReply(interaction, 'secrets', { embeds: [panelEmbed(0x5865f2, 'สถานะกุญแจระบบ', description)] });
}

async function renderDlqPanel(interaction, runtime) {
  const dlq = (await runtime.pool.query(`SELECT * FROM dead_letter_items
    WHERE state IN ('DEAD_LETTER','PENDING') ORDER BY created_at DESC LIMIT 10`)).rows;
  const activeIncidents = (await runtime.pool.query(`SELECT * FROM incidents WHERE state<>'RESOLVED'
    ORDER BY severity DESC,opened_at DESC LIMIT 10`)).rows;
  return adminReply(interaction, 'dlq', { embeds: [panelEmbed(0xf23f43, 'งานค้างและเหตุขัดข้อง', dlqSummary(dlq, activeIncidents))],
  components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId('dlq_replay')).setLabel('ลองส่งงานค้างใหม่').setStyle(ButtonStyle.Primary).setDisabled(!dlq.length),
    new ButtonBuilder().setCustomId(customId('dlq_discard')).setLabel('ปิดงานค้างที่ไม่เกี่ยวกับเงิน').setStyle(ButtonStyle.Danger)
      .setDisabled(interaction.user.id !== runtime.env.OWNER_ID || !dlq.length),
  )] });
}

async function renderOverviewPanel(interaction, runtime) {
  const [wallets, queue, reviews, incidents, backup] = await Promise.all([
    runtime.pool.query('SELECT count(*)::integer AS users,COALESCE(sum(available_cents),0)::bigint AS available,COALESCE(sum(reserved_cents),0)::bigint AS reserved FROM wallets'),
    runtime.pool.query("SELECT count(*)::integer AS count FROM runner_jobs WHERE state NOT IN ('COMPLETED','FAILED')"),
    runtime.pool.query("SELECT count(*)::integer AS count FROM manual_reviews WHERE state<>'RESOLVED'"),
    runtime.pool.query("SELECT count(*)::integer AS count FROM incidents WHERE state<>'RESOLVED'"),
    runtime.pool.query("SELECT completed_at FROM backup_runs WHERE state='VERIFIED' ORDER BY completed_at DESC LIMIT 1"),
  ]);
  const row = wallets.rows[0];
  const metrics = overviewRuntimeMetrics(interaction, runtime);
  const description = overviewDescription({ backup, incidents, metrics, queue, reviews, row });
  return adminReply(interaction, 'overview', { embeds: [panelEmbed(0x5865f2, 'ภาพรวมร้าน', description)] });
}

const ADMIN_PANEL_RENDERERS = Object.freeze({
  gates: renderGatePanel, wallet: renderWalletPanel, blocklist: renderBlocklistPanel, payments: renderPaymentsPanel,
  surfaces: renderSurfacesPanel, pricing: renderPricingPanel, promotions: renderPromotionsPanel, receivers: renderReceiversPanel,
  monitors: renderMonitorsPanel, catalog: renderCatalogPanel, orders: renderOrdersPanel, backup: renderBackupPanel,
  branding: renderBrandingPanel, secrets: renderSecretsPanel, dlq: renderDlqPanel,
});

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
  const prefixes = ['admin', 'gate_', 'wallet_', 'refund_', 'block_', 'review_',
    'price_', 'promo_', 'receiver_', 'monitor_', 'catalog_', 'adminorder_', 'dlq_', 'config_', 'breaker_', 'test_fail_'];
  return prefixes.some((prefix) => route === prefix || route.startsWith(prefix));
}

async function assertTestFailureAlertBinding(interaction, alertId, runtime) {
  const alert = await withTransaction({ pool: runtime.pool, isolation: 'READ COMMITTED', maxAttempts: 1 },
    (client) => loadTestFailureAlert(client, alertId, { messageId: interaction.message?.id }));
  if (alert?.surface_key !== 'LOG_QUEST_OPERATIONS') {
    throw new QuestshopError('TEST_ALERT_BINDING_INVALID', 'ปุ่มนี้ไม่ใช่ข้อความแจ้งเตือน Quest ที่ใช้งานอยู่');
  }
  const surface = (await runtime.pool.query(`SELECT * FROM surfaces
    WHERE surface_key='LOG_QUEST_OPERATIONS' AND state='ACTIVE'`)).rows[0];
  if (!surface || surface.guild_id !== interaction.guildId || surface.channel_id !== interaction.channelId) {
    throw new QuestshopError('TEST_ALERT_SURFACE_INVALID', 'ห้อง Log นี้ไม่ใช่ Surface ที่ใช้งานอยู่');
  }
  return alert;
}

async function handleTestFailureSend({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'test_fail_send' || !interaction.isButton()) return;
  await interaction.deferReply({ ephemeral: true });
  await assertTestFailureAlertBinding(interaction, route.sessionId, runtime);
  const result = await forcePublishFailedMonitorTest({ alertId: route.sessionId,
    reason: 'Admin selected ส่งเลย from Monitor test failure log' },
  contextFor(interaction, 'test_failure_force_publish'), { pool: runtime.pool });
  return interaction.editReply(result.idempotent
    ? 'Quest นี้ถูกสั่งส่งประกาศไปแล้ว'
    : `เปิดขายและส่งประกาศ Quest แล้ว (Admin override) • Support: \`${result.quest.trace_id?.slice(0, 8) ?? 'see-log'}\``);
}

async function handleTestFailureRetry({ interaction, route, runtime, gates: _gates }) {
  if (route.route !== 'test_fail_retry' || !interaction.isButton()) return;
  await interaction.deferReply({ ephemeral: true });
  await assertTestFailureAlertBinding(interaction, route.sessionId, runtime);
  const result = await withTransaction({ pool: runtime.pool, isolation: 'SERIALIZABLE' },
    (client) => retryFailedTestAlert(client, { alertId: route.sessionId,
      context: contextFor(interaction, 'test_failure_retry') }));
  return interaction.editReply(result.idempotent
    ? 'รายการนี้ไม่ได้อยู่ในสถานะที่เริ่มทดสอบใหม่ได้'
    : 'รับคำสั่งแล้ว ระบบจะทดสอบใหม่สูงสุด 3 ครั้งต่อ Monitor และหยุดทันทีเมื่อผ่าน');
}

export async function authorizeRoute(interaction, route, runtime) {
  await assertSurfaceBinding(interaction, route, runtime);
  const backofficeRoute = isBackofficeRoute(route.route);
  // Pre-launch intentionally uses the production guild, database and real
  // financial adapters.  It must therefore be an Owner/Admin-only test round:
  // opening a gate for UAT must not accidentally make the store public.
  if (runtime.env.PRELAUNCH && !backofficeRoute && !isBackoffice(interaction, runtime)) {
    throw new QuestshopError('PRELAUNCH_RESTRICTED', 'ช่วงทดสอบ Pre-launch ใช้ได้เฉพาะ Owner/Admin');
  }
  if (interaction.isButton() && ['start', 'topup'].includes(route.route)) {
    await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'BUTTON' },
      contextFor(interaction, 'button_rate'), { pool: runtime.pool });
  }
  const gates = Object.fromEntries((await runtime.pool.query('SELECT gate, enabled FROM feature_gates')).rows.map((row) => [row.gate, row.enabled]));
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
    async (client) => (await minimumSellablePrice(client)) ?? minimumConfiguredPrice(client));
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
  const wallet = (await runtime.pool.query('SELECT available_cents FROM wallets WHERE discord_user_id=$1',
    [interaction.user.id])).rows[0];
  await interaction.reply({ ephemeral: true, ...renderPaymentMethod(wallet?.available_cents ?? 0, entry.id) });
  const reply = await interaction.fetchReply();
  await bindSessionMessage({ sessionId: entry.id, actorId: interaction.user.id,
    guildId: interaction.guildId, messageId: reply.id, expectedVersion: entry.state_version },
  contextFor(interaction, 'topup_entry_message'), { pool: runtime.pool });
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
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
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
        contextFor(interaction, 'voucher_invalid'), { pool: runtime.pool });
    }
    throw error;
  }
  await completeInteractionSession(session, interaction, runtime);
  await interaction.editReply(renderTopupProcessing(result.topup.id));
  const topup = await waitForCustomerTopup({ topupId: result.topup.id,
    discordUserId: interaction.user.id, signal: runtime.abortController?.signal }, { pool: runtime.pool });
  return interaction.editReply(renderTopupResult(topup));
}
}

async function handleTokenSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'token_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const entry = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'TOKEN_ENTRY' }, contextFor(interaction, 'token_entry_load'), { pool: runtime.pool });
  await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'TOKEN_VALIDATE' },
    contextFor(interaction, 'token_rate'), { pool: runtime.pool });
  const created = await createSession({ discordUserId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    token: interaction.fields.getTextInputValue('token'), env: runtime.env,
    runnerConcurrency: runnerConcurrency(runtime) }, contextFor(interaction, 'checkout'), { pool: runtime.pool });
  await completeInteractionSession(entry, interaction, runtime);
  const page = await getSelectionPage({ sessionId: created.session.id, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  const reply = await interaction.editReply(renderSelection(page));
  await bindSessionMessage({ sessionId: created.session.id, actorId: interaction.user.id,
    guildId: interaction.guildId, messageId: reply.id, expectedVersion: created.session.state_version },
  contextFor(interaction, 'checkout_message'), { pool: runtime.pool });
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
  return interaction.editReply(renderQuote(quote));
}
}

async function handleQuestBack({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_back') {
  await interaction.deferUpdate();
  const page = await getSelectionPage({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null }, contextFor(interaction, 'checkout_page'), { pool: runtime.pool });
  return interaction.editReply(renderSelection(page));
}
}

async function handleQuestConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'quest_confirm') {
  await interaction.deferUpdate();
  await consumeRateLimit({ discordUserId: interaction.user.id, operation: 'ORDER_CONFIRM' },
    contextFor(interaction, 'confirm_rate'), { pool: runtime.pool });
  const order = await confirmOrder({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    messageId: interaction.message?.id ?? null,
    env: runtime.env, runnerConcurrency: runnerConcurrency(runtime) }, contextFor(interaction, 'confirm'), { pool: runtime.pool });
  const history = (await runtime.pool.query("SELECT * FROM surfaces WHERE surface_key='QUEST_HISTORY' AND state='ACTIVE'")).rows[0];
  const historyLink = history ? `https://discord.com/channels/${interaction.guildId}/${history.channel_id}` : null;
  return interaction.editReply(renderOrderConfirmation(order, historyLink));
}
}

async function handleAdminPanel({ interaction, route, runtime, gates: _gates }) {
  const refresh = route.route.startsWith('admin_refresh_');
  if (!['admin', 'admin_nav'].includes(route.route) && !refresh) return;
  if (!isBackoffice(interaction, runtime)) throw new QuestshopError('ADMIN_ONLY', 'เมนูนี้ใช้ได้เฉพาะ Owner/Admin');
  if (route.route === 'admin') await interaction.deferReply({ ephemeral: true });
  else await interaction.deferUpdate();
  const selected = refresh ? route.route.slice('admin_refresh_'.length) : interaction.values?.[0] ?? 'overview';
  const renderer = selected === 'overview' ? renderOverviewPanel : ADMIN_PANEL_RENDERERS[selected];
  if (!renderer) throw new QuestshopError('ADMIN_CATEGORY_INVALID', 'ไม่พบหมวดการตั้งค่านี้');
  return renderer(interaction, runtime);
}

async function handleWalletAdjust({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'wallet_adjust' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_WALLET_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'wallet_prepare'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('wallet_adjust_submit', session.id, 'ปรับเครดิตลูกค้า', [
    { id: 'user_id', label: 'Discord User ID ของลูกค้า', max: 20 },
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
  return interaction.editReply({ content: `ยืนยันปรับเครดิตของ \`${discordUserId}\`\nเครดิตพร้อมใช้: **${money(before.available_cents)} → ${money(after)}**\nเครดิตที่กำลังจอง: **${money(before.reserved_cents)}**\nเหตุผล: ${reason}`,
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
    throw new QuestshopError('STALE_STATE', 'ยอดเครดิตเปลี่ยนหลังเปิดหน้าตรวจสอบ กรุณาเริ่มใหม่');
  }
  const wallet = await adjustWalletAsAdmin({ discordUserId: session.payload.discordUserId,
    amountCents: BigInt(session.payload.amountCents), reason: session.payload.reason,
    expectedVersion: session.payload.expectedVersion },
  contextFor(interaction, 'wallet_adjust_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply({ content: `ปรับยอดสำเร็จ เครดิตพร้อมใช้ปัจจุบัน **${money(wallet.available_cents)}**`, components: [] });
}
}

async function handleRefundPrepare({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'refund_prepare' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_REFUND_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'refund_prepare'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('refund_prepare_submit', session.id, 'คืนเครดิตงาน Quest', [
    { id: 'item_id', label: 'ID งาน Quest', max: 36 },
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
  if (!row) throw new QuestshopError('RESERVATION_NOT_FOUND', 'ไม่พบงาน Quest หรือยอดที่เกี่ยวข้อง');
  if (row.refunded) throw new QuestshopError('ALREADY_REFUNDED', 'งานนี้คืนเครดิตแล้ว');
  if (row.state !== 'CAPTURED') throw new QuestshopError('REFUND_NOT_CAPTURED', 'คืนได้เฉพาะงานที่คิดค่าบริการแล้ว');
  const after = BigInt(row.available_cents) + BigInt(row.amount_cents);
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'ADMIN_REFUND_CONFIRM', payload: { orderItemId, reason,
      expectedReservationVersion: String(row.state_version) }, configVersion: runtime.config.version },
  contextFor(interaction, 'refund_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยันคืนเครดิต **${row.quest_name}**\nออเดอร์: \`${row.order_id}\`\nงาน: \`${orderItemId}\`\nจำนวน: **${money(row.amount_cents)}**\nเครดิตพร้อมใช้: **${money(row.available_cents)} → ${money(after)}**\nเหตุผล: ${reason}`,
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
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply({ content: `คืนเครดิตสำเร็จ **${money(refund.amount_cents)}**\nรหัสการคืน: \`${refund.id}\`\nเครดิตพร้อมใช้ปัจจุบัน: **${money(refund.available_cents)}**`, components: [] });
}
}

async function handleBlockAction({ interaction, route, runtime, gates: _gates }) {
if (['block_add', 'block_remove'].includes(route.route) && interaction.isButton()) {
  const operation = route.route === 'block_add' ? 'ADMIN_BLOCK' : 'ADMIN_UNBLOCK';
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation,
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'block_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal(route.route === 'block_add' ? 'block_add_submit' : 'block_remove_submit',
    session.id, route.route === 'block_add' ? 'ระงับผู้ใช้' : 'ยกเลิกการระงับ', [
      { id: 'user_id', label: 'Discord User ID', max: 20 },
      { id: 'block_type', label: 'ประเภท', placeholder: 'เติมเงิน หรือ Quest', max: 20 },
      ...(route.route === 'block_add' ? [{ id: 'hours', label: 'หมดอายุในกี่ชั่วโมง (เว้นว่าง=ถาวร)', required: false, max: 8 }] : []),
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]));
}
}

function blockInput(interaction) {
  const rawBlockType = interaction.fields.getTextInputValue('block_type').trim();
  const blockType = { 'เติมเงิน': 'TOPUP_BLOCKED', 'QUEST': 'ORDER_BLOCKED', 'เควส': 'ORDER_BLOCKED' }[rawBlockType.toUpperCase()]
    ?? rawBlockType.toUpperCase();
  const input = {
    discordUserId: interaction.fields.getTextInputValue('user_id').trim(),
    blockType,
    reason: interaction.fields.getTextInputValue('reason').trim(),
  };
  if (!/^\d{17,20}$/.test(input.discordUserId)) throw new TypeError('Discord User ID ไม่ถูกต้อง');
  return input;
}

function blockExpiryHours(interaction) {
  const hoursText = interaction.fields.getTextInputValue('hours').trim();
  const hours = hoursText ? Number(hoursText) : null;
  if (hours != null && (!Number.isInteger(hours) || hours <= 0 || hours > 8760)) {
    throw new TypeError('จำนวนชั่วโมงไม่ถูกต้อง');
  }
  return hours;
}

async function executeBlockChange({ adding, input, interaction, runtime }) {
  if (adding) {
    await blockUser({ ...input, expiresInHours: blockExpiryHours(interaction) },
      contextFor(interaction, 'block_add_execute'), { pool: runtime.pool });
    return;
  }
  await unblockUser(input, contextFor(interaction, 'block_remove_execute'), { pool: runtime.pool });
}

async function handleBlockSubmit({ interaction, route, runtime, gates: _gates }) {
if (['block_add_submit', 'block_remove_submit'].includes(route.route) && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const adding = route.route === 'block_add_submit';
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId,
    operation: adding ? 'ADMIN_BLOCK' : 'ADMIN_UNBLOCK' }, contextFor(interaction, 'block_load'), { pool: runtime.pool });
  const input = blockInput(interaction);
  await executeBlockChange({ adding, input, interaction, runtime });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`${adding ? 'ระงับ' : 'ยกเลิกการระงับ'} \`${input.discordUserId}\` สำหรับ **${BLOCK_LABELS[input.blockType] ?? 'การใช้งานที่เลือก'}** เรียบร้อย`);
}
}

async function handleReviewResolve({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_resolve' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_REVIEW_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'review_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('review_resolve_submit', session.id, 'สรุปรายการที่รอตรวจสอบ', [
    { id: 'review_id', label: 'ID รายการตรวจสอบ', max: 36 },
    { id: 'decision', label: 'คำตัดสิน', placeholder: 'เพิ่มเครดิต/ปฏิเสธ/ลองใหม่/คิดเงิน/คืน/หยุด/ล้มเหลว', max: 20 },
    { id: 'amount', label: 'ยอดบาท (เฉพาะเพิ่มเครดิต)', required: false, max: 24 },
    { id: 'provider_id', label: 'เลขธุรกรรมผู้ให้บริการ (ถ้ามี)', required: false, max: 200 },
    { id: 'reason', label: 'เหตุผลและหลักฐาน', long: true, max: 500 },
  ]));
}
}

async function handleReviewAssign({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_assign' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_REVIEW_ASSIGN',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'review_assign_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('review_assign_submit', session.id, 'รับผิดชอบรายการตรวจสอบ', [
    { id: 'review_id', label: 'ID รายการตรวจสอบ', max: 36 },
  ]));
}
}

async function handleReviewAssignSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_assign_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REVIEW_ASSIGN' },
  contextFor(interaction, 'review_assign_load'), { pool: runtime.pool });
  const reviewId = interaction.fields.getTextInputValue('review_id').trim();
  const review = (await runtime.pool.query(`SELECT * FROM manual_reviews WHERE id=$1 AND state='OPEN'`, [reviewId])).rows[0];
  if (!review) throw new QuestshopError('REVIEW_NOT_OPEN', 'รายการนี้ไม่ได้เปิดรอการตรวจสอบอยู่');
  const assigned = await assignReview({ reviewId, assigneeId: interaction.user.id,
    expectedVersion: review.state_version }, contextFor(interaction, 'review_assign_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`รับผิดชอบรายการตรวจสอบ \`${assigned.id}\` แล้ว`);
}
}

async function handleReviewEvidence({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_evidence' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_REVIEW_EVIDENCE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'review_evidence_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('review_evidence_submit', session.id, 'เพิ่มหลักฐานการตรวจสอบ', [
    { id: 'review_id', label: 'ID รายการตรวจสอบ', max: 36 },
    { id: 'type', label: 'ประเภทหลักฐาน', placeholder: 'PROVIDER_CHECK / RUNNER_LOG / ADMIN_NOTE', max: 64 },
    { id: 'note', label: 'รายละเอียดหลักฐาน', long: true, max: 1000 },
  ]));
}
}

async function handleReviewEvidenceSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'review_evidence_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_REVIEW_EVIDENCE' },
  contextFor(interaction, 'review_evidence_load'), { pool: runtime.pool });
  const reviewId = interaction.fields.getTextInputValue('review_id').trim();
  const evidenceType = interaction.fields.getTextInputValue('type').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(evidenceType)) throw new TypeError('ประเภทหลักฐานไม่ถูกต้อง');
  const review = await addEvidence({ reviewId, evidenceType,
    payload: { note: interaction.fields.getTextInputValue('note').trim() } },
  contextFor(interaction, 'review_evidence_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เพิ่มหลักฐานให้รายการ \`${review.id}\` แล้ว • ${displayState(review.state)}`);
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
  if (!review) throw new QuestshopError('REVIEW_NOT_FOUND', 'ไม่พบรายการที่ยังเปิดรอตรวจสอบ');
  if (review.owner_only && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'รายการนี้ให้เจ้าของร้านตัดสินเท่านั้น');
  const decision = normalizedChoice(interaction.fields.getTextInputValue('decision'), {
    'เพิ่มเครดิต': 'CREDIT', 'ปฏิเสธ': 'REJECT', 'ลองใหม่': 'RETRY', 'คิดเงิน': 'CAPTURE',
    'คิดค่าบริการ': 'CAPTURE', 'คืน': 'RELEASE', 'คืนเครดิต': 'RELEASE', 'หยุด': 'STOP', 'หยุดงาน': 'STOP',
    'ล้มเหลว': 'FAIL',
  });
  const amountText = interaction.fields.getTextInputValue('amount').trim();
  const payload = { reviewId, expectedVersion: String(review.state_version), decision,
    amountCents: amountText ? String(parseBahtToCents(amountText)) : null,
    providerTransactionId: interaction.fields.getTextInputValue('provider_id').trim() || null,
    reason: interaction.fields.getTextInputValue('reason').trim() };
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'ADMIN_REVIEW_CONFIRM', payload, configVersion: runtime.config.version },
  contextFor(interaction, 'review_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยันสรุปรายการ \`${review.id}\`\nประเภท: **${SUBJECT_LABELS[review.subject_type] ?? 'รายการตรวจสอบ'}** / \`${review.subject_id}\`\nคำตัดสิน: **${REVIEW_DECISION_LABELS[decision] ?? 'ตรวจสอบเพิ่มเติม'}**\nเกี่ยวข้องกับเงิน: **${review.financial ? 'ใช่' : 'ไม่'}**\nเหตุผล: ${payload.reason}`,
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
    throw new QuestshopError('STALE_STATE', 'รายการเปลี่ยนหลังเปิดหน้าตรวจสอบ กรุณาเริ่มใหม่');
  }
  const result = await resolveSubjectReview({ reviewId: session.payload.reviewId,
    decision: session.payload.decision, reason: session.payload.reason,
    expectedVersion: session.payload.expectedVersion,
    isOwner: interaction.user.id === runtime.env.OWNER_ID,
    amountCents: session.payload.amountCents == null ? null : BigInt(session.payload.amountCents),
    providerTransactionId: session.payload.providerTransactionId },
  contextFor(interaction, 'review_resolve_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply({ content: `สรุปรายการสำเร็จ: **${displayState(result.review.state)}**`, components: [] });
}
}

async function handleCatalogSale({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'catalog_sale' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'QUEST_SALE_CHANGE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'catalog_sale_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('catalog_sale_submit', session.id, 'สถานะขาย Quest', [
    { id: 'quest_id', label: 'Quest ID', max: 100 },
    { id: 'state', label: 'สถานะใหม่', placeholder: 'เปิด / พัก / หมดอายุ', max: 10 },
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
    nextState: normalizedChoice(interaction.fields.getTextInputValue('state'), {
      'เปิด': 'OPEN', 'พัก': 'PAUSED', 'หมดอายุ': 'EXPIRED',
    }),
    runnerConcurrency: runnerConcurrency(runtime),
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'catalog_sale_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`Quest \`${quest.quest_id}\` เปลี่ยนเป็น **${saleStateLabel(quest.sale_state)}** แล้ว`);
}
}

async function handleOrderReview({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'adminorder_review' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ORDER_REVIEW_OPEN',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'order_review_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('adminorder_review_submit', session.id, 'เปิดรายการตรวจสอบงาน Quest', [
    { id: 'item_id', label: 'ID งาน Quest', max: 36 },
    { id: 'owner_only', label: 'ให้เจ้าของร้านตัดสินเท่านั้น?', placeholder: 'ใช่ หรือ ไม่', max: 4 },
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
  const ownerOnlyText = interaction.fields.getTextInputValue('owner_only').trim().toLowerCase();
  const ownerOnly = ['yes', 'ใช่'].includes(ownerOnlyText);
  const review = await openOrderItemReview({ orderItemId: interaction.fields.getTextInputValue('item_id').trim(),
    reason: interaction.fields.getTextInputValue('reason').trim(), ownerOnly },
  contextFor(interaction, 'order_review_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เปิดรายการตรวจสอบ \`${review.id}\` แล้ว${review.owner_only ? ' • เจ้าของร้านเป็นผู้ตัดสิน' : ''}`);
}
}

async function handlePriceCreate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_create' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PRICE_CREATE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'price_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('price_create_submit', session.id, 'สร้างกฎราคา', [
    { id: 'scope', label: 'ใช้ราคากับ', placeholder: 'เริ่มต้น / ประเภท / Quest / ชั่วคราว', max: 16 },
    { id: 'target', label: 'Quest หรือประเภทเป้าหมาย', placeholder: 'เช่น WATCH_VIDEO หรือ Quest ID (เว้นว่างได้)', required: false, max: 100 },
    { id: 'amount', label: 'ราคา (บาท)', placeholder: '5.00', max: 24 },
    { id: 'period', label: 'เริ่ม | จบ (ISO 8601, เว้นว่างได้)', placeholder: '2026-08-01T00:00:00+07:00 | 2026-08-31T23:59:59+07:00', required: false, max: 120 },
    { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
  ]));
}
}

function priceTarget(ruleType, rawTarget) {
  const target = rawTarget.trim();
  if (ruleType === 'QUEST') return { questId: target || null, taskType: null };
  if (ruleType === 'TYPE') return { questId: null, taskType: target.toUpperCase() || null };
  if (ruleType !== 'TEMPORARY') return { questId: null, taskType: null };
  if (target.startsWith('quest:')) return { questId: target.slice(6) || null, taskType: null };
  if (target.startsWith('type:')) return { questId: null, taskType: target.slice(5).toUpperCase() || null };
  return { questId: null, taskType: null };
}

function pricePeriod(rawPeriod) {
  const [startText, endText] = rawPeriod.trim() ? rawPeriod.split('|').map((value) => value.trim()) : [];
  const startsAt = startText ? new Date(startText) : null;
  const endsAt = endText ? new Date(endText) : null;
  const invalidStart = startText && !Number.isFinite(startsAt.getTime());
  const invalidEnd = endText && !Number.isFinite(endsAt.getTime());
  if (invalidStart || invalidEnd || (startsAt && endsAt && endsAt <= startsAt)) {
    throw new TypeError('ช่วงเวลาของกฎราคาไม่ถูกต้อง');
  }
  return { startsAt, endsAt };
}

function priceRuleInput(interaction) {
  const ruleType = normalizedChoice(interaction.fields.getTextInputValue('scope'), {
    'เริ่มต้น': 'DEFAULT', 'ประเภท': 'TYPE', 'ชั่วคราว': 'TEMPORARY',
  });
  return {
    ruleType,
    ...priceTarget(ruleType, interaction.fields.getTextInputValue('target')),
    ...pricePeriod(interaction.fields.getTextInputValue('period')),
    amountCents: parseBahtToCents(interaction.fields.getTextInputValue('amount')),
    reason: interaction.fields.getTextInputValue('reason').trim(),
  };
}

async function handlePriceCreateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_create_submit' && interaction.isModalSubmit()) {
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'PRICE_CREATE' },
  contextFor(interaction, 'price_load'), { pool: runtime.pool });
  const rule = await setPriceRule(priceRuleInput(interaction),
  contextFor(interaction, 'price_create_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`สร้าง **${PRICE_RULE_LABELS[rule.rule_type] ?? 'กฎราคา'}** ราคา **${money(rule.amount_cents)}** แล้ว`);
}
}

async function handlePriceManage({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'price_manage' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PRICE_MANAGE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'price_manage_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('price_manage_submit', session.id, 'เปิดหรือปิดกฎราคา', [
    { id: 'rule_id', label: 'ID กฎราคา', max: 36 },
    { id: 'action', label: 'ต้องการทำอะไร', placeholder: 'เปิด หรือ ปิด', max: 7 },
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
  const action = normalizedChoice(interaction.fields.getTextInputValue('action'), { 'เปิด': 'ENABLE', 'ปิด': 'DISABLE' });
  if (!['ENABLE', 'DISABLE'].includes(action)) throw new TypeError('กรุณากรอก “เปิด” หรือ “ปิด”');
  const priceRuleId = interaction.fields.getTextInputValue('rule_id').trim();
  const current = (await runtime.pool.query('SELECT state_version FROM price_rules WHERE id=$1', [priceRuleId])).rows[0];
  if (!current) throw new QuestshopError('PRICE_RULE_NOT_FOUND', 'ไม่พบกฎราคานี้');
  const rule = await setPriceRuleEnabled({ priceRuleId: interaction.fields.getTextInputValue('rule_id').trim(),
    enabled: action === 'ENABLE', expectedVersion: current.state_version,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'price_manage_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`กฎราคา \`${rule.id}\` **${rule.enabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}** แล้ว`);
}
}

async function handlePromotionCreate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_create' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PROMOTION_CREATE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'promo_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('promo_create_submit', session.id, 'สร้างโปรโมชั่น', [
    { id: 'name', label: 'ชื่อโปรโมชั่น', max: 100 },
    { id: 'period', label: 'เริ่ม | จบ (ISO 8601)', placeholder: '2026-08-01T00:00:00+07:00 | 2026-09-01T00:00:00+07:00', max: 120 },
    { id: 'tiers', label: 'ยอดเติม=โบนัสเปอร์เซ็นต์', placeholder: '100=10, 300=15, 600=20', max: 300 },
    { id: 'limits', label: 'ครั้งต่อลูกค้า | โบนัสสูงสุดต่อวัน', placeholder: '1 | 500.00 (เว้นว่างได้)', required: false, max: 80 },
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
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) throw new TypeError('ช่วงเวลาโปรโมชั่นไม่ถูกต้อง');
  const tiers = interaction.fields.getTextInputValue('tiers').split(',').map((entry) => {
    const [amount, percent] = entry.split('=').map((value) => value.trim());
    const basisPoints = parsePromotionBasisPoints(percent);
    return { minimumAmountCents: parseBahtToCents(amount), basisPoints };
  });
  const limitsText = interaction.fields.getTextInputValue('limits').trim();
  const [usesText, bonusText] = limitsText ? limitsText.split('|').map((value) => value.trim()) : [];
  const maxUsesPerUser = usesText ? Number(usesText) : null;
  if (maxUsesPerUser != null && (!Number.isInteger(maxUsesPerUser) || maxUsesPerUser <= 0)) throw new TypeError('จำนวนครั้งต่อผู้ใช้ไม่ถูกต้อง');
  const promotion = await createPromotion({ name: interaction.fields.getTextInputValue('name'),
    startsAt, endsAt, tiers, maxUsesPerUser,
    maxBonusPerDayCents: bonusText ? parseBahtToCents(bonusText) : null,
    activate: true, reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'promo_create_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`สร้างและเปิดโปรโมชั่น **${promotion.name}** รุ่น ${promotion.version} แล้ว`);
}
}

async function handlePromotionManage({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'promo_manage' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'PROMOTION_MANAGE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'promo_manage_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('promo_manage_submit', session.id, 'เปลี่ยนสถานะโปรโมชั่น', [
    { id: 'promotion_id', label: 'ID โปรโมชั่น', max: 36 },
    { id: 'state', label: 'สถานะ', placeholder: 'แบบร่าง / เปิด / ปิด', max: 8 },
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
  if (!current) throw new QuestshopError('PROMOTION_NOT_FOUND', 'ไม่พบโปรโมชั่น');
  const promotion = await setPromotionState({ promotionId,
    state: normalizedChoice(interaction.fields.getTextInputValue('state'), {
      'แบบร่าง': 'DRAFT', 'เปิด': 'ACTIVE', 'ปิด': 'DISABLED',
    }),
    expectedVersion: current.state_version,
    reason: interaction.fields.getTextInputValue('reason').trim() }, contextFor(interaction, 'promo_manage_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`โปรโมชั่น **${promotion.name}** เป็น **${displayState(promotion.state)}** แล้ว`);
}
}

async function handleReceiverActivate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'RECEIVER_PREPARE',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'receiver_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('receiver_activate_submit', session.id, 'เพิ่มเบอร์รับเงินใหม่', [
    { id: 'phone', label: 'เบอร์ TrueMoney 10 หลัก', max: 10 },
    { id: 'reason', label: 'เหตุผลการเปลี่ยนเบอร์', long: true, max: 500 },
  ]));
}
}

async function handleReceiverActivateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'RECEIVER_PREPARE' },
  contextFor(interaction, 'receiver_load'), { pool: runtime.pool });
  const phone = interaction.fields.getTextInputValue('phone').trim();
  if (!/^0\d{9}$/.test(phone)) throw new TypeError('เบอร์รับเงินไม่ถูกต้อง');
  const payload = { phone, reason: interaction.fields.getTextInputValue('reason').trim() };
  const confirm = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'RECEIVER_CONFIRM', payload, configVersion: runtime.config.version },
  contextFor(interaction, 'receiver_confirm_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `ยืนยันเปิดเบอร์รับเงินใหม่ ***-***-${phone.slice(-4)}**\nรายการใหม่จะใช้เบอร์นี้ทันที ส่วนรายการเดิมจะใช้เบอร์เดิมที่บันทึกไว้\nเหตุผล: ${payload.reason}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(customId('receiver_activate_confirm', confirm.id)).setLabel('ยืนยันเบอร์รับเงินใหม่')
      .setStyle(ButtonStyle.Danger))] });
}
}

async function handleReceiverActivateConfirm({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'receiver_activate_confirm' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เบอร์รับเงินใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'RECEIVER_CONFIRM' },
  contextFor(interaction, 'receiver_confirm_load'), { pool: runtime.pool });
  const receiver = await activateReceiver({ phone: session.payload.phone, env: runtime.env,
    reason: session.payload.reason }, contextFor(interaction, 'receiver_activate_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เปิดเบอร์รับเงินรุ่น ${receiver.version} (***-***-${receiver.phone_last4}) แล้ว`);
}
}

async function handleMonitorAdd({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_add' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'MONITOR_ADD',
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'monitor_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('monitor_add_submit', session.id, 'เพิ่มบัญชีตรวจสอบ Quest', [
    { id: 'token', label: 'Discord Token', long: true, max: 300 },
  ]));
}
}

async function handleMonitorAddSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_add_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'MONITOR_ADD' },
  contextFor(interaction, 'monitor_load'), { pool: runtime.pool });
  const monitor = await addMonitor({ token: interaction.fields.getTextInputValue('token'), env: runtime.env },
  contextFor(interaction, 'monitor_add_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เพิ่มบัญชีตรวจสอบ **${escapedText(monitor.username)}** (\`${escapedText(monitor.account_id)}\`) แล้ว\nบัญชีนี้จะตรวจหาและทดสอบ Quest อัตโนมัติ โดย Token ถูกเข้ารหัสและไม่สามารถเปิดดูจากหน้าแอดมินได้`);
}
}

async function handleMonitorCheckAll({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_check_all' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const results = await checkAllMonitorHealth({ env: runtime.env },
    contextFor(interaction, 'monitor_check_all_execute'), { pool: runtime.pool });
  const ready = results.filter((result) => result.healthState === 'READY').length;
  const paused = results.filter((result) => result.monitor.state === 'DISABLED').length;
  return interaction.editReply({ embeds: [panelEmbed(0x5865f2, 'ผลตรวจระบบ Token', [
    `ตรวจ **${results.length}** Token • Token ปกติ **${ready}** • มีปัญหา/ใช้ไม่ได้ **${results.length - ready}** • พักใช้งาน **${paused}**`, '',
    listRows(results, monitorHealthLine, 'ยังไม่มี Token Monitor'),
    '', 'การตรวจนี้เช็คการถอดรหัส Token, ล็อกอิน และอ่านรายการ Quest เท่านั้น — ไม่ทำ Quest จริง',
  ].join('\n'))] });
}
}

async function handleMonitorList({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_list' && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferUpdate();
  return renderMonitorList(interaction, runtime);
}
}

async function handleMonitorSelect({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_select' && interaction.isStringSelectMenu()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_SELECT' }, contextFor(interaction, 'monitor_select_load'), { pool: runtime.pool });
  const monitorId = interaction.values[0];
  if (!session.payload.monitorIds?.includes(monitorId)) throw new QuestshopError('MONITOR_SELECTION_INVALID', 'รายการบัญชีตรวจสอบหมดอายุแล้ว');
  await interaction.deferUpdate();
  return renderMonitorDetail(interaction, runtime, monitorId);
}
}

async function handleMonitorCheckOne({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_check_one' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_CHECK_ONE' }, contextFor(interaction, 'monitor_check_one_load'), { pool: runtime.pool });
  const result = await checkMonitorHealth({ monitorId: session.payload.monitorId, env: runtime.env },
    contextFor(interaction, 'monitor_check_one_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`${monitorHealthLine(result)}\nการตรวจนี้ไม่สั่งทำ Quest จริง`);
}
}

async function handleMonitorRotate({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_rotate' && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_ROTATE' }, contextFor(interaction, 'monitor_rotate_load_button'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('monitor_rotate_submit', session.id, 'เปลี่ยน Token บัญชีตรวจสอบ', [
    { id: 'token', label: 'Discord Token ใหม่', long: true, max: 300 },
  ]));
}
}

async function handleMonitorRotateSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_rotate_submit' && interaction.isModalSubmit()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'MONITOR_ROTATE' },
  contextFor(interaction, 'monitor_rotate_load'), { pool: runtime.pool });
  const monitor = await rotateMonitorCredential({ monitorId: session.payload.monitorId,
    token: interaction.fields.getTextInputValue('token'), env: runtime.env },
  contextFor(interaction, 'monitor_rotate_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`เปลี่ยน Token ของ **${escapedText(monitor.username ?? monitor.account_id)}** เรียบร้อยแล้ว และเปิดใช้งานบัญชีนี้อีกครั้ง`);
}
}

async function handleMonitorToggle({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'monitor_toggle' && interaction.isButton()) {
  ownerOnly(interaction, runtime, 'บัญชีตรวจสอบ Quest ใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message?.id ?? null,
    operation: 'MONITOR_TOGGLE' }, contextFor(interaction, 'monitor_toggle_load'), { pool: runtime.pool });
  const monitor = (await runtime.pool.query('SELECT * FROM monitor_accounts WHERE id=$1', [session.payload.monitorId])).rows[0];
  if (!monitor) throw new QuestshopError('MONITOR_NOT_FOUND', 'ไม่พบบัญชี Monitor');
  const nextState = monitor.state === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
  const changed = await setMonitorState({ monitorId: monitor.id, state: nextState },
    contextFor(interaction, 'monitor_toggle_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`${nextState === 'ACTIVE' ? 'เปิดใช้งาน' : 'พักใช้งาน'} **${changed.username ?? changed.account_id}** แล้ว`);
}
}

async function handleDlqAction({ interaction, route, runtime, gates: _gates }) {
if (['dlq_replay', 'dlq_discard'].includes(route.route) && interaction.isButton()) {
  if (route.route === 'dlq_discard' && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'การปิดงานค้างใช้ได้เฉพาะเจ้าของร้าน');
  const operation = route.route === 'dlq_replay' ? 'DLQ_REPLAY' : 'DLQ_DISCARD';
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation,
    payload: {}, configVersion: runtime.config.version }, contextFor(interaction, 'dlq_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal(route.route === 'dlq_replay' ? 'dlq_replay_submit' : 'dlq_discard_submit',
    session.id, operation, [
      { id: 'dlq_id', label: 'ID งานค้าง', max: 36 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]));
}
}

async function handleDlqSubmit({ interaction, route, runtime, gates: _gates }) {
if (['dlq_replay_submit', 'dlq_discard_submit'].includes(route.route) && interaction.isModalSubmit()) {
  const replay = route.route === 'dlq_replay_submit';
  if (!replay && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'การปิดงานค้างใช้ได้เฉพาะเจ้าของร้าน');
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
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`${replay ? 'ส่งงานค้างใหม่' : 'ปิดงานค้าง'} สำเร็จ: \`${replay ? result.replayOutboxId : result.id}\``);
}
}

async function handleConcurrency({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'config_concurrency' && interaction.isButton()) {
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'CONFIG_CONCURRENCY',
    payload: { expectedVersion: runtime.config.version }, configVersion: runtime.config.version },
  contextFor(interaction, 'config_concurrency_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('config_concurrency_submit', session.id, 'ตั้งจำนวนงานพร้อมกัน', [
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
    || concurrency > runtime.env.RUNNER_CONCURRENCY_HARD_MAX) throw new TypeError('จำนวนงานพร้อมกันไม่ถูกต้อง');
  const changed = await updateRuntimeConfig({ patch: { runnerConcurrency: concurrency },
    expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'config_concurrency_execute'), { pool: runtime.pool });
  runtime.config = await loadRuntimeConfig(runtime.pool);
  interaction.client.questshop.config = runtime.config;
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`ตั้งจำนวนงานพร้อมกันเป็น **${concurrency}** แล้ว • การตั้งค่ารุ่น ${changed.version}`);
}
}

async function handleConfig({ interaction, route, runtime, gates: _gates }) {
if (['config_branding', 'config_roles'].includes(route.route) && interaction.isButton()) {
  const roles = route.route === 'config_roles';
  if (roles && interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'การตั้งค่ายศใช้ได้เฉพาะเจ้าของร้าน');
  const operation = roles ? 'CONFIG_ROLES' : 'CONFIG_BRANDING';
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation,
    payload: { expectedVersion: runtime.config.version }, configVersion: runtime.config.version },
  contextFor(interaction, 'config_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal(roles ? 'config_roles_submit' : 'config_branding_submit',
    session.id, roles ? 'ตั้งค่ายศของระบบ' : 'ตั้งค่าหน้าร้าน', roles ? [
      { id: 'admin_role', label: 'ID ยศแอดมิน (เว้นว่างเพื่อปิด)', required: false, max: 20 },
      { id: 'quest_role', label: 'ID ยศแจ้ง Quest ใหม่', required: false, max: 20 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ] : [
      { id: 'title', label: 'ชื่อแผง Quest Auto', max: 256 },
      { id: 'description', label: 'คำอธิบาย', long: true, max: 2000 },
      { id: 'media_url', label: 'ลิงก์รูปหรือ GIF (เว้นว่างได้)', required: false, max: 500 },
      { id: 'reason', label: 'เหตุผล', long: true, max: 500 },
    ]));
}
}

function configOperation(roles) {
  return roles ? 'CONFIG_ROLES' : 'CONFIG_BRANDING';
}

function roleConfigPatch(interaction) {
  const adminRoleId = interaction.fields.getTextInputValue('admin_role').trim() || null;
  const questAnnouncementRoleId = interaction.fields.getTextInputValue('quest_role').trim() || null;
  if ([adminRoleId, questAnnouncementRoleId].some((id) => id && !/^\d{17,20}$/.test(id))) {
    throw new TypeError('ID ยศไม่ถูกต้อง');
  }
  return { adminRoleId, questAnnouncementRoleId };
}

function brandingConfigPatch(interaction) {
  const mediaUrl = interaction.fields.getTextInputValue('media_url').trim() || null;
  if (mediaUrl && !['https:', 'http:'].includes(new URL(mediaUrl).protocol)) {
    throw new TypeError('ลิงก์รูปหรือ GIF ต้องเป็น HTTP(S)');
  }
  return { branding: {
    title: interaction.fields.getTextInputValue('title').trim(),
    description: interaction.fields.getTextInputValue('description').trim(), mediaUrl,
  } };
}

function configPatch(interaction, roles) {
  return roles ? roleConfigPatch(interaction) : brandingConfigPatch(interaction);
}

async function handleConfigSubmit({ interaction, route, runtime, gates: _gates }) {
if (['config_roles_submit', 'config_branding_submit'].includes(route.route) && interaction.isModalSubmit()) {
  const roles = route.route === 'config_roles_submit';
  if (roles) ownerOnly(interaction, runtime, 'การตั้งค่ายศใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const operation = configOperation(roles);
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation },
  contextFor(interaction, 'config_load'), { pool: runtime.pool });
  const changed = await updateRuntimeConfig({ patch: configPatch(interaction, roles), expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'config_execute'), { pool: runtime.pool });
  runtime.config = await loadRuntimeConfig(runtime.pool);
  interaction.client.questshop.config = runtime.config;
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`บันทึกการตั้งค่ารุ่น **${changed.version}** แล้ว หน้าร้านจะเปลี่ยนเมื่อรีเฟรชหรือติดตั้งแผงข้อความอีกครั้ง`);
}
}

async function handleBreakerPrepare({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'breaker_prepare' && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'ระบบป้องกันการรับซองผิดปกติใช้ได้เฉพาะเจ้าของร้าน');
  const breaker = (await runtime.pool.query("SELECT * FROM circuit_breakers WHERE breaker_key='TRUEMONEY_DIRECT'")).rows[0];
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'BREAKER_CHANGE',
    payload: { breakerKey: breaker.breaker_key, expectedVersion: String(breaker.state_version),
      beforeState: breaker.state }, configVersion: runtime.config.version },
  contextFor(interaction, 'breaker_session'), { pool: runtime.pool });
  return interaction.showModal(fieldsModal('breaker_submit', session.id, 'ทดสอบระบบรับซองอีกครั้ง', [
    { id: 'state', label: 'การทำงาน', placeholder: 'ทดสอบ หรือ เปิดปกติ', max: 10 },
    { id: 'reason', label: 'หลักฐานและเหตุผล', long: true, max: 500 },
  ]));
}
}

async function handleBreakerSubmit({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'breaker_submit' && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'ระบบป้องกันการรับซองผิดปกติใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'BREAKER_CHANGE' },
  contextFor(interaction, 'breaker_load'), { pool: runtime.pool });
  const breaker = await setCircuitBreakerState({ breakerKey: session.payload.breakerKey,
    nextState: normalizedChoice(interaction.fields.getTextInputValue('state'), {
      'ทดสอบ': 'HALF_OPEN', 'เปิดปกติ': 'CLOSED', 'เปิด': 'CLOSED',
    }),
    expectedVersion: session.payload.expectedVersion,
    reason: interaction.fields.getTextInputValue('reason').trim() },
  contextFor(interaction, 'breaker_execute'), { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
  return interaction.editReply(`ระบบรับซองเป็น **${breakerStateLabel(breaker.state)}** แล้ว${breaker.state === 'HALF_OPEN' ? ' และจะทดสอบด้วยรายการถัดไปหนึ่งรายการ' : ''}`);
}
}

async function handleGatePick({ interaction, route, runtime, gates: _gates }) {
if (route.route === 'admin_gate_pick' && interaction.isStringSelectMenu()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เมนูเปิด–ปิดระบบใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const gate = (await runtime.pool.query('SELECT * FROM feature_gates WHERE gate=$1', [interaction.values[0]])).rows[0];
  const session = await createAdminSession({ actorId: interaction.user.id, guildId: interaction.guildId,
    channelId: interaction.channelId, messageId: interaction.message.id, operation: 'ADMIN_GATE',
    payload: { gate: gate.gate, expectedVersion: Number(gate.version) }, configVersion: runtime.config.version },
  contextFor(interaction, 'admin_gate_session'), { pool: runtime.pool });
  return interaction.editReply({ content: `**${featureGateLabel(gate.gate)}** ขณะนี้ ${gate.enabled ? 'เปิด' : 'ปิด'}`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId('gate_enable', session.id)).setLabel('เปิด').setStyle(ButtonStyle.Success).setDisabled(gate.enabled),
      new ButtonBuilder().setCustomId(customId('gate_disable', session.id)).setLabel('ปิด').setStyle(ButtonStyle.Danger).setDisabled(!gate.enabled),
    )] });
}
}

async function handleGateToggle({ interaction, route, runtime, gates: _gates }) {
if (['gate_enable','gate_disable'].includes(route.route) && interaction.isButton()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เมนูเปิด–ปิดระบบใช้ได้เฉพาะเจ้าของร้าน');
  await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_GATE' }, contextFor(interaction, 'admin_gate_load'), { pool: runtime.pool });
  return interaction.showModal(gateReasonModal(route.sessionId, route.route === 'gate_enable'));
}
}

async function handleGateSubmit({ interaction, route, runtime, gates: _gates }) {
if (['gate_enable_submit','gate_disable_submit'].includes(route.route) && interaction.isModalSubmit()) {
  if (interaction.user.id !== runtime.env.OWNER_ID) throw new QuestshopError('OWNER_ONLY', 'เมนูเปิด–ปิดระบบใช้ได้เฉพาะเจ้าของร้าน');
  await interaction.deferReply({ ephemeral: true });
  const context = contextFor(interaction, 'admin_gate_change');
  const session = await loadAdminSession({ sessionId: route.sessionId, actorId: interaction.user.id,
    guildId: interaction.guildId, channelId: interaction.channelId, operation: 'ADMIN_GATE' }, context, { pool: runtime.pool });
  const changed = await updateFeatureGate({ gate: session.payload.gate,
    enabled: route.route === 'gate_enable_submit', reason: interaction.fields.getTextInputValue('reason'),
    expectedVersion: session.payload.expectedVersion,
    release: runtime.env.PRELAUNCH ? {
      prelaunch: true, gitSha: runtime.env.GIT_SHA, appVersion: APP_VERSION, engineVersion: ENGINE_VERSION,
    } : null }, context, { pool: runtime.pool });
  await completeInteractionSession(session, interaction, runtime);
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
  "quest_back": handleQuestBack,
  "quest_confirm": handleQuestConfirm,
  "admin": handleAdminPanel,
  "admin_nav": handleAdminPanel,
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
  "review_assign": handleReviewAssign,
  "review_assign_submit": handleReviewAssignSubmit,
  "review_evidence": handleReviewEvidence,
  "review_evidence_submit": handleReviewEvidenceSubmit,
  "review_resolve": handleReviewResolve,
  "review_resolve_submit": handleReviewResolveSubmit,
  "review_resolve_confirm": handleReviewResolveConfirm,
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
  "monitor_check_all": handleMonitorCheckAll,
  "monitor_list": handleMonitorList,
  "monitor_select": handleMonitorSelect,
  "monitor_check_one": handleMonitorCheckOne,
  "monitor_rotate": handleMonitorRotate,
  "monitor_rotate_submit": handleMonitorRotateSubmit,
  "monitor_toggle": handleMonitorToggle,
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
  "test_fail_send": handleTestFailureSend,
  "test_fail_retry": handleTestFailureRetry,
  "admin_gate_pick": handleGatePick,
  "gate_enable": handleGateToggle,
  "gate_disable": handleGateToggle,
  "gate_enable_submit": handleGateSubmit,
  "gate_disable_submit": handleGateSubmit,
});

async function dispatchRoute(context) {
  const handler = ROUTE_HANDLERS[context.route.route]
    ?? (context.route.route.startsWith('admin_refresh_') ? handleAdminPanel : null);
  if (!handler) return null;
  return handler(context);
}

function startInteractionMetrics(interaction, runtime) {
  const started = performance.now();
  const traceId = uuidv7();
  let acknowledged = false;
  const write = (operation, outcome, durationMs, errorClass = null) => runtime.pool.query(`
    INSERT INTO operation_metrics(id,operation,outcome,duration_ms,error_class,trace_id)
    VALUES($1,$2,$3,$4,$5,$6)
  `, [uuidv7(), operation, outcome, Math.max(0, Math.round(durationMs)), errorClass, traceId]).catch(() => {});
  const markAcknowledged = () => {
    if (acknowledged) return;
    acknowledged = true;
    write('INTERACTION_ACK', 'SUCCESS', performance.now() - started);
  };
  for (const method of ['reply', 'deferReply', 'showModal', 'update', 'deferUpdate']) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = async (...args) => {
      const result = await original(...args);
      markAcknowledged();
      return result;
    };
  }
  return {
    complete(error = null) {
      const operation = isBackoffice(interaction, runtime) ? 'PANEL_REQUEST' : 'CUSTOMER_INTERACTION';
      write(operation, error ? 'ERROR' : 'SUCCESS', performance.now() - started,
        error?.category ?? error?.code ?? error?.name ?? null);
    },
  };
}

export async function routeInteraction(interaction) {
  const runtime = interaction.client.questshop;
  const metrics = startInteractionMetrics(interaction, runtime);
  let failure = null;
  try {
    if (runtime.acceptingInteractions === false) {
      throw new QuestshopError('RUNTIME_NOT_ACTIVE', 'ระบบกำลังหยุดทำงานชั่วคราว กรุณาลองใหม่ภายหลัง');
    }
    if (!interaction.inGuild() || interaction.guildId !== runtime.env.DISCORD_GUILD_ID) return;
    if (await handleSurfaceCommand(interaction, runtime)) return;
    const route = parseCustomId(interaction.customId);
    if (!route) return;
    const gates = await authorizeRoute(interaction, route, runtime);
    return dispatchRoute({ interaction, route, runtime, gates });
  } catch (error) {
    failure = error;
    runtime.logger.error({ error: safeError(error), interactionId: interaction.id }, 'interaction failed');
    return ephemeralError(interaction, error).catch(() => null);
  } finally {
    metrics.complete(failure);
  }
}

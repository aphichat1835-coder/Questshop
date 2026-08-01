export const INCIDENT = Object.freeze({
  SYSTEM_FAILURE: 'SYSTEM_FAILURE',
  CLIENT_STARTUP_FAILED: 'CLIENT_STARTUP_FAILED',
  DATABASE_OPEN_FAILED: 'DATABASE_OPEN_FAILED',
  DATABASE_MIGRATION_FAILED: 'DATABASE_MIGRATION_FAILED',
  RUNTIME_LEASE_CONFLICT: 'RUNTIME_LEASE_CONFLICT',
  RUNTIME_LEASE_LOST: 'RUNTIME_LEASE_LOST',
  HEALTH_SERVER_BIND_FAILED: 'HEALTH_SERVER_BIND_FAILED',
  DISCORD_LOGIN_FAILED: 'DISCORD_LOGIN_FAILED',
  DISCORD_SESSION_INVALIDATED: 'DISCORD_SESSION_INVALIDATED',
  UNCAUGHT_EXCEPTION: 'UNCAUGHT_EXCEPTION',
  UNHANDLED_REJECTION: 'UNHANDLED_REJECTION',
  BACKUP_PROTECTION_LOST: 'BACKUP_PROTECTION_LOST',
  QUEST_API_SCHEMA_INCOMPATIBLE: 'QUEST_API_SCHEMA_INCOMPATIBLE',
  QUEST_API_TRANSPORT_OUTAGE: 'QUEST_API_TRANSPORT_OUTAGE',
  RUNNER_RESTORE_SYSTEM_FAILED: 'RUNNER_RESTORE_SYSTEM_FAILED',
});

function freezeDefinition(definition) {
  return Object.freeze({
    ...definition,
    context: Object.freeze([...definition.context]),
  });
}

const DEFINITIONS = Object.freeze({
  [INCIDENT.SYSTEM_FAILURE]: freezeDefinition({
    title: 'เกิดข้อผิดพลาดระดับระบบ',
    impact: 'ความสามารถหลักของบอทอาจใช้งานไม่ได้หรือทำงานได้ไม่ครบ',
    action: 'ตรวจ Render logs ด้วย Incident ID และหยุดการ Deploy ซ้ำจนทราบสาเหตุ',
    context: ['component', 'operation', 'statusCode'],
  }),
  [INCIDENT.CLIENT_STARTUP_FAILED]: freezeDefinition({
    title: 'บอทเริ่มระบบไม่สำเร็จ',
    impact: 'คำสั่งและ Auto Daily ยังไม่พร้อมใช้งาน',
    action: 'ตรวจ Startup logs, Environment และ Dependency ก่อน Restart',
    context: ['stage', 'component'],
  }),
  [INCIDENT.DATABASE_OPEN_FAILED]: freezeDefinition({
    title: 'ไม่สามารถเปิดฐานข้อมูลได้',
    impact: 'บอทไม่สามารถอ่านหรือบันทึก Scheduled Runner ได้อย่างปลอดภัย',
    action: 'ตรวจ Persistent Disk, พื้นที่ว่าง, Path และ Permission ของฐานข้อมูล',
    context: ['storageMode', 'databasePathType', 'errorCode'],
  }),
  [INCIDENT.DATABASE_MIGRATION_FAILED]: freezeDefinition({
    title: 'การอัปเกรดฐานข้อมูลล้มเหลว',
    impact: 'โครงสร้างฐานข้อมูลยังไม่พร้อมและบอทต้องหยุดเพื่อป้องกันข้อมูลเสียหาย',
    action: 'ห้าม Retry แบบสุ่ม ตรวจ Backup และ Migration logs ก่อน Rollback หรือแก้ไข',
    context: ['migration', 'storageMode', 'errorCode'],
  }),
  [INCIDENT.RUNTIME_LEASE_CONFLICT]: freezeDefinition({
    title: 'พบบอทมากกว่าหนึ่ง Process',
    impact: 'มีความเสี่ยงต่อ Runner ซ้ำและการเขียนฐานข้อมูลชนกัน',
    action: 'ตั้ง Replica เป็น 1 และตรวจว่ามี Deployment เก่าที่ยังทำงานอยู่หรือไม่',
    context: ['leaseName', 'holder', 'replica'],
  }),
  [INCIDENT.RUNTIME_LEASE_LOST]: freezeDefinition({
    title: 'บอทสูญเสียสิทธิ์ควบคุมฐานข้อมูล',
    impact: 'Process ปัจจุบันต้องหยุดเพื่อป้องกันการทำงานซ้ำและข้อมูลชนกัน',
    action: 'ตรวจ Replica, Shared volume และ Process ที่ใช้ DATABASE_PATH เดียวกัน',
    context: ['leaseName', 'holder'],
  }),
  [INCIDENT.HEALTH_SERVER_BIND_FAILED]: freezeDefinition({
    title: 'Health server เปิดไม่สำเร็จ',
    impact: 'Render อาจมองว่า Service ไม่พร้อมและ Endpoint ตรวจสุขภาพใช้งานไม่ได้',
    action: 'ตรวจ PORT, Process ซ้ำ และ Render service configuration',
    context: ['port', 'errorCode'],
  }),
  [INCIDENT.DISCORD_LOGIN_FAILED]: freezeDefinition({
    title: 'บอทเชื่อมต่อ Discord ไม่สำเร็จ',
    impact: 'บอทออฟไลน์ คำสั่งและ Runner ทั้งหมดไม่ทำงาน',
    action: 'ตรวจ DISCORD_BOT_TOKEN และ Discord application status โดยห้ามเปิดเผย Token',
    context: ['errorCode', 'statusCode'],
  }),
  [INCIDENT.DISCORD_SESSION_INVALIDATED]: freezeDefinition({
    title: 'Discord session ใช้งานต่อไม่ได้',
    impact: 'บอทต้องปิด Process และรอการเริ่มระบบใหม่',
    action: 'ตรวจ Gateway logs และสถานะ Discord ก่อน Restart',
    context: ['shardId', 'closeCode'],
  }),
  [INCIDENT.UNCAUGHT_EXCEPTION]: freezeDefinition({
    title: 'Process พบ Exception ที่ไม่มีผู้รับผิดชอบ',
    impact: 'บอทกำลังปิดตัวเพื่อรักษาความถูกต้องของ State',
    action: 'ใช้ Incident ID หา Stack ใน Render logs แล้วเพิ่ม Regression test ก่อน Deploy ใหม่',
    context: ['component', 'operation'],
  }),
  [INCIDENT.UNHANDLED_REJECTION]: freezeDefinition({
    title: 'Process พบ Promise rejection ที่ไม่มีผู้รับผิดชอบ',
    impact: 'บอทกำลังปิดตัวเพื่อป้องกัน State ค้างหรือทำงานไม่ครบ',
    action: 'ใช้ Incident ID หา Root cause ใน Render logs และปิด Promise lifecycle ให้ครบ',
    context: ['component', 'operation'],
  }),
  [INCIDENT.BACKUP_PROTECTION_LOST]: freezeDefinition({
    title: 'การป้องกันฐานข้อมูลหยุดทำงาน',
    impact: 'ฐานข้อมูลยังอาจใช้งานได้ แต่ไม่มี Backup ใหม่ตามเกณฑ์ความปลอดภัย',
    action: 'ตรวจ Persistent Disk, พื้นที่ว่าง, Permission และ Backup age',
    context: ['consecutiveFailures', 'lastSuccessAt', 'backupAgeHours', 'storageMode'],
  }),
  [INCIDENT.QUEST_API_SCHEMA_INCOMPATIBLE]: freezeDefinition({
    title: 'Discord Quest API เปลี่ยนรูปแบบ',
    impact: 'Quest engine ไม่สามารถอ่านข้อมูลได้อย่างปลอดภัยและต้องหยุดเส้นทางที่ได้รับผลกระทบ',
    action: 'เก็บ Sanitized fixture ใหม่ ตรวจ Parser และเพิ่ม Regression test ก่อนเปิดใช้งานอีกครั้ง',
    context: ['endpoint', 'schemaIssueCount', 'questCount'],
  }),
  [INCIDENT.QUEST_API_TRANSPORT_OUTAGE]: freezeDefinition({
    title: 'Quest API ใช้งานไม่ได้ต่อเนื่อง',
    impact: 'Runner หลายบัญชีไม่สามารถตรวจหรือดำเนินการ Quest ได้',
    action: 'ตรวจ Discord status, HTTP status และ Retry history ก่อน Restart',
    context: ['endpointCount', 'consecutiveFailures', 'statusCode', 'durationMinutes'],
  }),
  [INCIDENT.RUNNER_RESTORE_SYSTEM_FAILED]: freezeDefinition({
    title: 'กู้คืน Auto Daily Runner ไม่สำเร็จ',
    impact: 'Scheduled Runner บางส่วนหรือทั้งหมดไม่กลับมาหลัง Restart',
    action: 'ตรวจ RUNNER_TOKEN_SECRET, Database integrity และ Restore summary โดยห้ามเปลี่ยน Secret เดาสุ่ม',
    context: ['total', 'restored', 'failed', 'decryptFailures', 'duplicateAccounts'],
  }),
});

export function getIncidentDefinition(code) {
  if (typeof code !== 'string' || !Object.hasOwn(DEFINITIONS, code)) {
    throw new TypeError(`Unknown incident code: ${code}`);
  }
  return DEFINITIONS[code];
}

function safePrimitive(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return '[OMITTED]';
}

export function allowlistedIncidentContext(code, context = {}) {
  const definition = getIncidentDefinition(code);
  const output = {};
  for (const key of definition.context) {
    if (!Object.hasOwn(context, key)) continue;
    const value = context[key];
    output[key] = Array.isArray(value)
      ? value.slice(0, 10).map(safePrimitive)
      : safePrimitive(value);
  }
  return output;
}

export function listIncidentCodes() {
  return Object.keys(DEFINITIONS);
}

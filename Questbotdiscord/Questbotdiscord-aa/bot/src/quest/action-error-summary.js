const CAPTCHA_KEYS = Object.freeze([
  'captcha_key',
  'captcha_sitekey',
  'captcha_service',
  'captcha_rqtoken',
  'captcha_rqdata',
]);

const INTERNAL_CODE_LABELS = Object.freeze({
  RUNNER_MUTATION_REQUIRES_VERIFICATION: 'ระบบกำลังตรวจสอบคำสั่งก่อนหน้า',
  RUNNER_MUTATION_CHECKPOINT_FAILED: 'บันทึกจุดตรวจสอบคำสั่งไม่สำเร็จ',
  RUNNER_CHECKPOINT_FAILED: 'บันทึกสถานะ Runner ไม่สำเร็จ',
  RUNNER_OWNERSHIP_LOST: 'Worker สูญเสียสิทธิ์ครอบครองงาน',
  QUEST_ENDPOINTS_UNAVAILABLE: 'Quest API ไม่พร้อมใช้งาน',
  QUEST_APPLICATION_ID_MISSING: 'ข้อมูลเกมของ Quest ไม่ครบ',
});

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function hasCaptchaChallenge(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && CAPTCHA_KEYS.some((key) => data[key] != null),
  );
}

function networkCode(error) {
  return error?.code ?? error?.cause?.code ?? null;
}

function httpDetail(status) {
  if (status === 400) return 'Discord ปฏิเสธข้อมูลคำขอ (HTTP 400)';
  if (status === 401) return 'Token ไม่ถูกต้องหรือหมดอายุ (HTTP 401)';
  if (status === 403) return 'บัญชีไม่มีสิทธิ์ดำเนินการ (HTTP 403)';
  if (status === 404) return 'ไม่พบ Quest endpoint ที่เรียกใช้ (HTTP 404)';
  if (status === 409) return 'สถานะ Quest ขัดแย้งกับคำขอ (HTTP 409)';
  if (status === 429) return 'Discord จำกัดความถี่ กรุณารอตามเวลาที่กำหนด (HTTP 429)';
  if (status >= 500) return `Discord ขัดข้องชั่วคราว (HTTP ${status})`;
  if (status >= 400) return `Discord ปฏิเสธคำขอ (HTTP ${status})`;
  return null;
}

export function questActionErrorDetail(error) {
  if (hasCaptchaChallenge(error?.data)) return 'Discord ต้องการการยืนยัน CAPTCHA';

  const code = String(error?.code ?? '');
  if (INTERNAL_CODE_LABELS[code]) return INTERNAL_CODE_LABELS[code];

  const status = Number(error?.status);
  if (Number.isInteger(status)) {
    const detail = httpDetail(status);
    if (detail) return detail;
  }

  if (error?.name === 'AbortError' || error?.message === 'aborted') {
    return 'การทำงานถูกยกเลิก';
  }
  if (error?.name === 'QuestCompatibilityError') {
    return 'รูปแบบข้อมูล Quest ไม่รองรับ';
  }
  if (error?.name === 'TimeoutError' || code === 'ETIMEDOUT') {
    return 'การเชื่อมต่อหมดเวลา';
  }
  if (NETWORK_CODES.has(networkCode(error))) return 'เชื่อมต่อ Discord ไม่สำเร็จ';
  if (error instanceof TypeError) return 'ข้อมูลภายในระบบไม่ถูกต้อง';
  return 'เกิดข้อผิดพลาดภายในระบบ';
}

export function questActionFailureReason(error, action = 'ดำเนินการ Quest') {
  return `${action} ไม่สำเร็จ — ${questActionErrorDetail(error)}`;
}

export function safeQuestApiPath(path) {
  if (typeof path !== 'string') return null;
  return path
    .replace(/\/quests\/[^/]+\//, '/quests/:questId/')
    .slice(0, 160);
}

export function questActionErrorDiagnostic(error) {
  return Object.freeze({
    category: questActionErrorDetail(error),
    status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null,
    code: typeof error?.code === 'string' ? error.code.slice(0, 80) : null,
    path: safeQuestApiPath(error?.path),
    captcha: hasCaptchaChallenge(error?.data),
  });
}

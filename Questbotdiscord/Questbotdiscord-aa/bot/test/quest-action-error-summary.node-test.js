import './setup-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  questActionErrorDiagnostic,
  questActionErrorDetail,
  questActionFailureReason,
  safeQuestApiPath,
} from '../src/quest/action-error-summary.js';

test('Quest action errors distinguish HTTP, CAPTCHA and internal guard failures', () => {
  assert.equal(
    questActionFailureReason({ status: 403 }, 'รับ Quest'),
    'รับ Quest ไม่สำเร็จ — บัญชีไม่มีสิทธิ์ดำเนินการ (HTTP 403)',
  );
  assert.equal(
    questActionErrorDetail({ status: 400, data: { captcha_sitekey: 'secret-site-key' } }),
    'Discord ต้องการการยืนยัน CAPTCHA',
  );
  assert.equal(
    questActionErrorDetail({ code: 'RUNNER_MUTATION_REQUIRES_VERIFICATION' }),
    'ระบบกำลังตรวจสอบคำสั่งก่อนหน้า',
  );
  assert.equal(
    questActionErrorDetail({ code: 'RUNNER_OWNERSHIP_LOST' }),
    'Worker สูญเสียสิทธิ์ครอบครองงาน',
  );
});

test('Quest diagnostics expose only bounded allowlisted fields', () => {
  const diagnostic = questActionErrorDiagnostic({
    status: 429,
    code: 'RATE_LIMITED',
    path: '/quests/123456789012345678/enroll',
    data: {
      captcha_key: 'must-not-appear',
      token: 'must-not-appear',
      message: 'must-not-appear',
    },
  });

  assert.deepEqual(diagnostic, {
    category: 'Discord ต้องการการยืนยัน CAPTCHA',
    status: 429,
    code: 'RATE_LIMITED',
    path: '/quests/:questId/enroll',
    captcha: true,
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /must-not-appear|123456789012345678/);
  assert.equal(Object.isFrozen(diagnostic), true);
});

test('safe Quest paths redact external identifiers and reject non-string values', () => {
  assert.equal(
    safeQuestApiPath('/quests/quest-sensitive/video-progress'),
    '/quests/:questId/video-progress',
  );
  assert.equal(safeQuestApiPath(null), null);
});

test('unknown and network errors remain useful without leaking raw messages', () => {
  const network = Object.assign(new Error('token-secret-inside-message'), { code: 'ECONNRESET' });
  assert.equal(questActionErrorDetail(network), 'เชื่อมต่อ Discord ไม่สำเร็จ');
  assert.equal(questActionErrorDetail(new Error('token-secret-inside-message')), 'เกิดข้อผิดพลาดภายในระบบ');
  assert.doesNotMatch(questActionFailureReason(network), /token-secret/);
});

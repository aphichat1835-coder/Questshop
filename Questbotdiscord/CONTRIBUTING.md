# แนวทางการพัฒนา NeverDie Quest Bot

Repository นี้เป็น Bot-only การเปลี่ยนแปลงต้องรักษาขอบเขตปัจจุบันและไม่เพิ่ม Desktop/Tauri, CDP launcher, Game Simulator หรือ Quest Tracker แบบกรอก Quest ID กลับเข้ามา

## เริ่มต้น

```bash
git clone https://github.com/aphichat1835-coder/Questbotdiscord.git
cd Questbotdiscord/bot
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
cp .env.example .env
npm run validate:quest-fixture
npm test
npm run check
```

## โครงสร้างหลัก

- `bot/src/commands/` — Slash commands และ Interaction handlers
- `bot/src/discord-runner.js` — Quest engine และ Job registry
- `bot/src/run-admission-lock.js` — Serialize การนับ Slot/เริ่ม Runner ต่อ Owner
- `bot/src/runner-control.js` — Stop lifecycle และการรอ Cleanup
- `bot/src/scheduled-runner-store.js` — Scheduled Runner persistence และ Token encryption boundary
- `bot/src/db.js` — SQLite schema, Migration และ Backup Slot
- `bot/src/worker.js` — Backup scheduler
- `bot/src/dashboard.js` — HTTP health/status endpoint
- `bot/src/error-reporter.js` — Render log, emergency classification, redaction และ Discord Webhook delivery
- `bot/src/runner-status-header.js` — Persistent status header และ Message length guard
- `bot/scripts/` — Fixture validation และ Read-only smoke
- `bot/test/` — Unit/Regression tests
- `bot/PRODUCTION-CHECKLIST.md` — Production acceptance และ Rollback

## กระบวนการเปลี่ยนแปลง

1. ระบุ Intent, Scope, ความเสี่ยง และเกณฑ์ Done
2. อ่าน Data flow และไฟล์ที่ได้รับผลกระทบก่อนแก้
3. แยก Security/Permission check ไว้ที่ Action boundary
4. เพิ่มหรือปรับ Test ให้จับ Regression ของ Root cause
5. อัปเดต README, `.env.example`, Help text และ Checklist เมื่อพฤติกรรมเปลี่ยน
6. รัน Quality gates ทั้งหมดก่อน Push
7. ตรวจ GitHub Actions และ Review comments หลัง Push

## กฎสำคัญ

- ใช้ ES Modules และ Node.js ตาม `.node-version`
- Interaction ส่วนตัวใช้ `flags: 64`
- ตรวจ Permission ที่ Action boundary; `/api-status` ต้องเป็น Owner/Admin/Manager
- ห้ามเก็บหรือพิมพ์ Token, Ciphertext, Username, Account ID หรือ Webhook URL ลง Log ที่ไม่จำเป็น
- Render/Console logs เป็นแหล่งบันทึก Error ทุกระดับ ห้ามตัดออกเพราะมี Webhook
- Webhook ใช้เฉพาะเหตุระบบฉุกเฉินจริง ไม่ใช้กับ Error ระดับบัญชีเดียวหรือเหตุชั่วคราว
- Webhook payload ต้องปิด Mentions, ผ่าน Redaction และอยู่ภายใน Discord limits
- การส่ง Webhook ล้มเหลวต้องไม่ทำให้ Bot ดับ
- Auto Daily Token ต้องเข้ารหัสก่อนบันทึกและผูก AAD กับ Owner/Account
- จำกัด Runner สูงสุด 10 ตัวต่อ Owner โดยใช้ `withOwnerAdmissionLock()` รอบ Slot count และ Start flow
- Stop ต้องคง Account block จน Cleanup จบจริง
- Quest เสร็จเมื่อ Discord ยืนยัน `completed_at`
- Claim สำเร็จเมื่อ Discord ยืนยัน `claimed_at`
- Mutation retry ต้องตรวจ Fresh state ก่อนส่งซ้ำ
- Runner status message ต้องไม่เกิน 1,950 ตัวอักษรและต้องปิด Code block ถูกต้อง
- Backup destination อนุญาตเฉพาะ `./data/backups` และ `/var/data/backups`
- ห้ามเพิ่ม `DATABASE_BACKUP_DIR` หรือรับ Backup destination จาก Input/Environment
- Client profile อ่านตอน Startup; การเปลี่ยน Environment ต้อง Restart
- ทุกการเปลี่ยนแปลงต้องมี Test หรือหลักฐานตรวจสอบที่เหมาะสม

## การเขียน Test

- ใช้ `node:test` และ `node:assert/strict`
- Test ต้องมี Assertion ที่ตรวจผลลัพธ์จริง ไม่ใช้เพียงการรันแล้วไม่ Throw
- Mock Network ที่ Boundary และตรวจ State หลัง Mutation
- Test ทั่วไปห้ามส่ง External Webhook จริง; เปิดการจำลอง Delivery เฉพาะไฟล์ Test ของ Error reporter
- ต้อง Test การจำแนก Emergency, Redaction, Mention safety, Retry, Dedupe และ Embed limits
- เมื่อแก้ Race condition ให้ Test ลำดับ/Concurrency
- เมื่อแก้ Permission ให้ Test Unauthorized path ก่อนอ่านข้อมูลระบบ
- เมื่อแก้ข้อความ Discord ให้ Test Message limit และรูปแบบ Output
- Fixture ต้องไม่มีข้อมูลบัญชีจริง

## ก่อนส่ง Pull Request

รันจากโฟลเดอร์ `bot`:

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```

`npm run check` ตรวจทั้ง `src` และ `scripts`; ห้ามแทนด้วยคำสั่งที่ตรวจเฉพาะ `src`

จากนั้นตรวจว่า GitHub Actions ผ่าน:

- Repository shape
- Approved database backup destinations
- Unit/Regression tests
- Environment contract tests
- Emergency webhook tests
- Syntax check
- Production dependency audit

## เอกสารและ Production

เมื่อเปลี่ยน Command, Environment, Permission, Backup, Schedule, Health endpoint, Webhook หรือ Test boundary ต้องอัปเดตเอกสารที่เกี่ยวข้องใน Commit เดียวกัน

Read-only Smoke ไม่ยืนยัน Enroll/Progress/Heartbeat/Claim จริง ก่อน Deploy ให้ทำตาม [`bot/PRODUCTION-CHECKLIST.md`](bot/PRODUCTION-CHECKLIST.md) และบันทึก Commit SHA/Backup สำหรับ Rollback

## Runtime data contract

ห้าม Commit Runtime SQLite, WAL/SHM/rollback journal หรือ Backup ทุกชนิด ก่อน Push ให้ตรวจ:

```bash
git ls-files | grep -E '(^|/)(data|backups)/|\.(db|sqlite)(-(wal|shm|journal))?$'
```

คำสั่งตรวจสอบอาจแสดงชื่อไฟล์หรือผล Validation ที่ไม่อ่อนไหวได้ แต่ห้ามแสดง Secret, Token, Ciphertext, Webhook URL หรือ Runtime path ที่เป็นข้อมูลภายใน และ Test ใหม่ต้องอยู่ใต้ `bot/test/` เพื่อให้ `node --test` ค้นหาแบบ Recursive

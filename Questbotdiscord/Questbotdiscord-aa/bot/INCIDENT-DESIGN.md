# Backend Incident Architecture

เอกสารนี้เป็นสัญญาการออกแบบสำหรับกิ่ง `aa` และใช้คู่กับ `PRODUCTION-CHECKLIST.md`

## Core contract

- Render/Console logs เป็นหลักฐาน Error ทุกระดับ
- Discord Webhook รับเฉพาะ Structured Incident ที่มี Code จาก `incident-catalog.js`
- Incident context ใช้ Allowlist ต่อ Code ห้ามส่ง Arbitrary object
- Incident definitions และ Context allowlists ถูก Deep-freeze และรับเฉพาะ Own property ของ Catalog
- Webhook ปิด Mentions และ Redirect
- HTTP 429/502/503/504 Retry ได้สูงสุดหนึ่งครั้ง
- Network timeout หลังเริ่ม POST ถือเป็น `delivery_unknown` และไม่ส่ง POST ซ้ำทันทีแบบเดาสุ่ม
- Incident เดียวกันใช้ `code + scope` เป็น Identity และ Reserve state ก่อน Network call เพื่อกัน Concurrent duplicate
- Incident ที่ส่งสำเร็จคงสถานะเปิดและ Suppress เหตุซ้ำจนกว่าจะส่ง Recovery สำเร็จ
- Delivery ที่ล้มมี Retry guard สั้นก่อนให้เหตุการณ์ถัดไปลองส่งด้วย Incident ID เดิม
- Incident ที่กลับมาปกติส่ง Recovery ด้วย Incident ID เดิม; Recovery ที่ส่งล้มสามารถ Retry ได้
- State ที่หมดอายุถูก Prune เพื่อไม่ให้ Memory โตตลอดอายุ Process
- `/api/status` แสดงเฉพาะสถานะการส่ง, Storage mode และ Backup health ห้ามแสดง Credential หรือ Full database path

## Safe bootstrap

`index.js` ติดตั้ง Process handlers ก่อน Dynamic import ของ Runtime modules ดังนั้น Config, Database หรือ Module import ที่ล้มยังสามารถใช้ Bootstrap reporter ซึ่งไม่พึ่ง `config.js`, SQLite หรือ Discord Client

ลำดับ Startup:

1. ติดตั้ง Bootstrap handlers
2. โหลด Runtime modules
3. เปิดฐานข้อมูลและ Migration
4. Acquire runtime lease
5. Bind Health server และรอ `listening`
6. โหลด Discord client profile
7. Login Discord
8. Start worker และ Restore runners

Fatal report มี Budget รวม 3.5 วินาทีก่อน Shutdown เพื่อไม่ให้ Process ค้างไม่สิ้นสุด Timer ถูกล้างเมื่อ Report เสร็จ และ Runtime ใช้ Fatal/Shutdown promise เดียวเพื่อป้องกัน Cleanup ซ้อน พร้อมรักษา Exit code ที่รุนแรงที่สุด

## Incident classes

### แจ้งทันที

- `DATABASE_OPEN_FAILED`
- `DATABASE_MIGRATION_FAILED`
- `RUNTIME_LEASE_CONFLICT`
- `RUNTIME_LEASE_LOST`
- `HEALTH_SERVER_BIND_FAILED`
- `DISCORD_LOGIN_FAILED`
- `DISCORD_SESSION_INVALIDATED`
- `UNCAUGHT_EXCEPTION`
- `UNHANDLED_REJECTION`
- `QUEST_API_SCHEMA_INCOMPATIBLE`

### แจ้งเมื่อผ่าน Threshold

- `BACKUP_PROTECTION_LOST`
  - Failure ติดต่อกัน 3 ครั้ง หรือ Backup เก่าเกิน 26 ชั่วโมง
  - Failure ครั้งแรกและครั้งที่สองอยู่ใน Render logs เท่านั้น
  - เมื่อเปิด Incident แล้ว Failure ถัดไปอยู่ใน Render logs โดยไม่ยิง Webhook ซ้ำ
  - Fast retry ทุก 15 นาทีสูงสุด 3 รอบ จากนั้นกลับตาราง Daily
  - ส่ง Recovery เมื่อ Backup สำเร็จอีกครั้ง และ Retry Recovery ใน Backup success รอบถัดไปเมื่อ Delivery ล้ม
- `QUEST_API_TRANSPORT_OUTAGE`
  - ต้องพบ Transport outage 3 ครั้งภายใน 10 นาที
  - Unknown Quest event ไม่ใช่ Emergency
- `RUNNER_RESTORE_SYSTEM_FAILED`
  - รวม Restore failure 3 รายการภายใน 10 นาทีเป็น Incident เดียว
  - Context แสดงเฉพาะยอดรวมและประเภท failure

### ไม่แจ้ง Webhook

- User Token หมดอายุหรือไม่มีสิทธิ์
- Error ของบัญชีเดียว
- Unknown Quest event
- Interaction error
- Discord shard สะดุดชั่วคราว

## Storage truth

ระบบใช้ `storage-profile.js` เป็น Source of truth เดียวและไม่เขียนค่ากลับเข้า `process.env`

- `memory` — ไม่มี Durability และปิด Backup
- `local-development` — Local file สำหรับการพัฒนา
- `hosted-ephemeral` — Hosting ไม่มี Persistent mount; แสดง Warning ชัดเจน
- `persistent-candidate` — `/var/data` มีและเขียนได้ แต่ยังไม่ถือว่า Verified จนผ่าน Controlled restart

Backup directory, Slot operations, Cleanup, Latest-backup inspection และ Legacy migration backup ต้องใช้ Fixed backup profile เดียวกัน:

- Database นอก `/var/data/` → `./data/backups`
- Database ใต้ `/var/data/` → `/var/data/backups`

Profile อื่นถูกปฏิเสธและระบบไม่รองรับ `DATABASE_BACKUP_DIR`

คำว่า Persistent ต้องพิสูจน์ด้วยการ Restart/Redeploy แล้ว Database และ Backup ยังอยู่ ไม่ใช้เพียงการตรวจ Directory

## Required environment

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OWNER_ID=
RUNNER_TOKEN_SECRET=
LOG_WEBHOOK_URL=
```

ค่าอื่นยัง Override ได้ แต่ไม่บังคับเมื่อมี Default ที่ปลอดภัย `LOG_CHANNEL_ID` ยังคง Optional สำหรับข้อความสถานะ Runner เดิม

## Compatibility boundary

`reportCriticalError()` ยังเป็น Transitional bridge สำหรับ Caller ขนาดใหญ่ใน Quest runner โดย policy ถูกย้ายไป `legacy-incident-policy.js` และมี Test ครบสำหรับ Transport/Restore threshold Counter ถูก Prune และ Reset หลัง Escalate ทางเลือกนี้ลดความเสี่ยงจากการแทนไฟล์ Runner ทั้งก้อน และต้องถูกลบเมื่อ Caller ถูกแยกเป็นโมดูลเล็กในงานถัดไป

## Completion boundary

GitHub Actions ยืนยัน Gate ต่อไปนี้บน Snapshot เดียวกัน:

- Repository shape และ Runtime data safety
- Sanitized Quest API fixture
- Fixed database backup destinations
- Incident และ Storage architecture boundaries
- Environment contract และ Semantic no-mutation tests
- Safe bootstrap, Health bind และ Serialized shutdown tests
- Storage profile และ Backup profile consistency tests
- Backup threshold, bounded retry และ Recovery retry tests
- Incident classification, immutability, redaction, concurrency, delivery และ Recovery lifecycle tests
- Webhook URL validation, redirect safety และ Retry ceiling tests
- Recursive Unit/Regression tests พร้อม Coverage gate
- Syntax check ของ `src` และ `scripts`
- Production dependency audit

CI ยังไม่ยืนยัน:

- Webhook URL จริง
- Discord login จริง
- Render persistent disk หลัง Restart/Redeploy
- Scheduled Runner restore จริงบน Hosting
- Live Quest Enroll/Progress/Heartbeat/Claim

ต้องผ่าน Controlled UAT และ Rollback checklist ก่อน Merge/Deploy

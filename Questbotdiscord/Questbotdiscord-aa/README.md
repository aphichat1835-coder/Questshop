# NeverDie Quest Bot

Discord Bot แบบ Bot-only สำหรับตรวจและดำเนินการกับ Discord Quest ที่รองรับ ไม่มี Desktop/Tauri, CDP launcher, Game Simulator หรือ Quest Tracker แบบกรอก Quest ID

## คำสั่ง

- `/panel` — เปิดแผง One-shot ที่มี `START NOW` และ `STOP ALL`
- `/run` — เริ่ม Auto Daily ตรวจทันทีและตามเวลา 00:00 / 08:00 / 16:00
- `/stop` — เลือกหยุด Auto Daily Runner
- `/api-status` — ดูสถานะ Logging, Storage, Backup, Runner และ Quest API; ใช้ได้เฉพาะ Owner/Admin/Manager
- `/ping` และ `/help`

การเริ่ม Runner จำกัดสูงสุด 10 บัญชีต่อผู้ใช้ การนับช่องและเริ่ม Runner ถูกล็อกเป็นชุดเดียวกันเพื่อป้องกันคำสั่งพร้อมกันเปิดเกินจำนวน

## ค่าหลักสำหรับ Deploy

ระบบบังคับให้ตั้งเพียง 6 ค่า:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `OWNER_ID`
- `RUNNER_TOKEN_SECRET`
- `LOG_WEBHOOK_URL`

ค่าอื่นยัง Override ได้ แต่มีค่าเริ่มต้นอัตโนมัติและไม่บังคับกรอก `LOG_CHANNEL_ID` ยังคงเป็น Optional fallback สำหรับข้อความสถานะ Runner ส่วน `LOG_WEBHOOK_URL` เป็น Backend incident log ส่วนตัว

## Incident และ Recovery

- Render/Console logs เก็บ Error ทุกระดับ
- Discord Webhook ส่งเฉพาะ Structured Incident ที่มี Code และ Context allowlist
- Incident state ถูก Reserve ก่อน Network call เพื่อกัน Concurrent duplicate
- Webhook ปิด Mention, ปิด Redirect และ Retry เฉพาะ 429/502/503/504 สูงสุดหนึ่งครั้ง
- Network timeout หลังเริ่ม POST เป็น `delivery_unknown` และไม่ส่ง POST ซ้ำทันทีแบบเดาสุ่ม
- Incident ที่ส่งสำเร็จเปิดอยู่และ Suppress เหตุซ้ำจนกว่าจะ Recovery
- Delivery/Recovery ที่ล้มมี Retry guard และใช้ Incident ID เดิม
- User Token หมดอายุ, Error ของบัญชีเดียว และ Unknown Quest event ไม่ส่ง Webhook
- Quest transport outage และ Scheduled Runner restore failure ต้องผ่าน Threshold ก่อนส่ง
- Quest schema/parser break ส่งทันที

## Safe bootstrap

Process handlers และ Bootstrap reporter ถูกติดตั้งก่อนโหลด Config, Database และ Discord runtime ดังนั้น Database open/migration failure, Runtime lease conflict, Health bind failure และ Discord login failure ถูกแยก Incident code และ Shutdown อย่างมี Budget

Health server ต้อง Bind สำเร็จก่อน Startup ผ่าน ระบบไม่ปล่อย Bot ทำงานแบบครึ่งระบบโดยไม่มี Health endpoint Runtime ใช้ Fatal/Shutdown promise เดียวเพื่อป้องกัน Cleanup ซ้อน

## Storage และ Backup

Storage profile ถูกเลือกโดยอัตโนมัติและไม่แก้ค่าใน `process.env`:

- `memory` — ไม่มี Durability และปิด Backup
- `local-development` — Local file
- `hosted-ephemeral` — Hosting ไม่มี Persistent mount และมี Warning
- `persistent-candidate` — ใช้ `/var/data` แต่ต้องพิสูจน์ด้วย Controlled restart ก่อนถือว่า Persistent จริง

Backup สำหรับ Database แบบไฟล์:

- Database นอก `/var/data/` ใช้ `./data/backups`
- Database ใต้ `/var/data/` ใช้ `/var/data/backups`
- Directory, Slots, Cleanup, Latest-backup inspection และ Migration backup ใช้ Fixed profile เดียวกัน
- เก็บสูงสุด 7 Slot
- Failure ครั้งแรกและครั้งที่สองอยู่ใน Render logs
- Failure ครั้งที่ 3 หรือ Backup เก่าเกิน 26 ชั่วโมงเปิด Incident หนึ่งรายการ
- Fast retry ทุก 15 นาทีสูงสุด 3 รอบ แล้วกลับตาราง Daily
- Failure ระหว่าง Incident เปิดอยู่ไม่ยิง Webhook ซ้ำ
- Recovery ที่ส่งล้มจะลองใหม่ใน Backup success รอบถัดไป

## ความปลอดภัยและข้อมูล

- Auto Daily เก็บ Token แบบเข้ารหัส AES-256-GCM โดยผูกข้อมูลกับ Owner และ Account
- Payload ปิดบัง Token, Secret, Cookie, CAPTCHA, Email, Ciphertext, Password, Compound secret keys และ Webhook URL
- Incident context ใช้ Deep-frozen Allowlist ต่อ Code ไม่รับ Arbitrary object
- Token, Ciphertext, Username และ Account ID ไม่ถูกพิมพ์ใน Smoke Test log
- HTTP `/api/status` ต้องใช้ Bearer token และจะปิดเมื่อไม่ได้ตั้งค่า
- Status หลังบ้านไม่แสดง Webhook URL, Full database path หรือ Backup directory

## การตรวจสอบ

CI ตรวจ Repository shape, Sanitized Quest fixture, Fixed backup destinations, Incident/Storage architecture boundaries, Environment no-mutation, Safe bootstrap, Serialized shutdown, Storage/Backup profile, Bounded backup retry/recovery, Incident concurrency/redaction/recovery, Webhook retry ceiling, Unit/Regression coverage, Syntax และ Production dependency audit

Manual Quest API smoke เป็นแบบ Read-only: ตรวจบัญชีและอ่านรายการ Quest เท่านั้น ไม่ Enroll, Progress, Heartbeat หรือ Claim การเปลี่ยนข้อมูลจริงต้องตรวจด้วยขั้นตอนควบคุมก่อน Production

## เริ่มใช้งาน

```bash
cd bot
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
cp .env.example .env
npm run register
npm start
```

ดูรายละเอียดที่:

- [`bot/README.md`](bot/README.md)
- [`bot/INCIDENT-DESIGN.md`](bot/INCIDENT-DESIGN.md)
- [`bot/PRODUCTION-CHECKLIST.md`](bot/PRODUCTION-CHECKLIST.md)

> **คำเตือน:** ระบบที่ใช้ข้อมูลรับรองของบัญชีผู้ใช้เพื่อทำงานอัตโนมัติมีความเสี่ยงด้านบัญชีและข้อกำหนดของแพลตฟอร์ม ผู้ดูแลต้องตรวจสอบกฎปัจจุบันและยอมรับความเสี่ยงก่อนใช้งานจริง

## Runtime hardening

- Runtime SQLite databases, WAL/SHM files and backup files are forbidden in Git and rejected by CI.
- A shared-database runtime lease prevents two Bot processes from running against the same database.
- Production must run exactly one Replica unless every Replica shares the same `DATABASE_PATH`.
- The same Discord account cannot be admitted by different Managers at the same time.
- Each Modal accepts at most 10 Token entries.
- Mutation retry stops when Fresh-state verification itself cannot be completed.
- Stopped Job history remains available per account but is excluded from the active aggregate health state.

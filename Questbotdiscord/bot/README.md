# NeverDie Quest Bot — คู่มือระบบปัจจุบัน

ระบบนี้เป็น Discord Bot แบบ Bot-only สำหรับตรวจและดำเนินการกับ Discord Quest ที่รองรับ ไม่มี Desktop/Tauri, CDP launcher, Game Simulator หรือ Quest Tracker แบบกรอก Quest ID

## ติดตั้ง

ต้องใช้ Node.js ตาม `.node-version` และ `package.json`

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
cp .env.example .env
npm run register
npm start
```

หลังแก้ Slash command ให้รัน `npm run register` ใหม่

## Environment

### ค่าหลักที่จำเป็น 6 ค่า

- `DISCORD_BOT_TOKEN` — Token ของ Bot
- `DISCORD_CLIENT_ID` — Application/Client ID
- `DISCORD_GUILD_ID` — Server ที่ลงทะเบียนคำสั่ง
- `OWNER_ID` — Discord User ID ของเจ้าของระบบ
- `RUNNER_TOKEN_SECRET` — Secret ยาวอย่างน้อย 16 ตัวอักษรสำหรับเข้ารหัส Token ของ Auto Daily
- `LOG_WEBHOOK_URL` — Discord Incoming Webhook ส่วนตัวสำหรับ Backend incident log

หากค่าหลักขาดหรือรูปแบบไม่ถูกต้อง Process จะหยุดตั้งแต่ Startup โดยไม่เริ่มระบบแบบตั้งค่าครึ่งเดียว

### Optional overrides

- `MANAGER_ROLE_ID` — Role ที่ใช้ `/run`, `/panel` และ `/api-status`; `/stop` จำกัดเฉพาะเจ้าของ Runner ส่วน Owner/Admin ใช้คำสั่ง Manager ได้เสมอ
- `TIMEZONE` — ค่าเริ่มต้น `Asia/Bangkok`
- `LOG_CHANNEL_ID` — ห้องสำรองสำหรับข้อความสถานะ Runner ไม่ใช่ Incident Webhook
- `DATABASE_PATH`, `DATABASE_BACKUP_ENABLED`, `DATABASE_BACKUP_RETENTION`
- `HEALTH_STATUS_TOKEN` — เปิด HTTP `GET /api/status`
- `PORT` — Port ของ Health server
- `QUEST_PROCESS_ROLE` — `all`, `control` หรือ `worker`; ค่าเริ่มต้น `all`
- `QUEST_WORKER_POLL_MS` — รอบ Reconcile ของ Worker ค่าเริ่มต้น 5000 ms
- `DISCORD_LOCALE` — Locale ของ Discord client profile ค่าเริ่มต้น `en-US`
- `DISCORD_TIMEZONE` — Timezone ของ Discord client profile ค่าเริ่มต้น `Asia/Bangkok`
- Discord client profile overrides ต้องเปลี่ยนพร้อมกันทั้งชุดและ Restart

## Process topology

### โหมดแนะนำ: All-in-one

```env
QUEST_PROCESS_ROLE=all
```

```bash
npm start
```

โหมดนี้เปิด Discord Gateway, Commands, One-shot และ Auto Daily ใน Process เดียว เหมาะกับ Deployment ปัจจุบันที่มี Service เดียวและเป็นค่าเริ่มต้นที่ปลอดภัยที่สุด

### โหมดแยก Control + Worker

Control plane:

```env
QUEST_PROCESS_ROLE=control
PORT=3000
```

```bash
npm run start:control
```

Scheduled Worker:

```env
QUEST_PROCESS_ROLE=worker
PORT=3001
```

```bash
npm run start:worker
```

พฤติกรรม:

- Control เปิด Discord Gateway, Commands, Panel และ One-shot
- `/run` ของ Control เข้ารหัส Token และสร้าง Scheduled row/Checkpoint
- Worker ไม่เปิด Discord Gateway แต่ใช้ Discord REST v10 สำหรับข้อความสถานะ
- Worker Reconcile Scheduled rows แล้ว Start/Stop/Retry งานจริง
- One-shot ไม่ถูกส่งข้าม Process และไม่ Persist Token เพิ่ม

ข้อกำหนด Split mode:

1. Control และ Worker ต้องเห็น `DATABASE_PATH` เดียวกันจริง
2. ใช้ `RUNNER_TOKEN_SECRET` เดียวกัน
3. ใช้ Port คนละค่า
4. ห้ามรัน `all` พร้อม `control` หรือ `worker`
5. SQLite ต้องอยู่บน Filesystem ที่ทั้งสอง Process เข้าถึงได้อย่างน่าเชื่อถือ
6. หากแต่ละ Hosting service มี Local disk แยกกัน ให้ใช้ `all` จนกว่าจะมี Shared durable store

Runtime lease ป้องกัน Process Role ซ้ำและป้องกัน All-in-one ทำ Scheduled Quest ซ้ำกับ Worker

## Safe bootstrap

`index.js` ติดตั้ง Bootstrap handlers ก่อน Dynamic import ของ Config และ Runtime จากนั้นเลือก `app.js` หรือ `worker-app.js` ตาม Process role

Startup หลัก:

1. ติดตั้ง Bootstrap handlers
2. โหลด Config และเลือก Process role
3. เปิดฐานข้อมูลและ Migration
4. Acquire topology lease
5. Bind Health server
6. ติดตั้ง Discord API v10 transport
7. Control/All Login Discord Gateway; Worker ไม่ Login Gateway
8. Restore Scheduled Runner และ Start Supervisor ตาม Role
9. Mark Health ready เมื่อ Runtime พร้อมจริง

Health bind, Database, Config, Login หรือ Lease failure ทำให้ Startup ล้มและเข้าสู่ Fatal shutdown เดียว ไม่ปล่อยระบบทำงานครึ่งหนึ่ง

## Discord API v10 และ Rate limit

Outbound Discord API request ถูก Rewrite เป็น v10 ก่อนส่งจริง โดยไม่แก้ Webhook หรือ URL ภายนอก

Global coordinator:

- บัญชีเดียวส่ง Request พร้อมกันได้หนึ่งรายการ
- หลายบัญชีทำงานพร้อมกันได้ตาม Concurrency limit
- จดจำ Route/Bucket และเคารพ Retry headers
- Global 429 หยุด Queue ทั้งหมด
- Claim/Verification มี Priority สูงกว่า Background request
- Queue timer ปรับตาม Bucket ที่ปลดเร็วที่สุด
- Authorization ถูกเก็บใน Queue เป็น Fingerprint ไม่ใช่ Raw token

## Durable Runner state

SQLite ตาราง `runner_states` เก็บ Lifecycle, Quest, Progress, Next action, Retry และ Error โดยไม่เพิ่ม Token

Scheduled Runner ที่ Process หยุดกลางงานเข้า `RECOVERING` และกู้จาก Scheduled row ส่วน One-shot เข้า `FAILED` เพราะไม่มี Token สำหรับ Restore

Partial transition ไม่ล้าง Checkpoint โดยไม่ตั้งใจ และ Observer แยก Error ต่อ Job ไม่ทำให้บอททั้ง Processปิดจาก Checkpoint รายการเดียว

## Smart Scheduler

ระบบอ่าน Quest response ผ่าน `response.clone()` แล้วสร้าง Wake-up hint จาก:

1. Claim พร้อม
2. Quest ใกล้หมดอายุแต่ยังไม่หมดอายุ
3. Verification/Retry
4. Enrollment เปิด
5. Quest เริ่ม
6. รอบตรวจพื้นฐาน

Scheduled Runner ถูกปลุกเฉพาะเมื่อกำลังหลับ ไม่ตัด Progress mutation กลางทาง

## Backend Incident Webhook

Render/Console logs บันทึก Error ทุกระดับ ส่วน Webhook รับเฉพาะ Structured Incident:

- Incident มี Code, Incident ID, Impact, Action, Runtime และ Deployment
- Context ใช้ Deep-frozen allowlist
- ปิด Mentions และ Redirect
- HTTP 429/502/503/504 Retry ได้สูงสุดหนึ่งครั้ง
- Network timeout หลังเริ่ม POST เป็น `delivery_unknown` และไม่ส่งซ้ำแบบเดา
- Concurrent incident เดียวกันมี Network delivery เพียงหนึ่งรายการ
- Webhook ล้มไม่ทำให้ Bot ดับ

รายละเอียดอยู่ที่ [`INCIDENT-DESIGN.md`](INCIDENT-DESIGN.md)

## Storage และ Backup

ระบบใช้ Storage profile เป็น Source of truth เดียวและไม่เขียนค่าอัตโนมัติกลับเข้า `process.env`

| Mode | ความหมาย |
|---|---|
| `memory` | ไม่มี Durability และ Backup ปิด |
| `local-development` | Local file สำหรับพัฒนา |
| `hosted-ephemeral` | Hosting ไม่มี Persistent mount และไฟล์อาจหายหลัง Redeploy |
| `persistent-candidate` | `/var/data` เขียนได้ แต่ต้อง Controlled restart ก่อนถือว่า Verified |

Fixed mapping:

| Database | Backup |
|---|---|
| นอก `/var/data/` | `./data/backups` |
| ใต้ `/var/data/` | `/var/data/backups` |

Backup มีสูงสุด 7 Slot, Threshold incident, Fast retry จำกัด และ Recovery lifecycle

## Health และ Status

- `GET /healthz` เปิดสาธารณะและตอบเฉพาะ `{ ok }`
- Worker ตอบ Ready หลัง Restore และ Supervisor พร้อมจริงเท่านั้น
- HTTP `/api/status` ปิดเมื่อไม่มี `HEALTH_STATUS_TOKEN`
- Protected status แสดง Process role/active leases, Storage, Backup, Runner และ Quest API
- Slash `/api-status` แสดง API v10, Queue, 429, Durable states, Recovering และ Stopping
- Status ไม่แสดง Token, Webhook URL, Full database path หรือ Backup directory

## คำสั่งและสิทธิ์

| คำสั่ง | หน้าที่ | สิทธิ์ |
|---|---|---|
| `/panel` | แผง One-shot: `START NOW` และ `STOP ALL` | Action ตรวจ Manager |
| `/run` | เริ่ม Auto Daily | Owner/Admin/Manager |
| `/stop` | เลือกหยุด Auto Daily | เจ้าของ Runner |
| `/api-status` | สถานะระบบหลังบ้าน | Owner/Admin/Manager |
| `/ping` | ตรวจว่า Bot ออนไลน์ | ทั่วไป |
| `/help` | แสดงคำสั่ง | ทั่วไป |

Interaction ที่มีข้อมูลส่วนตัวตอบแบบ Ephemeral

## One-shot และ Auto Daily

One-shot รับหนึ่ง Token ต่อหนึ่งบรรทัด ทำ Quest ที่รองรับ และหยุดเมื่อไม่มี Quest หรือถูก Stop

Auto Daily:

1. ตรวจ Token และบัญชี
2. เข้ารหัส Token ก่อนบันทึก SQLite
3. ตรวจ Quest ทันที
4. ตรวจตามเวลา 00:00 / 08:00 / 16:00 ตาม `TIMEZONE`
5. Recheck ตาม Policy
6. Restore หลัง Restart
7. ใน Split mode Worker รับงานผ่าน SQLite

รองรับสูงสุด 10 Runner ต่อ Owner โดยนับ Local jobs, Persisted rows และงานที่กำลัง Cleanup การ Admission ถูก Serialize ป้องกัน Race condition

## Stop lifecycle

Local job อยู่สถานะกำลังหยุดจน `job.done` จบจริง

Split mode:

1. Control ลบ Scheduled row และตั้ง Durable state เป็น `STOPPING`
2. Worker Supervisor พบ row หายแล้ว Abort job
3. เมื่อทั้ง row และ Worker job หาย Durable state เปลี่ยนเป็น `STOPPED`
4. `/stop` รายงาน Pending หากยังไม่ได้รับ Terminal confirmation ภายในเวลารอ

บัญชีเดิมจึงไม่ถูกประกาศว่าหยุดเสร็จก่อน Cleanup จริง

## การยืนยันผล Quest

ระบบไม่ถือว่า POST สำเร็จเพียงเพราะส่ง Request ได้:

- Progress ต้องดึง State ใหม่และเห็นค่าจาก Discord
- Quest เสร็จเมื่อเห็น `completed_at`
- Claim สำเร็จเมื่อเห็น `claimed_at`

Enroll, Claim, Video Progress และ Heartbeat ใช้ Verified mutation retry โดยตรวจ Fresh state ก่อนส่งซ้ำ และไม่ Retry HTTP 4xx แบบแน่นอน

## ตรวจคุณภาพ

รันจากโฟลเดอร์ `bot`:

```bash
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```

CI ตรวจ Repository safety, Fixture, Backup paths, Architecture boundaries, Bootstrap, Topology, Worker REST/readiness, Durable state, Fault injection, Coverage, Syntax และ Production dependency audit

`npm run smoke:quest` เป็น Read-only: ตรวจบัญชีและอ่านรายการ Quest เท่านั้น ไม่ Enroll, Progress, Heartbeat หรือ Claim

## Production และ Rollback

ก่อน Merge/Deploy ต้องทำตาม [`PRODUCTION-CHECKLIST.md`](PRODUCTION-CHECKLIST.md):

- CI/Snyk/Codacy/SonarCloud/CodeRabbit ต้องเป็นของ HEAD ล่าสุด
- ไม่มี Review thread ที่ยังใช้ได้ค้าง
- Restart แล้ว Database, Backup และ Scheduled Runner ยังอยู่
- Split mode ต้องทดสอบ Control/Worker กับ Database เดียวกันจริง
- เก็บ Commit SHA และ Backup สำหรับ Rollback

> **คำเตือน:** การทำงานอัตโนมัติด้วยข้อมูลรับรองของบัญชีผู้ใช้มีความเสี่ยงด้านบัญชีและข้อกำหนดของแพลตฟอร์ม Unit Test และ CI ไม่สามารถทำให้ความเสี่ยงนี้หายไป ผู้ดูแลต้องตรวจสอบกฎปัจจุบันและยอมรับความเสี่ยงก่อนใช้งานจริง

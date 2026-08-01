# Quest Engine V2

เอกสารนี้อธิบายชั้นระบบที่เพิ่มขึ้นโดยไม่เปลี่ยน UX ของ `/panel`, `/run` และ `/stop`

## เป้าหมาย

- บังคับ HTTP API ของ Discord เป็น v10
- ประสาน Rate limit รวมหลายบัญชีโดยไม่เก็บ Token ใน Queue state
- เก็บ Runner checkpoint ลง SQLite เพื่อให้ตรวจสอบและกู้คืนหลัง Restart ได้
- ปลุก Scheduled Runner ก่อนรอบ 00:00 / 08:00 / 16:00 เมื่อ Quest มี Deadline หรือ Enrollment เปิดก่อน
- รองรับทั้ง All-in-one และการแยก Discord Control plane ออกจาก Scheduled Worker
- แยกความรับผิดชอบออกจาก `discord-runner.js` แบบค่อยเป็นค่อยไป โดยรักษา Export และพฤติกรรมเดิม

## โครงสร้าง

```text
src/
├─ process-topology.js               Lease ป้องกัน Process role ซ้ำหรือชนกัน
├─ worker-app.js                     Scheduled Worker แบบไม่มี Discord Gateway
└─ quest/
   ├─ discord-api-runtime.js         บังคับ v10 และติดตั้ง Transport
   ├─ rate-limit-coordinator.js      Queue ต่อบัญชี/Route/Bucket และ Global 429
   ├─ executors.js                   Registry ของ Video/Desktop/Unsupported
   ├─ smart-scheduler.js             เลือกเวลาจาก Claim, Deadline, Enrollment และ Retry
   ├─ schedule-hint-bus.js           ส่ง Wake-up hint ด้วย Authorization fingerprint
   ├─ smart-wake-controller.js       ปลุกเฉพาะ Scheduled Runner ที่กำลังหลับ
   ├─ runner-state-store.js          Durable state machine ใน SQLite
   ├─ runner-state-observer.js       แปลง Live Runner เป็น Checkpoint
   ├─ runner-completion-observer.js  ปิด Lifecycle โดยไม่เดาผล Completion
   ├─ scheduled-restore.js           ถอด Token และกู้ Scheduled rows
   ├─ scheduled-worker-supervisor.js Reconcile SQLite rows กับ Worker jobs
   ├─ worker-discord-client.js       ส่งสถานะด้วย Discord REST โดยไม่เปิด Gateway
   └─ runner-service.js              Facade สำหรับ Start/Restore/Stop/Delegate
```

## API v10

`discord-api-runtime.js` ครอบ `globalThis.fetch` เฉพาะ URL ที่ขึ้นต้นด้วย `https://discord.com/api/v*` แล้วเปลี่ยน Version เป็น v10 ก่อนส่งจริง URL อื่น เช่น Webhook หรือบริการภายนอกจะไม่ถูกเปลี่ยน

Engine เดิมยังประกอบ URL v9 อยู่เพื่อรักษา Diff ให้เล็ก แต่ Outbound Request ของ Runtime จะผ่าน Wrapper ก่อนส่งจริง การส่งด้วย `Request` object รักษา Method, Headers และ Body เดิมสำหรับทั้ง Coordinator และ Transport

Worker REST client เลือก `globalThis.fetch` ตอนส่ง Request จริง ไม่จับ Transport เก่าตั้งแต่ตอนสร้าง Client จึงผ่าน v10 wrapper และ Rate-limit coordinator เหมือน Engine หลัก

## Global Rate-limit Coordinator

Coordinator ใช้ SHA-256 fingerprint 16 ตัวจาก Authorization เพื่อแยกบัญชี โดยไม่เก็บ Token ใน Queue metadata

กฎหลัก:

- บัญชีเดียวกันมี Request ทำงานพร้อมกันได้สูงสุด 1 รายการ
- หลายบัญชีทำงานพร้อมกันได้ตาม Global concurrency
- จดจำ `X-RateLimit-Bucket`
- เคารพ `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`, `Retry-After`
- เมื่อได้รับ Global 429 จะหยุด Queue ทั้งหมดจนถึงเวลาที่กำหนด
- Timer ของ Queue คำนวณ Bucket ที่ปลดเร็วที่สุดใหม่ทุกครั้ง
- Claim และ Verification มี Priority สูงกว่า Background requests
- Bookkeeping และ Schedule hint ล้มได้โดยไม่ทำให้ Promise ของ Caller ค้าง

## Durable Runner State

ตาราง `runner_states` เก็บ:

- `job_key`, Owner, Account, Mode และ Schedule ID
- State ปัจจุบัน
- Quest ID/ชื่อ/Progress ที่สังเกตล่าสุด
- `next_action_at`, Retry count และ Error ล่าสุด
- Metadata ที่ไม่มี Token

State สำคัญ:

```text
QUEUED → AUTHENTICATING → RUNNING
RUNNING → ENROLLING → RUNNING_PROGRESS → VERIFYING_COMPLETION → CLAIMING
RUNNING → WAITING_RETRY | WAITING_ENROLLMENT | WAITING_SCHEDULE
ทุก State → STOPPING → STOPPED
ทุก State → FAILED
Scheduled ที่ Process หยุดกลางงาน → RECOVERING
One-shot ที่ Process หยุดกลางงาน → FAILED เพราะไม่มี Token สำหรับ Restore
```

Partial transition รักษา Quest ID, ชื่อ, Progress, เวลารอบถัดไป, Retry, Error และ Metadata เดิม เว้นแต่ Caller ส่งค่าใหม่หรือส่ง `null` เพื่อเคลียร์โดยชัดเจน

Observer แยก Error ต่อ Job จึงไม่ปิดบอททั้ง Process เมื่อ Checkpoint รายการเดียวเขียนไม่สำเร็จ และไม่ลด State ของ Smart wake กลับเป็น `WAITING_SCHEDULE` ระหว่าง Poll

## Scheduled Restore

`scheduled-restore.js` ทำงานดังนี้:

1. จับคู่ Durable state กับ Scheduled row
2. ปิด Orphaned `RECOVERING` state เป็น `FAILED`
3. ตรวจ `RUNNER_TOKEN_SECRET`
4. จำกัดสูงสุด 10 Runner ต่อ Owner
5. ป้องกัน Account ID เดียวกัน Restore ซ้ำ
6. ไม่ถือว่าแถวที่ Account ID ยังไม่ Resolve เป็นบัญชีเดียวกัน
7. ถอด Token แล้วเรียก Runner service
8. เขียน Error ลงทั้ง Scheduled row และ Durable state เมื่อ Restore ล้มเหลว

## Smart Scheduler และ Smart Wake

Response ของ Quest list ถูกอ่านผ่าน `response.clone()` จึงไม่แย่ง Body จาก Engine เดิม ระบบสร้าง Hint จาก:

1. Completed แต่ยังไม่ Claim
2. Quest ที่ยังไม่หมดอายุและเหลือเวลาน้อยกว่า 30 นาที
3. Verification/Retry ถึงเวลา
4. Enrollment block หมด
5. Quest เริ่มได้
6. รอบตรวจพื้นฐาน

Quest ที่หมดอายุแล้วจะไม่สร้าง Deadline hint ใหม่

เมื่อ Hint เร็วกว่ารอบที่ Runner กำลังรอ และ Runner อยู่ในสถานะหลับ (`AUTO DAILY ACTIVE` หรือ `NEXT CHECK`) Smart wake controller จะ:

1. หยุด Job โดยไม่ลบ Scheduled row
2. รอ Cleanup เดิมจบ
3. เริ่ม Job เดิมใหม่ทันที
4. Fetch สถานะ Quest สดจาก Discord ก่อน Mutation ตามกลไกเดิม

ระบบไม่ปลุก Runner กลางการส่ง Progress เพื่อหลีกเลี่ยงการตัด Mutation ที่กำลัง Verify

## Process Topology

`QUEST_PROCESS_ROLE` รองรับสามค่า:

| Role | หน้าที่ |
|---|---|
| `all` | ค่าเริ่มต้น: Discord Gateway, Commands, One-shot และ Auto Daily ใน Process เดียว |
| `control` | Discord Gateway, Commands และ One-shot; Scheduled rows ถูก Delegate ผ่าน SQLite |
| `worker` | Auto Daily เท่านั้น ใช้ Discord REST client และไม่เปิด Gateway |

กฎ Lease:

- `control` และ `worker` ทำงานร่วมกันได้
- Process Role เดียวกันซ้ำด้วย Holder คนละตัวไม่ได้
- `all` ห้ามทำงานพร้อม `control` หรือ `worker`
- Lease หมดอายุเมื่อ Process ไม่ Renew เพื่อไม่ล็อกระบบถาวรหลัง Crash

ข้อกำหนด Split mode:

- Control และ Worker ต้องเห็น `DATABASE_PATH` เดียวกันจริง
- ต้องใช้ `RUNNER_TOKEN_SECRET` เดียวกัน
- ต้องใช้ Port คนละค่าเมื่ออยู่ Host เดียวกัน
- SQLite ต้องอยู่บน Filesystem ที่ทั้งสอง Process เข้าถึงได้อย่างน่าเชื่อถือ
- Deployment ที่แต่ละ Service มี Local disk แยกกันต้องใช้ `all` หรือเปลี่ยน Durable store เป็น Shared network database ก่อน

One-shot อยู่ใน Control process และไม่ Persist Token เพิ่ม ส่วน Scheduled token ยังคงเข้ารหัสใน `scheduled_runners`

## Worker Supervisor

Supervisor Poll ตาม `QUEST_WORKER_POLL_MS` และ Reconcile ดังนี้:

- Scheduled row ใหม่แต่ยังไม่มี Job → ถอด Tokenและ Start
- Job ที่ Scheduled row ถูกลบ → Abort โดยไม่สร้าง row กลับ
- Failed row → Retry หลัง Cooldown 5 นาที
- Durable `STOPPING` ที่ไม่มีทั้ง row และ Job → เปลี่ยนเป็น `STOPPED`
- Stop จาก Control จึงรายงาน Cleanup เสร็จเมื่อ Worker ยืนยัน Terminal state ไม่ใช่ทันทีที่ลบ row

Worker Health readiness เป็น `false` ระหว่าง Bootstrap/Shutdown และเป็น `true` หลัง Restore กับ Supervisor เริ่มสำเร็จเท่านั้น

## Compatibility

- Panel เดิมไม่เปลี่ยน
- `/run`, `/stop`, `/api-status` ใช้ Runner service
- `discord-runner.js` ยังเป็น Legacy engine ภายในหลัง Service facade
- Executor registry เป็น Contract แยกสำหรับ Video/Desktop/Unsupported โดย Engine เดิมยังรักษา Execution behavior เดิม
- ค่าเริ่มต้น `all` ทำงานเหมือน Deployment เดิม

## Validation

Test ครอบคลุม:

- v9 URL ถูกส่งจริงเป็น v10
- `Request` แบบ POST รักษา Method ถึง Coordinator และ Transport
- URL ภายนอกไม่ถูก Rewrite
- บัญชีเดียวไม่ยิง Request พร้อมกัน
- Global 429 หยุด Queue
- Queue เปลี่ยน Timer ไปยัง Bucket ที่ปลดเร็วกว่า
- Caller ได้ Response แม้ Rate-limit bookkeeping ล้ม
- Quest response สร้าง Hint โดยไม่กิน Body ของ Engine
- Durable state, Partial transition และ Restart reconciliation
- Observer รักษา Smart-wake state และแยก Error ต่อ Job
- Scheduled Restore, Orphan reconciliation และหลายแถวที่ Account ID ยังไม่ Resolve
- Deadline/Enrollment/Claim priority และ Expired Quest
- Mutation response หาย, Controlled retry และ Abort
- Executor registry และ Service boundary
- All/Control/Worker topology leases
- Worker ไม่มี Gateway และใช้ REST v10
- Worker readiness lifecycle
- Supervisor Start/Stop/Retry reconciliation
- Cross-process STOPPING → STOPPED confirmation
- Bootstrap handlers อยู่ก่อน Role-aware Runtime import

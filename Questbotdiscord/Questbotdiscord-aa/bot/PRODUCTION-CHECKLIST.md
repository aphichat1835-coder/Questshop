# Production Readiness Checklist

เอกสารนี้ใช้ตรวจรับ Pull Request หรือกิ่ง Release ก่อน Merge หรือ Deploy ระบบ NeverDie Quest Bot

> Automated CI ผ่านไม่เท่ากับ Discord UAT, Persistent storage UAT หรือ Multi-worker failover ผ่าน

## 1. ขอบเขตที่ต้องไม่เปลี่ยน

- [ ] Repository ยังเป็น Bot-only
- [ ] Panel มีเพียง `START NOW` และ `STOP ALL`
- [ ] Runner สูงสุด 10 บัญชีต่อ Owner
- [ ] One-shot ไม่ Persist token เพิ่ม
- [ ] Auto Daily ใช้รอบตาม Timezone ที่กำหนด
- [ ] Discord HTTP API ใช้ v10 โดยตรง
- [ ] Production lifecycle ผ่าน `quest/runner-service.js`
- [ ] ไม่มี Control Panel V2
- [ ] ไม่มี Persistent analytics/history เพิ่ม
- [ ] ไม่มี Encryption key rotation
- [ ] ไม่มี Blind retry Mutation
- [x] PR ยังคง Draft

## 2. Environment และ Secrets

ค่าหลัก:

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OWNER_ID=
RUNNER_TOKEN_SECRET=
LOG_WEBHOOK_URL=
```

ค่า Optional:

```env
MANAGER_ROLE_ID=
LOG_CHANNEL_ID=
TIMEZONE=Asia/Bangkok
DISCORD_TIMEZONE=Asia/Bangkok
DISCORD_LOCALE=en-US
DATABASE_PATH=
DATABASE_BACKUP_ENABLED=
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=
PORT=
QUEST_PROCESS_ROLE=all
QUEST_WORKER_POLL_MS=5000
```

ตรวจว่า:

- [ ] `RUNNER_TOKEN_SECRET` ยาวอย่างน้อย 16 ตัวอักษรและไม่ถูก Commit
- [ ] `LOG_WEBHOOK_URL` เป็น Webhook ส่วนตัว
- [ ] `HEALTH_STATUS_TOKEN` เป็น Secret คนละค่ากับ Token อื่น
- [ ] `QUEST_PROCESS_ROLE` รับเฉพาะ `all`, `control`, `worker`
- [ ] `QUEST_WORKER_POLL_MS` อยู่ระหว่าง 1000–60000 ms
- [ ] Runtime ไม่เขียน `DATABASE_PATH` กลับ Environment
- [ ] ไม่มี `DATABASE_BACKUP_DIR`
- [ ] Client/Chrome/Electron/Build profile อัปเดตเป็นชุดเดียวกัน
- [ ] `MANAGER_ROLE_ID` ให้สิทธิ์ `/run`, `/panel`, `/api-status`; `/stop` ยังคง Owner-only

## 3. Process topology

### All-in-one

- [ ] `QUEST_PROCESS_ROLE=all`
- [ ] ไม่ทำงานพร้อม Control หรือ Worker
- [ ] Scheduled runner ที่เข้า `WAITING_RETRY` ถูกปลุกโดย `all-mode-recovery.js`
- [ ] Restore Throw หรือ `restored <= 0` ถูก Rearm ด้วย Backoff
- [ ] Retry deadline ใหม่ Persist ก่อนตั้ง Timer
- [ ] Recovery timer ไม่เก็บ Raw user token

### Split Control + Workers

- [ ] Control และ Workers ใช้ `DATABASE_PATH` เดียวกันจริง
- [ ] ทุก Process ใช้ `RUNNER_TOKEN_SECRET` เดียวกัน
- [ ] HTTP process ใช้ Port ไม่ซ้ำ
- [ ] One-shot อยู่ Control และไม่ Delegate
- [ ] Worker ใช้ REST v10 และไม่ Login Gateway
- [ ] Scheduled row ถูก Worker รับภายใน Poll interval
- [ ] Worker Initial reconcile ต้องสำเร็จก่อนประกาศ Ready
- [ ] Worker แต่ละตัวมี Holder จาก PID + UUID
- [ ] Worker หลาย Holder ทำงานพร้อมกันได้
- [ ] Scheduled row มี Active claim หนึ่ง Holder
- [ ] Worker เสีย Claim แล้ว Abort local runner
- [ ] Worker อื่น Takeover ได้หลัง Claim หมดอายุ
- [ ] SQLite `busy_timeout` เป็น 5000 ms
- [ ] Schema migration, Runtime lease และ Scheduled claim acquisition Serialize ด้วย Immediate transaction
- [ ] Detached `STOPPING` มากกว่า 500 แถวถูก Finalize ครบ
- [ ] ไม่ใช้ Local disk แยกกันเป็น Shared topology

## 4. Bootstrap, Completion และ Shutdown

- [ ] Bootstrap handlers ติดตั้งก่อน Dynamic import
- [ ] Config/Module import failure รายงานได้โดยไม่พึ่ง SQLite/Discord Client
- [ ] Repeated fatal bootstrap ถูก Redact และยังคงมี Evidence ใน Log
- [ ] Entrypoint เลือก App ตาม Process role
- [ ] Database open/migration failure ใช้ Incident code ถูกต้อง
- [ ] Runtime lease conflict/lost ทำให้ Process ปิดอย่างปลอดภัย
- [ ] Dashboard bind failure Reject startup
- [ ] Login failureส่ง Incident แล้ว Shutdown
- [ ] Fatal/Shutdown promise ไม่ทำงานซ้อน
- [ ] Worker Mark not-ready ก่อน Shutdown
- [ ] Worker หยุด Supervisor ก่อนรับงานใหม่
- [ ] Abort runners และรอ `job.done` ก่อนปล่อย Claims
- [ ] Execution context Release ทั้ง Resolve และ Reject
- [ ] Completion observer ไม่มี Derived `unhandledRejection`
- [ ] Release callback/reporting failure ถูก Contain
- [ ] Stop/Shutdown ยกเลิก Smart Wake และ All-mode timers
- [ ] Cleanup ขั้นหลังยังทำต่อแม้ขั้นก่อนหน้า Throw
- [ ] Dashboard และ Database ปิดตามลำดับ

## 5. Quest API boundary

- [ ] ใช้ `https://discord.com/api/v10`
- [ ] URL ภายนอกและ Webhook ไม่ถูก Rewrite
- [ ] Path ปฏิเสธ Authority, Query, Fragment, Backslash และ Traversal
- [ ] External Quest ID ถูก Encode เป็น segment เดียว
- [ ] Quest list ตรวจทั้งสอง Endpoint
- [ ] Endpoint แรกคืนว่างไม่ถูกสรุปทันทีว่าไม่มี Quest
- [ ] Fatal 401 จาก Endpoint ถัดไปไม่ถูก Empty candidate กลบ
- [ ] POST Mutation ไม่ Generic retry
- [ ] Abort ไม่กลายเป็น Compatibility error
- [ ] Fatal auth ถูกจัดประเภทถูกต้อง
- [ ] Video timestamp เป็นจำนวนเต็มไม่ติดลบ
- [ ] Response ปกติไม่ถูก Clone/Parse เพื่อหา Rate limit
- [ ] Fetch wrapper คืน Promise rejection แทน Synchronous throw
- [ ] Streaming Request body และ `duplex` ยังอยู่หลัง URL rewrite

## 6. Schema และ Executor

Target:

- [ ] Numeric string ที่ถูกต้องรับได้
- [ ] Target ต้อง Finite และมากกว่า 0
- [ ] Missing, 0, negative, `NaN`, `Infinity` → `TASK_TARGET_INVALID`

Progress:

- [ ] Numeric string ที่ถูกต้องรับได้
- [ ] Progress ต้อง Finite และไม่ติดลบ
- [ ] Invalid/negative/Infinity → `TASK_PROGRESS_INVALID`
- [ ] `progressSecs=null` หรือ `''` fallback ไป Raw progress
- [ ] Progress มากกว่า Target → Percent Clamp 100
- [ ] ไม่มี `NaN` เข้า Executor, Database หรือ Status

Quest ID และ Compatibility:

- [ ] Numeric Quest ID ถูก Normalize เป็น String
- [ ] ชื่อ Quest ไม่เก็บ Percent suffix หรือ Separator ท้ายชื่อ
- [ ] `TASK_DEFINITIONS_MISSING`, `TASK_TARGET_INVALID`, `TASK_PROGRESS_INVALID`, `MULTI_TASK_AND` เป็น Blocking
- [ ] Blocking Quest ไม่ถูกนับใน `supportedCount`
- [ ] Blocking Quest ไม่เข้าสู่ One-shot session
- [ ] Blocking Quest ไม่ส่ง Enroll, Progress, Heartbeat หรือ Claim
- [ ] Unsupported diagnostics รายงาน Compatibility code จริง

Executor ทุกตัวมี:

- [ ] `matches`
- [ ] `validate`
- [ ] `estimateDuration`
- [ ] `execute`
- [ ] `verify`
- [ ] `describeUnsupportedReason`

## 7. Durable state และ Mutation checkpoint

Scheduled runner Persist:

- [ ] State และ `state_source`
- [ ] Quest ID/name/event
- [ ] Progress และ Server progress seconds
- [ ] `next_action_at`, Retry count
- [ ] Error category และ Last error
- [ ] Mutation kind/status/payload แบบ Sanitized
- [ ] Attempted/verified timestamps
- [ ] Metadata และ Checkpoint version

Mutation lifecycle:

```text
PREPARED → IN_FLIGHT → ACCEPTED/UNCERTAIN → VERIFIED
```

ตรวจว่า:

- [ ] `PREPARED` ก่อน Request
- [ ] `IN_FLIGHT` ก่อน Network execute
- [ ] Ownership ตรวจก่อน Queue และก่อน Execute
- [ ] Checkpoint write failure หยุด Mutation
- [ ] Payload ไม่มี Token, Cookie, CAPTCHA, Webhook หรือ Full response
- [ ] Active checkpoint เขียนทับด้วย Mutation ใหม่ไม่ได้
- [ ] Fresh verification ต้องจบก่อนปลด Barrier
- [ ] Server-confirmed Mutation ไม่ถูกลดเป็น FAILED เมื่อ Persist VERIFIED ล้ม
- [ ] `PREPARED` ไม่มี Mutation kind เกิดไม่ได้
- [ ] Generic programming Error ไม่ถูกจัดเป็น Network retry

## 8. Recovery และ Stop

- [ ] Scheduled interruption → Recovery plan
- [ ] One-shot interruption → `FAILED`
- [ ] Future waiting state → รอตาม `next_action_at`
- [ ] `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` → Verify ก่อน Resend
- [ ] `VERIFYING_*` → Verification ต่อ
- [ ] Transient recovery fetch ถูก Defer เข้า Normal loop
- [ ] Abort และ Fatal auth ระหว่าง Recovery ยังเป็น Terminal ตาม Policy
- [ ] Recovery plan ต้องรักษา Diagnostic metadata เดิม
- [ ] Claim retry ไม่ปลุก Terminal runner
- [ ] Restore Throw → Report + Rearm
- [ ] Restore summary `restored <= 0` → Failure + Rearm
- [ ] Active schedule + Terminal checkpoint → Fresh start
- [ ] Start สำเร็จแต่ Durable bookkeeping ล้ม → Abort/rollback โดยไม่ลบ Schedule
- [ ] Control stop ใช้ `STOPPING` เมื่อ Worker อาจยังทำงาน
- [ ] Detached STOPPING → STOPPED เมื่อ Row/Job หายจริง

## 9. Scheduler และ Smart Wake

- [ ] Hint แยกตาม Source
- [ ] `expiresAt` ต่ออายุ Stored hint ได้
- [ ] Effective hint เป็น `baseline` → ล้าง Timer
- [ ] Effective hint เป็น `null` → ล้าง Timer
- [ ] Invalid `nextActionAt` → ล้าง Timer
- [ ] Urgent hint ใหม่แทน hint เก่าได้
- [ ] Fixed schedule ที่เร็วกว่า Hint ไม่ถูกปลุกซ้ำ
- [ ] Stop denied → ล้าง Attempt และไม่ Restart
- [ ] Replacement job → ไม่ Restart ทับ
- [ ] Scheduled row ถูกลบ → ยกเลิก Wake
- [ ] Timer ระยะไกลแบ่งช่วงไม่เกิน 24 ชั่วโมง

## 10. Durable state authority

Status observer อนุญาต:

- [ ] `NETWORK RETRY` → `WAITING_RETRY`
- [ ] `NEXT CHECK`/`AUTO DAILY ACTIVE` → `WAITING_SCHEDULE`

Status observer ห้ามเขียนทับ:

- [ ] Active mutation checkpoint
- [ ] `WAITING_ENROLLMENT`
- [ ] `WAITING_RATE_LIMIT`
- [ ] State จาก `schedule-hint:*`
- [ ] `STOPPING`, `STOPPED`, `COMPLETED`, `FAILED`

Terminal status ที่สังเกตได้ต้องชนะ Waiting state ที่ยังไม่ Terminal

## 11. Rate limit และ Circuit breaker

- [ ] บัญชีเดียวไม่ยิงพร้อมกันเกินหนึ่ง Request
- [ ] รองรับ Scope `user`, `shared`, `global`
- [ ] อ่าน Header และ JSON `retry_after`
- [ ] Server delay มากกว่า 60 วินาทีถูกเคารพเต็มจำนวน
- [ ] Response ปกติไม่เข้า Retry parsing path
- [ ] Global 429 หยุด Queue ทั้งหมดและ Persist `next_action_at` ที่ตรงกับ Server delay
- [ ] 429 หนึ่ง Response ไม่บันทึก Bucket reset ซ้ำ
- [ ] Reset ใหม่ที่สั้นกว่าไม่ลด Existing block deadline
- [ ] Route-to-bucket และ Scope remapping ย้าย Reset/Circuit state โดยไม่ทิ้ง State เก่า
- [ ] Authorization เป็น Fingerprint ไม่ใช่ Raw token
- [ ] Circuit มี `CLOSED`, `OPEN`, `HALF_OPEN`
- [ ] Mutation ถูก Block จน Fresh verification
- [ ] Bookkeeping failure ไม่ข้าม Circuit accounting
- [ ] Missing execution context/ownership ทำ Mutation ต่อไม่ได้
- [ ] Request ที่อยู่ใน Queue ถูก Abort ทันทีโดยไม่รอ Retry timer

## 12. Storage, Backup และ Incident

- [ ] Storage mode รายงานตามจริง
- [ ] Backup path อยู่เฉพาะ Fixed local/persistent roots
- [ ] Retention ไม่เกิน 7 Slot
- [ ] Backup failure threshold เปิด Incident หนึ่งรายการ
- [ ] Failure ใหม่ระหว่าง Pending recovery ไม่ล้าง Incident lifecycle เดิม
- [ ] Recovery ใช้ Incident ID เดิม
- [ ] Original alert ที่ส่งไม่สำเร็จไม่ส่ง Recovery แบบหลอก
- [ ] Incident ที่เกิดซ้ำระหว่าง Recovery ยังคง Open
- [ ] Incident ไม่ Spam Webhook
- [ ] Payload ปิด Mentions
- [ ] Context ใช้ Allowlist
- [ ] Embed รวมไม่เกิน Discord 6000-character budget
- [ ] Token, Webhook, CAPTCHA, Password, API/private/encryption/access/signing key ถูก Redact
- [ ] Explicit `emergency:false` เป็น Log-only
- [ ] `/api/status` ไม่แสดง Full path หรือ Secret
- [ ] Controlled restart แล้วยังพบ Database, Backup และ Scheduled rows

## 13. Automated quality gates

รันจากโฟลเดอร์ `bot`:

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
npm run validate:quest-fixture
npm test
npm run test:coverage
npm run test:mutation-safety
npm run check
npm audit --omit=dev --audit-level=high
git diff --exit-code
```

Validated implementation evidence จาก commit `50a11b5008b37ce82f85026df009c9dac098da85` และ CI #1748/#1749 ก่อน Final documentation sync:

- [x] Repository shape
- [x] Sanitized Quest fixture
- [x] Fixed backup destinations
- [x] Incident/Storage boundaries
- [x] 462/462 tests
- [x] 0 failed/cancelled/skipped/todo
- [x] Coverage 93.78% lines / 85.25% branches / 89.28% functions
- [x] LCOV generated 393,224 bytes
- [x] Mutation baseline ผ่าน
- [x] Critical mutation groups 14/14, 15/15 และ 26/26 ถูก Kill
- [x] Dedicated recovery metadata mutation ถูก Kill
- [x] Mutation source restoration
- [x] JS/MJS/Bash syntax
- [x] Production dependency audit ระดับ High

Mutation gate ครอบคลุม:

1. Fresh verification หลัง Uncertain mutation
2. Deadline ordering
3. Recovery checkpoint
4. Executor compatibility
5. Durable update enforcement
6. User-scoped bucket
7. Target validation
8. Progress validation
9. Baseline wake cleanup
10. Rejected completion release
11. All-mode state eligibility
12. Observer wait priority
13. Video timestamp validation
14. Completion observer containment
15. Completion release reporter containment
16. Terminal claim retry guard
17. Unsupported reason precedence
18. All-mode restore rearm
19. Empty restore summary
20. Hint expiry refresh
21. Header Retry-After duration
22. Body retry_after duration
23. Normal response parsing guard
24. Terminal observer precedence
25. Smart Wake denied-attempt cleanup
26. Quest ID normalization
27. Recovery metadata preservation

## 14. External gates

บน Final HEAD เดียวกันต้องตรวจ:

- [ ] Snyk status Success
- [ ] CodeRabbit commit status Success
- [ ] Current review threads ถูก Resolve ครบหลังตรวจ Source จริง
- [ ] Codacy: Up to standards / 0 new issues
- [ ] CodeFactor current-head result
- [ ] SonarCloud: Quality Gate passed, Security Rating A, 0 New issues และ Coverage ถูก Import

CI-based Sonar จะถูก Skip หาก Repository ไม่มี `SONAR_TOKEN`

## 15. Controlled functional UAT

ใช้ Server และบัญชีทดสอบ:

- [ ] Permission ของ `/api-status`
- [ ] Start พร้อมกันไม่เกิน 10 Runner
- [ ] Stop ระหว่างทำงานและรอ Terminal จริง
- [ ] Auto Daily Restart/Restore
- [ ] All-mode transient recovery โดยไม่ Restart Process
- [ ] Restore summary `restored: 0`
- [ ] Enroll lifecycle
- [ ] Video progress พร้อม Response loss
- [ ] Desktop heartbeat พร้อม Worker claim loss
- [ ] Claim reward พร้อม Durable cooldown
- [ ] CAPTCHA และ Non-CAPTCHA HTTP 400
- [ ] HTTP 429 ที่ Retry-After มากกว่า 60 วินาที
- [ ] Restart ที่ `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, `VERIFIED`
- [ ] ไม่มี Blind duplicate mutation
- [ ] Worker claim conflict และ Takeover
- [ ] Worker shutdown fault injection
- [ ] Persistent storage restart/redeploy
- [ ] Backup failure → Pending recovery → Re-failure → Successful recovery
- [ ] Token invalid ขณะ Waiting
- [ ] Claim callback หลัง Runner Terminal
- [ ] Panel ยังมีเพียง `START NOW / STOP ALL`

## 16. Rollback

ก่อน Deploy:

- [ ] บันทึก Commit SHA
- [ ] ตรวจ Backup ล่าสุดเปิดอ่านได้
- [ ] เก็บ Environment เดิมอย่างปลอดภัย
- [ ] Split mode ใช้ SHA เดียวกันทุก Process

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. Mark Workers not-ready
3. หยุด Control/Workers
4. Rollback ทุก Process ไป SHA เดียวกัน
5. Restore Database เฉพาะเมื่อยืนยัน Data/Schema เสีย
6. หมุน Secret หากสงสัยว่ารั่ว
7. เพิ่ม Regression test ก่อน Deploy ใหม่

## 17. เกณฑ์อนุมัติ

Production อนุมัติได้เมื่อ:

- [ ] CI ของ HEAD ล่าสุดผ่านทั้งหมด
- [ ] Snyk, Codacy, CodeFactor, SonarCloud และ CodeRabbit ตรวจบน HEAD เดียวกัน
- [ ] ไม่มี Current review thread ค้าง
- [ ] Persistent storage ผ่าน Controlled restart
- [ ] Discord Mutation UAT ผ่าน
- [ ] Multi-worker Shared storage และ Failover UAT ผ่าน
- [ ] Backup/Incident/Recovery ผ่าน
- [ ] Rollback path ถูกยืนยัน
- [ ] เจ้าของอนุมัติ Explicitly

PR ต้องคง Draft และห้าม Merge, Deploy, Auto-merge หรือ Ready-for-review จนข้อกำหนดครบ

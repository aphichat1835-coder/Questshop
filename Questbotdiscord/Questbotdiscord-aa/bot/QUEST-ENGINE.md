# Quest Engine Architecture

เอกสารนี้อธิบายสถาปัตยกรรม Quest Engine บนกิ่ง `aa.1` หลัง Full-source correctness และ static-analysis audit ใช้เป็น Source of truth สำหรับ Review, UAT, Incident response และการพิจารณา Deploy

## 1. ขอบเขตที่ล็อกไว้

- ใช้ Discord HTTP API v10 โดยตรง
- Panel มีเพียง `START NOW` และ `STOP ALL`
- Production lifecycle ต้องผ่าน `quest/runner-service.js`
- One-shot token ไม่ถูก Persist เพิ่ม
- ไม่เพิ่ม Control Panel V2
- ไม่เพิ่ม Persistent analytics/history
- ไม่ทำ Encryption key rotation
- ไม่เพิ่มหรือเปลี่ยน Commands โดยไม่จำเป็น
- ห้าม Blind retry Mutation ก่อนตรวจ Fresh server state
- PR ต้องคง Draft จน External gates และ Controlled UAT ผ่าน

## 2. Module boundaries

```text
src/quest/
├─ api/
│  ├─ discord-client.js
│  └─ quest-endpoints.js
├─ schema/
│  ├─ compatibility.js
│  └─ normalizer.js
├─ executors/
│  ├─ contract.js
│  ├─ registry.js
│  ├─ video-executor.js
│  ├─ desktop-executor.js
│  └─ unsupported-executor.js
├─ all-mode-recovery.js
├─ claim-retry-policy.js
├─ discord-api-runtime.js
├─ durable-mutation-verifier.js
├─ rate-limit-coordinator.js
├─ recovery-fetch.js
├─ recovery-planner.js
├─ runner-completion-observer.js
├─ runner-completion-release.js
├─ runner-execution-context.js
├─ runner-ownership-guard.js
├─ runner-start-rollback.js
├─ runner-state-observer.js
├─ runner-state-store.js
├─ schedule-hint-bus.js
├─ scheduled-restore.js
├─ scheduled-worker-claims.js
├─ scheduled-worker-reconciler.js
├─ scheduled-worker-supervisor.js
├─ smart-scheduler.js
├─ smart-wake-controller.js
└─ worker-discord-client.js
```

`discord-runner.js` เป็น Orchestrator และ Presentation boundary ของระบบเดิม แต่ Production entrypoints, Commands, Restore และ Lifecycle ต้องผ่าน `quest/runner-service.js`

Source of truth:

- API base, headers, URL validation และ Discord errors → `quest/api/*`
- Schema parsing, ID normalization และ numeric validation → `quest/schema/*`
- Executor selection และ progress behavior → `quest/executors/*`
- Durable state และ mutation checkpoint → `quest/runner-state-store.js`
- Fresh verification → `quest/durable-mutation-verifier.js`
- Retry classification ของ Claim → `quest/claim-retry-policy.js`
- Queue, scoped rate limit, circuit และ mutation barrier → `quest/rate-limit-coordinator.js`
- All-in-one delayed recovery → `quest/all-mode-recovery.js`
- Transient durable recovery fetch policy → `quest/recovery-fetch.js`
- Post-start rollback → `quest/runner-start-rollback.js`
- Standalone Worker Discord REST output → `quest/worker-discord-client.js`
- Completion settlement → `quest/runner-completion-observer.js`
- Safe execution-context release → `quest/runner-completion-release.js`

## 3. API และ Schema boundary

API client ต้อง:

- ใช้ `https://discord.com/api/v10`
- ปฏิเสธ Authority, Query, Fragment, Backslash และ Path traversal
- Encode External Quest ID เป็น path segment เดียว
- ตรวจทั้ง `/quests/@me` และ `/users/@me/quests`
- ไม่สรุปว่า Quest หายจาก Endpoint แรกที่คืนรายการว่าง
- Fatal 401 ต้องชนะ Empty candidate จาก Endpoint ก่อนหน้า
- ไม่ Generic retry POST Mutation
- ส่ง Abort และ Fatal authentication ต่ออย่างถูกต้อง
- ส่ง Video progress timestamp เป็นจำนวนเต็มไม่ติดลบ

Schema normalizer ต้อง:

- รองรับ `task_config_v2` และ Legacy `task_config`
- แปลง Quest ID เป็น String ตั้งแต่ Schema boundary
- รองรับ Numeric string ที่ถูกต้อง
- Reject Target ที่ Missing, non-finite, 0 หรือติดลบ
- Reject Progress ที่ non-finite หรือติดลบ
- ไม่ปล่อย `NaN` หรือ `Infinity` เข้า Executor, State หรือ Status
- แยก Blocking compatibility issue ตามสาเหตุจริง

Blocking issues:

- `TASK_DEFINITIONS_MISSING`
- `TASK_TARGET_INVALID`
- `TASK_PROGRESS_INVALID`
- `MULTI_TASK_AND`

Quest ที่มี Blocking issue ยังคงปรากฏใน Diagnostics แต่ห้ามถูกนับเป็น Supported และห้ามส่ง Enroll, Progress, Heartbeat หรือ Claim

## 4. Executor contract

Executor ทุกตัวต้องมี:

```js
{
  id,
  matches,
  validate,
  estimateDuration,
  execute,
  verify,
  describeUnsupportedReason,
}
```

Registry:

- `video` — `WATCH_VIDEO*`
- `desktop` — `PLAY_ON_DESKTOP*`
- `unsupported` — Event หรือ Schema ที่ห้ามทำอัตโนมัติ
- `unknown` — Event ใหม่ที่ยังไม่มี Contract

Unsupported executor ต้องรายงาน `compatibilityIssues[0].code` ก่อน fallback เป็น `MULTI_TASK_AND` เพื่อไม่ซ่อนสาเหตุ Schema จริง

## 5. Durable state และ Mutation lifecycle

Scheduled runner เก็บใน SQLite:

- State และ `state_source`
- Quest ID/name/event
- Progress และ Server progress seconds
- `next_action_at`, Retry count, Last error และ Error category
- Mutation kind/status/payload แบบ Sanitized
- Mutation attempted/verified timestamps
- Metadata และ Checkpoint version

Mutation kind:

- `ENROLL`
- `VIDEO_PROGRESS`
- `HEARTBEAT`
- `CLAIM`

Mutation status:

- `NONE`
- `PREPARED`
- `IN_FLIGHT`
- `ACCEPTED`
- `UNCERTAIN`
- `VERIFIED`
- `FAILED`

ลำดับบังคับ:

1. ตรวจ Worker ownership
2. Persist `PREPARED`
3. Persist `IN_FLIGHT`
4. ตรวจ Ownership ซ้ำก่อน Network execute
5. ส่ง Mutation
6. บันทึก `ACCEPTED`, `UNCERTAIN` หรือ `FAILED`
7. Block Mutation ถัดไปของ `jobKey` เดิม
8. Fetch Quest state ใหม่
9. Await Fresh verification
10. ปลด Barrier เฉพาะเมื่อ Verified หรือมีหลักฐานว่า Retry ได้

Payload ที่ Persist ต้องไม่มี Token, Cookie, CAPTCHA, Webhook URL หรือ Full response body

## 6. Recovery rules

หลัง Process restart:

| Durable evidence | Recovery action |
|---|---|
| Waiting state และเวลาอยู่อนาคต | รอถึง `next_action_at` |
| `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` | Fetch และ Verify ก่อน Resend |
| `VERIFYING_*` | ทำ Verification ต่อ |
| Active schedule + Terminal checkpoint | เริ่มจาก Fresh server state |
| One-shot ถูกขัดจังหวะ | `FAILED` เพราะ Token ไม่ Durable |

กฎสำคัญ:

- Claim retry ห้ามเปลี่ยน `STOPPED`, `COMPLETED` หรือ `FAILED` กลับเป็น `WAITING_RETRY`
- Transient durable recovery fetch ถูก Defer เข้า Normal loop; Abort และ Fatal authentication ยังคงเป็น Terminal ตาม Policy
- `applyRunnerRecoveryPlan()` ต้องรักษา Diagnostic metadata เดิมก่อนเขียน Recovery fields ล่าสุด
- Restore ที่ Throw ต้อง Report และ Rearm
- Restore summary ที่ `restored <= 0` ถือว่าล้มและต้อง Rearm
- Retry deadline ใหม่ต้อง Persist ลง Durable state ก่อนตั้ง Timer รอบถัดไป
- ก่อน Rearm/Restore ต้องตรวจ State, Schedule row, Schedule ID และ Replacement job ซ้ำ
- Timer ต้องไม่เก็บ Raw user token

## 7. Completion และ Promise safety

`runner-completion-observer.js` ต้อง:

- แยก Resolved กับ Rejected runner promise
- คง Mutation evidence ระหว่าง Recovery
- เปลี่ยน Recovery exit เป็น `WAITING_RETRY`
- เปลี่ยน Ordinary scheduled exit เป็น `FAILED`
- เปลี่ยน Exit หลัง Scheduled row หายเป็น `STOPPED`
- Contain Durable transition/reporting failures
- ไม่สร้าง `unhandledRejection` จาก `.finally()` chain

`runner-completion-release.js` ต้อง:

- Release execution context ทั้ง Resolve และ Reject
- Release เพียงครั้งเดียว
- Contain Release callback failure
- Contain Error reporter ที่ Throw ซ้ำ
- ไม่สร้าง Derived unhandled rejection

Rate-limit coordinator Promise chain ถูกตรวจแล้ว: Error ที่คาดหมายจาก Rate-limit bookkeeping, Circuit, Mutation checkpoint และ Schedule publishing ถูกแยก Catch ก่อน Resolve/Reject

## 8. Rate limit และ Circuit breaker

Coordinator รองรับ:

- Serialization ต่อบัญชี
- Route-to-bucket mapping และย้าย Reset/Circuit state เมื่อ Bucket หรือ Scope เปลี่ยน
- Scope `user`, `shared`, `global`
- Header `Retry-After` และ JSON `retry_after`
- Server delay เต็มจำนวนโดยไม่ Cap เหลือ 60 วินาที
- Response ปกติที่มีโควตาไม่เข้าสู่ body parsing path
- Global pause, Durable `next_action_at` และ Request priority
- Circuit states `CLOSED`, `OPEN`, `HALF_OPEN`
- Mutation barrier ต่อ `jobKey`
- Fresh Quest verification ก่อนปลด Barrier
- Request ที่ยังอยู่ใน Queue ถูกยกเลิกทันทีเมื่อ AbortSignal ถูกยกเลิก

Authorization ใน Queue เก็บเป็น SHA-256 fingerprint ไม่เก็บ Raw token

## 9. Schedule hints และ Smart Wake

- Hint แยกตาม Source
- `expiresAt` เป็นส่วนหนึ่งของ Equality เพื่อให้ต่ออายุ Hint ได้
- Effective hint เป็น `baseline`, `null` หรือ timestamp ไม่ถูกต้อง → ล้าง Timer
- Stop denied → ล้าง Wake attempt และไม่ Restart
- Replacement job → ล้าง Attempt และไม่ Restart ทับ
- Scheduled row หาย → ยกเลิก Smart Wake
- Timer ระยะไกลแบ่งช่วงไม่เกิน 24 ชั่วโมง
- Terminal observed status ต้องชนะ Waiting state

## 10. Multi-worker ownership

- `all` ห้ามทำงานพร้อม `control` หรือ Worker
- `control` อนุญาต Holder เดียว
- Worker หลาย Holder ทำงานพร้อมกันได้
- Scheduled row หนึ่งแถวมี Active claim ได้หนึ่ง Holder
- Worker ต้อง Renew runtime lease และ Job claim
- Worker ที่เสีย Claim ต้อง Abort ก่อน Mutation ถัดไป
- Worker อื่น Takeover ได้หลัง Claim หมดอายุ
- Control และ Workers ต้องใช้ SQLite ไฟล์เดียวกันจริง
- SQLite ใช้ `busy_timeout=5000` เพื่อรอ Write contention แบบมีขอบเขต
- Schema migration, Runtime lease และ Scheduled claim acquisition ใช้ Immediate transaction เพื่อ Serialize การแย่งสิทธิ์ข้าม Process
- Detached `STOPPING` rows ต้องถูก Finalize ครบแม้มีมากกว่า 500 แถว

Shutdown order:

1. Mark worker not-ready
2. หยุด Supervisor
3. Abort local runners
4. รอ `job.done`
5. ปล่อย Scheduled claims
6. ปล่อย Runtime lease
7. ปิด Database

Cleanup แต่ละขั้นต้องแยก Error boundary เพื่อไม่ให้ความล้มเหลวขั้นหนึ่งข้ามขั้นหลัง

## 11. Checkpoint version decision

`checkpoint_version` เป็นข้อมูล Audit/Schema evolution ไม่ใช่ Runtime format switch ใน Source ปัจจุบัน

- กิ่งฐานไม่มี Mutation checkpoint columns
- Additive migration เพิ่ม Fields พร้อม Defaults ที่อ่านได้โดย Source ปัจจุบัน
- Recovery planner ตัดสินจาก State, Mutation kind และ Mutation status โดยตรง
- ไม่มี Legacy v1 mutation payload ที่ต้อง Branch หรือ Migrate แยก

ดังนั้นการ Backfill แถวเดิมเป็น Version 2 ไม่ทำให้ Recovery ตีความ Legacy mutation format ผิด และ Finding ที่ต้องบังคับ Version 1 สำหรับแถวเดิมถือเป็น False positive ภายใต้ Schema ปัจจุบัน

## 12. Full-source audit และ Final automated evidence

Validated implementation HEAD ก่อน Final documentation sync:

`50a11b5008b37ce82f85026df009c9dac098da85`

GitHub Actions CI ของ Implementation HEAD นี้:

- `#1748` — Success
- `#1749` — Success

ผลจาก Artifact ของ CI #1749:

- 462 tests passed
- 0 failed
- 0 cancelled
- 0 skipped
- 0 todo
- Coverage: 93.78% lines / 85.25% branches / 89.28% functions
- LCOV generated: 393,224 bytes
- Mutation baseline ผ่าน
- Critical mutation groups 14/14, 15/15 และ 26/26 ถูก Kill
- Dedicated recovery metadata mutation ถูก Kill
- Mutation scripts คืน Source ครบ
- Repository shape ผ่าน
- Sanitized Quest fixture ผ่าน
- Backup destinations ผ่าน
- Incident/storage boundaries ผ่าน
- JS/MJS/Bash syntax ผ่าน
- Production dependency audit ระดับ High ผ่าน

Full-source audit รอบนี้เพิ่มการตรวจและ Regression coverage สำหรับ:

- Worker readiness, Startup rollback และ Shutdown isolation
- SQLite busy timeout, Immediate migration/lease/claim transactions และ STOPPING มากกว่า 500 แถว
- Route-to-bucket remapping, Scope migration, Global 429 durable deadline และ Queue cancellation
- CAPTCHA heartbeat, Fatal auth precedence และ malformed Headers
- Durable recovery fetch deferral และ All-mode retry persistence
- Backup/Incident recovery lifecycle, recurrence during recovery และ Discord embed total budget
- Credential redaction, `/api-status` privacy และ explicit `emergency:false`
- Worker REST timeout, Fetch Promise semantics และ Execution-context remapping
- README permissions, Environment defaults และ Architecture boundary parsing

External scanners ต้องยืนยันซ้ำบน Final documentation HEAD; CI-based Sonar จะถูก Skip หาก Repository ไม่มี `SONAR_TOKEN`

Mutation gates ที่ยังบังคับใช้อยู่ครอบคลุม:

1. Skip fresh verification หลัง Uncertain mutation
2. Deadline comparison กลับด้าน
3. Ignore uncertain recovery checkpoint
4. Incompatible Quest เข้า Automatic executor
5. Ignore explicit durable update
6. Bypass user-scoped bucket
7. ยอมรับ Invalid target
8. ยอมรับ Invalid progress
9. Baseline ไม่ล้าง Smart Wake
10. Rejected completion ไม่ Release context
11. All-mode recovery ทำงานนอก `WAITING_RETRY`
12. Observer เขียนทับ High-priority wait
13. Malformed video timestamp ถึง Network
14. Completion observer transition failure หลุด Promise chain
15. Completion release error reporter หลุด containment
16. Claim retry ปลุก Terminal runner
17. Unsupported executor ซ่อน Schema reason
18. Failed all-mode restore ไม่ Rearm
19. Empty restore summary ถูกยอมรับ
20. Hint expiry refresh ถูก Ignore
21. Header Retry-After ถูก Cap 60 วินาที
22. Body retry_after ถูก Cap 60 วินาที
23. Normal response เข้า Retry parsing path
24. Terminal status ถูก Waiting state บัง
25. Smart Wake denied attempt ไม่ถูกล้าง
26. Numeric Quest ID ไม่ถูก Normalize
27. Recovery plan ทำ Diagnostic metadata เดิมหาย

## 13. Controlled UAT ที่ยังต้องทำ

1. Enroll Quest จริง
2. Video progress จริง
3. Desktop heartbeat จริง
4. Claim reward จริง
5. CAPTCHA HTTP 400
6. Non-CAPTCHA HTTP 400
7. HTTP 429 ที่ Retry-After มากกว่า 60 วินาที
8. All-mode transient recovery โดยไม่ Restart process
9. Restore summary `restored: 0`
10. Restart ที่ `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, `VERIFIED`
11. Worker ownership conflict
12. Worker lease expiry และ Takeover
13. Persistent SQLite หลัง Restart/Redeploy
14. Stop ระหว่าง Mutation
15. Token invalid ขณะอยู่ Waiting state
16. Claim callback กลับมาหลัง Runner Terminal
17. Panel ยังมีเพียง `START NOW / STOP ALL`
18. Worker shutdown fault injection
19. Backup incident failure → pending recovery → re-failure → successful recovery

ใช้บัญชีและ Server ทดสอบ ห้ามเริ่มจากบัญชีหลัก

## 14. Deployment limitations

- CI ผ่านไม่เท่ากับ Production ready
- SQLite ต้องอยู่บน Shared/Persistent storage ที่ทุก Process เข้าถึงไฟล์เดียวกัน
- ไม่รองรับ Workers ที่ใช้ Database คนละไฟล์
- Sonar/Codacy/CodeFactor ต้องยืนยันบน Final HEAD
- ห้าม Merge, Deploy, Auto-merge หรือเปลี่ยน PR ออกจาก Draft จน Review, External gates, Controlled UAT และการอนุมัติจากเจ้าของครบ

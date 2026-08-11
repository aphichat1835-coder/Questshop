# Changelog

การเปลี่ยนแปลงสำคัญของ Questshop จะบันทึกในไฟล์นี้ รูปแบบอ้างอิงจาก
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) และตั้งใจใช้ Semantic Versioning เมื่อเริ่มออก Release
อย่างเป็นทางการ

## Release status

`package.json` ระบุเวอร์ชันพัฒนา `0.1.0` แต่ repository ยังไม่มีหลักฐาน Production release/tag ที่ผ่าน
Discord, TrueMoney, Managed PostgreSQL, Restore drill และ Owner UAT ครบ จึงรวมรายการปัจจุบันไว้ใต้
`[Unreleased]` และไม่แต่งวันที่ Release

## [Unreleased]

### Added

- Aiven-managed database-backup policy: first-run setup defaults to `BACKUP_MODE=AIVEN_MANAGED`, deployment records
  a SHA-bound `DEPLOYMENT_BACKUP_POLICY` audit without falsely claiming a local backup/restore verification, and
  Admin/health surfaces disclose the provider boundary.

- Forward-only migration guard สำหรับ active Monitor test batch ที่ยังไม่มี contract hash, คำสั่งตรวจความพร้อม
  retire Data/Voucher/Backup Key version และ regression coverage สำหรับ Quest start window/Payment Log privacy

- Owner-only `keys:adopt`, `db:verify-roles`, `setup:preflight` และ secret-bundle export สำหรับตรวจ
  keyring/role/Discord Administrator โดยไม่พิมพ์ Secret ออกมา

- Questshop runtime แบบ Single Guild บน Node.js 22, discord.js และ PostgreSQL 16+
- First-run `npm run setup` ที่ถาม 6 ค่าบังคับสำหรับ Discord/Database และรับ CA เป็นค่าทางเลือก แล้วสร้าง Status token,
  Data/Voucher keyrings, normalized CA และค่าเริ่มต้นลง `.env` permission `0600` แบบ idempotent
- Durable Wallet/Ledger, per-item reservation, Capture/Release, Refund และ Compensating adjustment
- TrueMoney Gift Direct adapter พร้อม URL allowlist, Voucher HMAC, Receiver snapshot, exact-cent parsing,
  bounded retry, circuit breaker และ Owner-only ambiguous review
- Dynamic pricing precedence: Temporary → Quest → Type → Default
- Promotion tiers, per-user usage limits, daily bonus cap และ round-half-up ในหน่วยสตางค์
- Quest catalog/discovery, immutable metadata revisions, Monitor test batches และ customer-discovered Quest flow
- Monitor Admin panel สำหรับเพิ่ม/เปลี่ยน/พัก Token และตรวจสุขภาพแบบ read-only โดยทุกบัญชีทำ Scan+Test
- Checkout session แบบ Actor/Guild/Channel/Message-bound, encrypted Token, pagination, multi-select,
  select-all, quote revalidation และ account-level active-job lock
- Fair queue, lazy job materialization, runner checkpoint, retry/rate-limit state, lease และ fencing token
- Video/Desktop executor registry, fresh progress verification และ Manual Claim URL
- Transactional Outbox, message projection, coalescing, Discord 403/404/429/5xx handling และ DLQ replay
- Discord surfaces: `quest-auto`, `quest-new`, `quest-history`, `admin-panel` และ Log ทั้งสี่ประเภท
- Thai customer/admin UX, Ephemeral checkout/top-up, localized states และ persistent component routing
- Top-up receipt แสดงยอดก่อนเติม เงินต้น โบนัส ยอดรวม และยอดใหม่จาก Ledger snapshot
- Final order DM พร้อมปุ่ม **รับรางวัลทั้งหมด** ไป Quest สำเร็จลำดับแรก และ
  **ดูประวัติ Quest ทั้งหมด** ไปห้องประวัติ
- Health server `/livez`, `/readyz`, Bearer-protected `/statusz`, metrics และ scoped incident handling
- Encrypted streaming QSBK1 backup, S3 verification, restore drill, key coverage และ retention checkpoints
- Migration checksum/advisory lock, runtime-role validation และ schema compatibility N/N-1
- Pre-launch closeout, SHA-bound release evidence, emergency runbooks, traceability และ Definition of Done
- Automated unit, PostgreSQL integration, concurrency, crash, security, contract, recovery และ load tests

### Changed

- inwcloud runtime no longer starts the Questshop `pg_dump`/S3 backup worker or local Backup alerts in
  Aiven-managed mode. Local S3 backup remains an explicit `BACKUP_MODE=LOCAL_S3` compatibility path. Key retirement
  is deliberately blocked in Aiven-managed mode because provider snapshots cannot be inspected or restore-drilled by
  Questshop.

- Hardened Runtime credential loading, Discord startup/shutdown cleanup, Quest response-body deadlines,
  Runner retry evidence, Monitor fencing, backup reconciliation และ destructive test-database safeguards

- Quest API HTTP transport now has a literal `https://discord.com:443` destination, a strict v9 Quest-path
  allowlist, no redirect following, identity-only response encoding and a streamed response-size ceiling. This
  removes the dynamic URL sink while preserving injected test transport and the existing timeout/uncertainty rules.
- CI now uses the Node-24-compatible checkout/setup actions while running Questshop itself on pinned Node 22.22.0;
  it also uploads generated LCOV evidence even when the separate coverage threshold check fails.
- Quest API requests now validate a strict fixed Discord v9 endpoint allowlist before entering the rate-limit
  queue, reject injected Quest identifiers before any HTTP call, and keep request timeout timers referenced so
  Node 22 cannot end a hung-request or rate-limit retry before its safety timer fires.
- Persistent Discord rate-limit blocking now shares the asynchronous contract of the in-memory coordinator;
  Monitor health responses strip every encrypted credential column through an explicit denylist, and test
  fixtures no longer resemble a routable IP address.
- Environment validation, runner controlled-retry inputs, and duration constants were split into focused
  helpers without changing the deployment, backup, TLS, or settlement policies.

- Monitor test passes, Admin **ส่งเลย** overrides, checkout selections, Order Items and Runner Jobs are now
  pinned to one SHA-256 execution-contract fingerprint.  A changed task target/event/progress key cannot reuse a
  prior pass or silently run under an old quoted contract; it pauses public sale and is retained for safe review.
- Monitor tests now defer through PostgreSQL time until the Quest start/enrollment window is available, reject
  unsafe expiry admission before mutation, and recover a crashed durable mutation by fetching fresh Quest state
  before one linked controlled retry can be considered.
- Quest Engine ยึด Discord Quest adapter ที่พิสูจน์จาก baseline: API v9, bounded 15-second request timeout,
  response-size guard, endpoint-specific 403 classification, CAPTCHA-aware heartbeat และ fallback
  `stream_key → application_id` โดยไม่มี Automatic Claim
- Runner recovery เปลี่ยนจากการส่งงานที่มี Mutation ค้างเข้า Manual Review ทันที เป็นการ Fetch Quest ใหม่
  เพื่อ Verify ผลก่อน; retry ได้เฉพาะ `UNCERTAIN` ที่พิสูจน์ว่าไม่เกิดผลและได้เพียงหนึ่งครั้ง
- Capture/Release, terminal Runner job และ lazy materialization ของ Item ถัดไปอยู่ใน Serializable transaction
  เดียวกัน; expiry maintenance ใช้เส้นทางเดียวกันเพื่อไม่ให้ออเดอร์ค้างหลัง Crash
- Quest admission ชะลองานจนถึงเวลาเริ่ม Quest/เวลาปลด enrollment ของบัญชีนั้น และยังคงตรวจ expiry ด้วย
  PostgreSQL time
- Quest API 429 มี cooldown ระดับ Global/Route/Account และเก็บ Global/Route/Account cooldown ใน PostgreSQL
  เพื่อกู้ต่อหลัง Restart โดยไม่เก็บ Token ดิบ; ทุก Checkout, Monitor, Scanner, Test และ Runner ใช้
  coordinator ร่วมกันต่อ Runtime pool, Deployment มอบ `USAGE` เฉพาะ Schema และสิทธิ์ตารางให้ split Runtime
  role โดยตรงโดยไม่มอบ DDL และลบ cooldown ที่หมดอายุเป็น batch จำกัดขนาด
- Runner attempts บันทึก stage/evidence แบบ Redacted สำหรับ preflight, recovery verification, execution และ terminal outcome
- Timeout/transport failure ของ Quest mutation ที่เกิดหลังเริ่มส่ง Request ถูกทำเครื่องหมายว่าอาจส่งถึง Discord
  เสมอ: Runner ต้องอ่านสถานะสดก่อน retry และหากยืนยันว่าการทำงานเดิมเสร็จ จะ Capture ยอดจองและไป
  `READY_TO_CLAIM` แทนการคืนเงินแบบ external completion
- Controlled retry มี Mutation checkpoint และ Parent evidence แยกจากรอบแรก; Completion verification ถูกเก็บ
  แบบ durable ก่อน Settlement และงานที่เริ่มแล้วแต่หาหลักฐานผู้ทำให้สำเร็จไม่ได้จะคง Reserved ใน Manual Review
- Runtime ปฏิเสธ Schema ที่ยังไม่ถึง migration ปัจจุบันตั้งแต่ Readiness แทนการยอมเริ่มแล้วล้มภายหลังใน Worker
- การส่งซองเดียวกันพร้อมกันที่ชน SERIALIZABLE retry จะ reconcile แบบ read-only กับ Top-up เจ้าของเดิม
  ก่อนตอบผล idempotent จึงไม่สร้าง/เข้ารหัสรายการซ้ำและไม่ปล่อยคำขอที่ชนกันล้มโดยไม่จำเป็น

- แยก Deployment migration ออกจาก Runtime: `npm run deploy` ตรวจและสร้าง Pre-migration backup ก่อนเขียน
  Production schema ขณะที่ `npm start` ใช้เฉพาะ pooled Runtime configuration และตรวจ schema แบบ read-only
- Monitor enable/disable ใช้คำสั่งเจาะจงพร้อม expected state/version; Health check และ worker ไม่เขียนทับ
  สถานะ `DISABLED` ที่ Owner ตั้งเอง
- Quest-test failure กับ batch advance/alert อยู่ใน Transaction เดียวและมี recovery สำหรับ failure gap เดิม
- Maintenance ให้ Quest ที่เปิด/พักขายมาก่อนรายการปิด, Renderer มี missing-row fallback, Runner concurrency
  เริ่มต้นเป็น 2 และ CI สร้าง LCOV artifact

- Startup ตรวจ Discord Administrator ครั้งเดียวก่อนรับงาน; ห้องหลังบ้านไม่ทำ per-surface bot permission drift check
- Payment Log ตรวจความเป็นส่วนตัวของมนุษย์ทุกครั้งก่อนถอดรหัสหรือส่งลิงก์ซองเต็ม; หากไม่ปลอดภัยจะปิด
  Surface, เปิด Incident, แจ้ง Owner และเก็บ Financial DLQ ไว้ Replay หลังซ่อมสิทธิ์
- Keyring ใช้ cryptographic sentinel ใน PostgreSQL เพื่อตรวจจับ key material คนละชุดแม้ version เท่ากัน
- Keyring sentinel ตรวจชุด key versions แบบ exact และสร้างทั้งชุดใน Transaction เดียว; Database เก่าที่มี
  ข้อมูลต้องผ่าน Owner adoption ที่ตั้งใจชัดเจนก่อน Runtime จะยอมเริ่ม
- Production บังคับ `GIT_SHA` 40 ตัวอักษรเพื่อผูก deployment evidence กับ source revision จริง
- Shutdown ทำ cleanup ต่อแม้ Discord destroy ล้มเหลว และ Startup รับ SIGTERM/SIGINT ก่อน Runtime พร้อม
- Runner state mismatch ถูกกักไป Manual Review พร้อม Incident/Outbox แทนการวนคิวงานที่เสีย

- คำสั่ง Runtime/Migration/Register/Backup โหลด `.env` ให้อัตโนมัติ และ Docker รองรับการ Mount
  `.env` โดยไม่ Copy Secret เข้า Image
- `.env.example` เหลือเฉพาะค่าภายนอกที่ระบบสร้างเองไม่ได้; Backup เริ่มต้นปิดจนกว่าจะตั้งค่า S3/Restore
- Monitor-discovered Quest ต้องมี Monitor อย่างน้อยหนึ่งบัญชีทดสอบผ่านก่อนประกาศ/เปิดขายทั่วไป
  เว้นแต่ Admin ใช้ audited **ส่งเลย** override
- Customer-discovered Quest บันทึกตัวตนผู้ใช้และ Quest account ในหลังบ้านโดยไม่บันทึก Token ดิบ;
  ห้องประกาศสาธารณะไม่เผยผู้ค้นพบ
- `quest-new` ไม่แสดง Quest ID, test state หรือ internal sale state
- Quest select option แสดงเฉพาะประเภท, Orbs, Progress และราคา; Expiry อยู่หน้า Quote เพื่อลดความรก
- Progress history ใช้ข้อความเดิมและ bucket `0/25/50/75/100%`
- Admin panel แบ่งหมวดด้วย Select menu, ใช้ภาษาไทย และลดศัพท์ระบบจากหน้าภาพรวม
- Payment interaction รอผลแบบ bounded และแสดงผลสำเร็จ/ล้มเหลว/รอตรวจตามสถานะจริง โดย Worker ยังเป็น
  เจ้าของ Provider mutation
- Runtime interaction handlers และ Shutdown ใช้ Runtime object เดียวกันเพื่อให้ ingress fencing ถูกต้อง
- Setup command ที่เรียกซ้ำ Update/Move surface เดิมและเก็บ Guild/Channel/Message identity
- Financial and runner recovery paths เพิ่ม durable transition evidence และ stale-fencing protection
- Runtime startup ตรวจ migration checksum และ cryptographic keyring sentinel ก่อนยึด lease หรือรับ Interaction;
  ระหว่าง recovery จะปิด ingress อย่างชัดเจน และต่ออายุ Runtime lease ตั้งแต่ต้น startup โดย retry เฉพาะ
  DB transient แบบจำกัดครั้งก่อน self-fence
- Monitor fatal-auth failure จะ Quarantine บัญชีใน Transaction เดียวก่อนเลือก token ทดสอบตัวถัดไป จึงไม่ทิ้ง
  Quest-test batch ที่คิวอยู่กับบัญชีถูกกักกัน
- Runtime secret bundle และ runtime loader ไม่ถือ `DATABASE_RESTORE_URL`; Backup/Restore รองรับทั้ง private CA
  และ public trusted root, และมี `npm run backup:reconcile` สำหรับนำ pre-migration backup ที่อัปโหลดแล้วแต่
  migration ล้มเหลวกลับเข้าสู่ durable record
- Payment schema incident เป็น upsert และบันทึก Payment outcome ก่อนเปิด incident เพื่อไม่ให้ observability
  ขวาง authoritative financial recovery; Projection มี fallback เมื่อ aggregate หายและตรวจ media URL ก่อน render
- CI สร้าง LCOV ที่ตรวจว่าไม่ว่าง พร้อม gate coverage ขั้นต่ำสำหรับ lines/branches/functions เพื่อกันตัวเลขถอย
  แบบเงียบ ๆ

### Removed

- Automatic Quest reward claim และ Claim retry API จาก source graph
- Runtime Permission Drift detector, auto-repair route และ persisted permission snapshot ตามนโยบาย Owner;
  คงเฉพาะ permission precondition ตอนติดตั้ง Surface
- Legacy command/UI, SQLite/JSON Wallet, hard-coded product stock และ Daily/Auto Claim behavior จาก Runtime ใหม่
- ปุ่มรับรางวัลแยกราย Quest ใน DM สรุป เปลี่ยนเป็นปุ่ม **รับรางวัลทั้งหมด** ปุ่มเดียว

### Security

- Setup สร้าง Data encryption, Voucher HMAC และ Backup encryption เป็นคนละ Key และไม่ Rotate ทับ
  ค่าเดิมเมื่อรันซ้ำ; การเขียนไฟล์ใช้ Temporary file แล้ว Rename พร้อม permission `0600`
- Token lifecycle ใช้ AES-256-GCM, versioned keyring, AAD และไม่มี Admin read path
- Structured log redaction ป้องกัน Token, Cookie, Session, Database URL, S3 secret และ Key material
- Voucher duplicate protection ใช้ versioned HMAC และ unique constraint
- Financial transaction ใช้ PostgreSQL row locks, `SERIALIZABLE`, idempotency และ append-only Ledger/Audit
- External mutation ใช้ durable intent/checkpoint; post-send uncertainty ห้าม blind retry
- Runtime/Payment/Runner/Outbox/Test/Maintenance ใช้ leases, heartbeats และ fencing tokens
- `/statusz` ใช้ Bearer token และ fixed-size digest comparison; unauthorized response ไม่เผยสถานะภายใน
- Backup database CA ถูกสร้างเป็นไฟล์ชั่วคราว mode `0600` เฉพาะช่วง `pg_dump`/`pg_restore` แล้วลบ
- Financial/Audit DLQ ห้าม Discard และ duplicate-credit/negative-balance/ledger-mismatch เป็น incident ปิด Feature

### Known live boundaries

- ยังต้องทดสอบ Discord desktop/mobile, permissions, persistent controls และ REST/Gateway failures ใน Guild จริง
- ยังต้องทดสอบ TrueMoney low-value success, ambiguous-after-send และ schema drift ด้วยหลักฐานจริง
- ยังต้องทดสอบ Video/Desktop Quest จริงและทบทวนความเสี่ยง Discord user token/Self-bot
- ยังต้องยืนยัน Managed PostgreSQL TLS/roles, encrypted S3 backup และ temporary-database restore drill
- ยังต้องทำ Owner pre-launch closeout, gate-by-gate opening, rollback rehearsal และ alert delivery บน SHA เดียวกัน

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

- Questshop runtime แบบ Single Guild บน Node.js 22, discord.js และ PostgreSQL 16+
- First-run `npm run setup` ที่ถามเฉพาะ Discord/Database/CA จำนวน 7 ค่า แล้วสร้าง Status token,
  keyrings สามชุด, normalized CA และค่าเริ่มต้นลง `.env` permission `0600` แบบ idempotent
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

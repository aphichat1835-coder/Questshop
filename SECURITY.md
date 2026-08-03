# Security Policy

Questshop จัดการข้อมูลที่มีความเสี่ยงสูง ได้แก่ Discord bot/user tokens, TrueMoney vouchers, Wallet credit,
Receiver phone, PostgreSQL credentials และ encryption/HMAC keys โปรดอ่านนโยบายนี้ก่อน Deploy, Review หรือ
รายงานช่องโหว่

## Supported versions

| Version | Security support |
|---|---|
| `[Unreleased]` / development `0.1.x` | Supported while actively maintained |
| Older snapshots or forks | Not supported unless the Owner explicitly says otherwise |

ยังไม่มี Production release ที่รับรองแล้ว การที่ source และ automated tests ผ่านไม่ใช่หลักฐานว่า Live environment
ปลอดภัยหรือพร้อมใช้งาน

## Reporting a vulnerability

อย่าเปิด Public issue, Discussion, Pull Request comment หรือ Discord public channel ที่มีรายละเอียด Exploit หรือ
ข้อมูลลับ

ช่องทางที่แนะนำ:

1. ใช้ [GitHub Private Vulnerability Reporting / Security Advisory](https://github.com/aphichat1835-coder/Questshop/security/advisories/new)
   ของ repository นี้ หากเปิดใช้งานอยู่
2. หากใช้ไม่ได้ ให้ติดต่อ Repository Owner แบบส่วนตัวก่อนส่งรายละเอียด ห้ามส่ง Token หรือ Secret จริงจนกว่า
   จะยืนยันช่องทางที่เหมาะสม

รายงานควรมีข้อมูลต่อไปนี้โดยใช้ค่าจำลองหรือข้อมูลที่ปิดบังแล้ว:

- ประเภทช่องโหว่และผลกระทบ
- Commit SHA/branch/version ที่ตรวจพบ
- Preconditions และขั้นตอนทำซ้ำที่สั้นที่สุด
- Expected/actual behavior
- Component ที่เกี่ยวข้อง เช่น Discord route, Domain service, Worker, Migration หรือ Provider phase
- Correlation/support code, Order/Top-up/Job ID ที่ไม่ใช่ Secret
- หลักฐานว่าเกิด Side effect หรือไม่ โดยไม่แนบ Token, Cookie, Voucher URL เต็ม หรือ Database URL
- แนวทางแก้หรือ Containment หากมี

อย่าทดสอบด้วยการ Redeem ซองจริง, ทำให้เครดิตผู้อื่นเปลี่ยน, ใช้ Token ของผู้อื่น, ทำลายข้อมูล, Flood Discord/
Provider หรือเข้าถึง Production โดยไม่ได้รับอนุญาต ใช้ Fake adapter และ disposable database เมื่อทำได้

Repository นี้ยังไม่มี Bug bounty และไม่มีการอนุญาตให้ทดสอบระบบภายนอกของ Discord หรือ TrueMoney

## Sensitive data that must never be disclosed

- Discord bot token หรือ user token
- Cookie, session, interaction/webhook token หรือ OAuth secret
- Full TrueMoney voucher URL/code นอก `log-payments` ที่ผ่านการตรวจห้องลับ
- Database URL, password, TLS private material หรือ dump ที่ถอดรหัสแล้ว
- AES/HMAC/backup key หรือ raw keyring JSON
- S3 access/secret key
- Receiver phone แบบเต็มจาก decrypted storage
- Raw provider request/response ที่อาจมี PII หรือ Secret

หาก Secret รั่ว ให้ Revoke/rotate ที่ Provider ก่อน แล้วจึง Preserve เฉพาะ metadata ที่จำเป็นสำหรับ Incident
อย่า Commit การลบ Secret อย่างเดียวแล้วถือว่าแก้เสร็จ เพราะ Git history, logs, artifacts และ backups อาจยังมีค่าเดิม

## Priority areas

โปรดรายงานเป็นพิเศษหากพบ:

- Token/Secret ปรากฏใน Log, Error, Discord UI, test fixture, artifact หรือ Git history
- Customer/Admin authorization bypass, forged/stale custom ID หรือ session actor/guild/channel mismatch
- Wallet ติดลบ, duplicate credit, double Capture/Release, Ledger mismatch หรือแก้ Ledger/Audit เดิมได้
- Voucher replay, HMAC bypass, Receiver snapshot mismatch หรือ Promotion ถูกใช้เกิน Limit
- TrueMoney post-send timeout ถูก Blind retry หรือ Schema drift แล้วยัง Credit
- Account active-job uniqueness bypass หรือ Queue fairness/resource-exhaustion ที่กระทบผู้อื่น
- Lease/fencing bypass ที่ทำให้ Worker เก่า Commit หลังเสียสิทธิ์
- Outbox duplicate delivery, Financial DLQ discard หรือข้อความลับส่งไป Surface ผิดห้อง
- SQL injection, migration checksum bypass, Runtime role ได้ DDL/แก้ Ledger หรือ TLS verification ถูกปิดใน Production
- AES-GCM nonce/AAD/key-version misuse, key rotation data loss หรือ backup decrypt/restore integrity bypass
- `/statusz` authorization bypass หรือ Health endpoint เผย Secret/operational data โดยไม่ได้รับอนุญาต
- Markdown/mention/URL injection ที่ทำให้ Ping, phishing หรือเปิด URL นอก allowlist

## Security invariants

### Money

- จำนวนเงินเป็น integer satang เท่านั้น ห้าม Floating point
- Financial transaction ใช้ `SERIALIZABLE`, row locks, bounded whole-transaction retry และ idempotency
- Wallet balance ห้ามติดลบ; Reserved เปลี่ยนผ่าน Reserve/Capture/Release เท่านั้น
- Ledger/Admin audit เป็น Append-only การแก้ไขใช้ Compensating transaction
- `REDEEMED` ไม่เท่ากับ `CREDITED`; Recovery ต้อง Credit exactly once
- Ambiguous payment เป็น Owner-only decision และห้าม Blind retry
- Financial/Audit DLQ ห้าม Discard

### Credentials

- Customer token เป็น Session/Order scoped และลบเมื่อหมดหน้าที่
- Monitor token เข้ารหัสและ Admin เปิดดูไม่ได้
- Encryption ใช้ AES-256-GCM, random 12-byte nonce, versioned key และ context-specific AAD
- Voucher identity ใช้ versioned HMAC และ unique constraint
- `npm run setup` สร้าง Status token และ Data/Voucher/Backup keys แยกกันครั้งเดียวลง `.env` mode
  `0600`; การรันซ้ำต้องรักษาค่าเดิม
- ห้ามสุ่ม Key ใหม่ทุก Startup หรือเก็บ `.env` ไว้เฉพาะ Filesystem ชั่วคราวของ Container
- ก่อน Redeploy ต้อง Mount `.env` จาก Durable secret storage หรือย้ายค่าเข้า Environment/Secret manager

### Discord

- Ephemeral ไม่ใช่ Authorization; ทุก Side effect ต้อง Reauthorize actor/context/state
- Custom ID เป็น versioned opaque identifier และทุก callback โหลด Server-side session ใหม่
- Allowed mentions เป็น deny-by-default
- Setup ต้องตรวจ Bot access และ Private log visibility ก่อนติดตั้ง
- Runtime Permission Drift auto-repair ไม่มีในระบบตาม Owner policy; Discord 403 ต้อง Preserve incident แล้ว Owner แก้เอง

### Workers and external mutations

- External call ห้ามอยู่ใน Database transaction
- Intent/checkpoint ต้อง Commit ก่อน External mutation และต้อง Verify state หลังส่ง
- ทุก Commit ของ Worker ที่ถือ Lease ต้องตรวจ owner + fencing token + state version
- Retry/429/deadline มี Budget; ห้าม Unbounded loop
- Restart recovery ต้อง Preserve partial truth และไม่เดาผลสำเร็จ

## Deployment minimums

ก่อนเปิด Production gates ต้องมีอย่างน้อย:

- Node.js และ dependency versions ตรง `package-lock.json`
- Managed PostgreSQL 16+, TLS `verify-full`, CA จริง และแยก runtime/migrator/backup/restore roles
- Runtime role ไม่มี DDL และไม่มี `UPDATE/DELETE` บน Ledger/Admin audit
- Secret manager, versioned keyrings และ `GIT_SHA` ที่เป็น revision จริง
- Private `log-payments`, `log-quest-operations`, `log-admin`, `log-system` พร้อมตรวจ `@everyone`
- Automated verification, high-severity dependency audit และ Docker build บน SHA เดียวกัน
- TrueMoney/Quest live UAT แบบควบคุม, encrypted backup และ verified restore drill
- Owner closeout และเปิด Feature gates ทีละขั้นตาม [Pre-launch UAT](docs/uat/prelaunch.md)

ห้ามลด Validation, ปิด TLS verification, เปิด Auto-credit เมื่อ Provider contract ไม่แน่นอน หรือแก้ Database ตรง
เพื่อให้การทดสอบผ่าน

## Known and accepted risks

- Discord user token/Self-bot behavior อาจขัดข้อกำหนด Discord และทำให้บัญชีถูกจำกัด
- Direct TrueMoney endpoint ไม่มี Contract รับประกัน และ v1 ไม่มี Automated reconciliation
- ไม่มี Token consent record และไม่ตรวจว่าผู้ซื้อเป็นเจ้าของ Quest account ตาม Owner policy
- คนละผู้ซื้ออาจใช้ Quest account เดียวกันได้เมื่อมี Token แต่ Active job ซ้อนกันไม่ได้
- Customer-discovered Quest อาจถูกวิเคราะห์/ประกาศตาม Policy โดยไม่รอ Monitor test สำหรับบัญชีนั้น
- Discord messages, profile data และ full voucher link ในห้อง Payment log ถูกเก็บตามนโยบาย Owner
- ไม่มี Staging แยก; Pre-launch ใช้ Production bot/guild/database โดยปิด Customer gates
- Runtime ไม่ซ่อม Discord permission drift อัตโนมัติ

ความเสี่ยงที่ยอมรับไม่ได้ยกเลิกหน้าที่ในการรายงาน Token leak, unauthorized access, money invariant failure หรือ
การเปิดเผยข้อมูลเกินขอบเขตที่กำหนด

## Incident response

ทุก Incident ใช้ลำดับ:

```text
Detect → Contain → Preserve evidence → Recover → Verify → Reopen → Post-incident review
```

Immediate financial containment ได้แก่ปิด Gate ที่เกี่ยวข้อง, หยุด Auto-credit/Order intake เมื่อจำเป็น และรักษา
Ledger/attempt/fencing evidence ห้าม Auto-release หรือแก้ยอดเพื่อซ่อน mismatch

ดูขั้นตอนรายเหตุการณ์ที่ [docs/runbooks/README.md](docs/runbooks/README.md) และบันทึก Incident ID, Trace IDs,
Git SHA, Timeline, Actor, Evidence hashes, Recovery และ Owner approval โดยไม่บันทึก Secret

## Disclosure and fixes

- ให้เวลาผู้ดูแลตรวจสอบและออก Fix ก่อนเปิดเผยรายละเอียดสาธารณะ
- Fix ด้านเงิน/Token/External mutation ต้องมี Regression test, impact review และ recovery/rollback plan
- Security fix ยังไม่ถือว่าเสร็จจนตรวจ Secret rotation, logs/artifacts/history, database state และ live boundary ที่เกี่ยวข้อง
- Release note ต้องอธิบายผลกระทบและการตั้งค่า/Migration ที่จำเป็นโดยไม่เปิดเผย Exploit ที่ยังใช้โจมตีได้

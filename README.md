# Questshop

Questshop คือบอทร้านค้า Discord สำหรับรับทำ Discord Quest อัตโนมัติ ลูกค้าเติมเครดิตด้วย
TrueMoney Gift, กรอก Token ของบัญชี Quest, เลือก Quest ได้หลายรายการ และติดตามความคืบหน้าใน
Discord ได้โดยไม่ต้องใช้เว็บไซต์แยก

ระบบนี้ออกแบบสำหรับ Discord Guild เดียว ใช้ Node.js 22, `discord.js` และ PostgreSQL 16+
สถานะสำคัญทั้งหมด—Wallet, Ledger, Payment, Order, Runner, Lease, Outbox และ Manual Review—เก็บแบบ
durable ใน PostgreSQL เพื่อให้กู้การทำงานต่อได้หลัง Process restart

> [!IMPORTANT]
> สถานะปัจจุบันคือ **implemented-but-unverified**: โค้ดและ Automated tests มีหลักฐานครอบคลุม
> แต่ยังห้ามเรียกว่า Production-ready จนกว่า Discord UAT, TrueMoney จริง, Managed PostgreSQL
> และ Owner closeout จะผ่านบน Git SHA เดียวกัน การกู้ข้อมูลของ Aiven เป็นขอบเขตภายนอกที่ Questshop
> ไม่สามารถ Restore drill แทนผู้ให้บริการได้
> [!WARNING]
> ระบบ Quest ใช้ Discord user token/Self-bot behavior ซึ่งอาจขัดข้อกำหนดของ Discord และอาจทำให้
> บัญชีถูกจำกัดหรือปิดใช้งาน เจ้าของระบบยอมรับความเสี่ยงนี้โดยชัดแจ้ง ผู้ติดตั้งต้องทบทวนข้อกำหนด
> ปัจจุบันของ Discord ด้วยตนเองก่อนใช้งานจริง

## ความสามารถหลัก

- หน้าร้าน `quest-auto` มีเพียงปุ่ม **เริ่มทำเควส** และ **เติมเงิน**
- Checkout เป็น Ephemeral: ตรวจ Token, ดึงโปรไฟล์, เลือกหลาย Quest, แบ่งหน้าเกิน 25 รายการ,
  เลือกทั้งหมด, ตรวจราคา และยืนยันยอดจอง
- ตัวเลือก Quest แสดงประเภท, Orbs, Progress และราคา; วันหมดอายุแสดงในหน้าตรวจสอบก่อนยืนยัน
- เติมเครดิตด้วย TrueMoney Gift แบบซองผู้รับคนเดียว พร้อม Voucher HMAC, Receiver snapshot,
  Promotion, exact-once credit และ Owner-only review เมื่อผลไม่ชัดเจน
- Wallet ใช้จำนวนเต็มหน่วยสตางค์ แยกเครดิตพร้อมใช้กับเครดิตที่จอง และไม่มี Transfer/Withdrawal
- คิดค่าบริการทีละ Quest: สำเร็จจึง Capture; ล้มเหลวแน่ชัดจึง Release เครดิตคืน
- Fair queue, lazy job materialization, durable runner checkpoint, lease และ fencing token
- รองรับ Quest ประเภทดูวิดีโอและเล่นเกมบน Desktop ตาม Executor registry ปัจจุบัน
- `quest-new` ใช้หนึ่งข้อความต่อ Quest และแก้ข้อความเดิมเมื่อข้อมูลเปลี่ยน
- ประวัติใช้หนึ่งข้อความต่อ Order item และแสดง Progress เป็นช่วง `0/25/50/75/100%`
- เมื่องานสำเร็จ ลูกค้ากดรับรางวัลเอง ไม่มี Automatic Claim API
- DM สรุปออเดอร์มีปุ่ม **รับรางวัลทั้งหมด** ไปยัง Quest สำเร็จลำดับแรก และปุ่ม
  **ดูประวัติ Quest ทั้งหมด** ไปยังห้องประวัติ
- Admin panel แบบ Select menu สำหรับร้าน, ราคา, Promotion, Order, Wallet, Monitor, Receiver,
  Blocklist, Review, Backup และเหตุขัดข้อง
- Transactional outbox, coalescing, bounded retry และ DLQ สำหรับการส่งข้อความ Discord
- Health endpoints, Aiven-managed database-backup policy, retention และ key-version coverage

## พฤติกรรมที่ตั้งใจไว้

### เงินและการคืนเครดิต

เมื่อยืนยันออเดอร์ ระบบย้ายยอดจาก `available` ไป `reserved` แยกราย Quest โดยยังไม่ถือเป็นรายได้ร้าน

```text
Confirm → Reserve ราย Item
Quest สำเร็จและตรวจยืนยันแล้ว → Capture เต็มราคาที่ Quote ไว้
Quest ล้มเหลวแน่ชัด/หมดอายุก่อนเริ่ม/เสร็จจากที่อื่น → Release คืน Wallet
ผลไม่ชัดเจน → คง Reserved และเปิด Manual Review
```

Refund ทุกกรณีคืนเป็น Wallet credit ไม่มีวันหมดอายุ ไม่มีการถอนหรือโอนเครดิต และ Admin ห้ามแก้หรือลบ
Ledger เดิม การแก้ยอดต้องสร้าง Compensating transaction พร้อมเหตุผลและ Audit

### การค้นพบและทดสอบ Quest

- Quest ที่ Monitor พบจะยังไม่ประกาศหรือเปิดขายทั่วไปจนกว่า Monitor อย่างน้อยหนึ่งบัญชีทดสอบผ่าน
- แต่ละ Monitor ลองได้สูงสุด 3 ครั้ง แล้วจึงเปลี่ยนไปบัญชีถัดไป และหยุดทันทีเมื่อมีหนึ่งบัญชีผ่าน
- หากทุก Monitor ล้มเหลว ระบบแจ้งหลังบ้านพร้อม **ส่งเลย** และ **ลองทดสอบอีกครั้ง**
- Quest ที่พบจาก Token ลูกค้าจะถูกวิเคราะห์และใช้กับบัญชีลูกค้านั้นได้เมื่อเข้าเงื่อนไข Checkout
  พร้อมบันทึกตัวตนลูกค้า/Quest account ในหลังบ้าน แต่ห้ามบันทึก Token ดิบ
- `quest-new` สาธารณะไม่เปิดเผยว่าพบจากลูกค้าคนใด และไม่แสดง Quest ID หรือสถานะภายใน

Monitor ทุกบัญชีทำทั้ง Scan และ Test อัตโนมัติ ไม่มีการเลือก Capability แยก และหน้า Admin มี
**เช็คระบบ Token** แบบ read-only ซึ่งตรวจ Login/Identity/Quest list โดยไม่เริ่มทำ Quest

### Token และ Claim

- Customer token: รับ → ตรวจ → เข้ารหัส AES-256-GCM → ใช้เฉพาะ Checkout/Order → ลบเมื่อหมดหน้าที่
- Monitor token: เข้ารหัสและเปิดดูจาก Admin ไม่ได้; invalid token ถูก Quarantine
- Token, Cookie, Session, Database URL และ Key material ห้ามปรากฏใน Log หรือ Discord UI
- Reward claim เป็น Manual เท่านั้น โค้ดใน `src/` ไม่มี `claimQuest()` หรือ Claim retry policy

## สถาปัตยกรรม

```text
Discord Gateway / Interactions
           │
           ▼
   Interaction Router ──► Domain Services ──► PostgreSQL 16+
           │                    │                    │
           │                    ├─ Wallet/Ledger     ├─ Durable state
           │                    ├─ Payment           ├─ Queue/Lease/Fencing
           │                    ├─ Catalog/Pricing   ├─ Outbox/DLQ
           │                    ├─ Checkout/Order    └─ Audit/Reviews
           │                    └─ Runner
           │
           ├─ Payment worker ×1
           ├─ Runner worker ×3 (ตั้งค่าได้สูงสุด 5)
           ├─ Outbox worker ×2
           ├─ Discovery/Test/Maintenance workers
           └─ HTTP /livez /readyz /statusz
```

Discord handler มีหน้าที่ Validate/Acknowledge แล้วเรียก Domain service เท่านั้น การเปลี่ยน State หรือยอดเงิน
ต้องผ่าน Transaction, idempotency, compare-and-swap และ Audit ห้าม Handler เขียนสถานะธุรกิจตรง

อ่านรายละเอียดเพิ่ม:

- [System architecture](docs/architecture/system.md)
- [State-machine contracts](docs/state-machines/contracts.md)
- [PostgreSQL role contract](docs/architecture/postgresql-roles.md)
- [Requirement traceability](docs/architecture/traceability.md)
- [Completion audit](docs/architecture/completion-audit.md)

## เทคโนโลยีและข้อกำหนด

- Node.js `>=22.22.0 <23`
- npm และ lockfile ที่อยู่ใน repository
- PostgreSQL 16+
- Discord application/bot และ Production Guild หนึ่งแห่ง
- Production URL ต้องใช้ `sslmode=verify-full`; ระบุ TLS CA ได้เมื่อผู้ให้บริการใช้ private CA
- Aiven for PostgreSQL (แผน Free รองรับ Backup โดยผู้ให้บริการ); S3/`pg_dump` ใช้เฉพาะโหมด Local S3 แบบ legacy
- หน่วยความจำเป้าหมาย 512 MB; RSS gate ต่ำกว่า 400 MB

Dependencies หลักถูก Pin ใน [package.json](package.json): `discord.js 14.27.0`, `pg 8.22.0`,
`zod 4.4.3`, `uuid 14.0.1`, `pino 10.3.1` และ AWS SDK สำหรับ S3

## ติดตั้งสำหรับพัฒนา

```bash
git clone <repository-url>
cd Questshop
npm ci --ignore-scripts
npm run setup
```

`npm run setup` จะถามเฉพาะค่าภายนอกที่ระบบสร้างเองไม่ได้ แล้วสร้าง `.env`, Status token และ
Encryption/HMAC keyrings ให้โดยอัตโนมัติ ไฟล์ถูกตั้ง permission เป็น `0600` และถูก Git ignore

เตรียม PostgreSQL roles ตาม [postgresql-roles.md](docs/architecture/postgresql-roles.md) ก่อนรัน Migration

### เตรียมฐานข้อมูลและคำสั่ง Discord

```bash
npm run deploy
npm run db:verify-roles
npm run setup:preflight
npm start
```

`npm run deploy` เป็นเจ้าของ Migration และ Command registration เพียงทางเดียว หาก Production มี schema เดิม
และมี Migration ใหม่ ระบบจะบันทึก Audit ว่าใช้ Aiven-managed backup พร้อม Git SHA โดยไม่กล่าวอ้างว่า
Questshop ตรวจ Backup หรือ Restore สำเร็จ
ส่วน `npm start` ใช้เฉพาะ Runtime pooled credential, ตรวจเพียง schema compatibility แบบ read-only และจะปฏิเสธ
การเริ่มระบบหากยังไม่ได้รัน Deployment step

Development mode:

```bash
npm run dev
```

## Environment variables

### ค่าที่เจ้าของร้านต้องกรอก

มี 6 ค่าบังคับใน [.env.example](.env.example):

| ตัวแปร | หน้าที่ |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token จาก Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Discord Application ID |
| `DISCORD_GUILD_ID` | Server ID ที่ใช้เปิดร้าน |
| `OWNER_ID` | Discord User ID ของเจ้าของร้าน |
| `DATABASE_POOL_URL` | URL ของ Runtime role สำหรับ Node `pg` pool ในบอท (บน Aiven Free ใช้ URL จาก Aiven โดยตรง ไม่ได้มี PgBouncer ของ Aiven) |
| `DATABASE_DIRECT_URL` | PostgreSQL direct URL ของ Migration role |

`DATABASE_SSL_CA_INPUT` เป็นค่าทางเลือก: ใส่พาธไฟล์ CA PEM หรือ Base64 เฉพาะเมื่อ certificate ของผู้ให้บริการ
ไม่ได้ chain ไปยัง trusted root ของ Node โดยตรง

รัน `npm run setup` แล้วระบบจะสร้างหรือกำหนดค่าต่อไปนี้เอง:

- `STATUS_TOKEN`
- `DATA_ENCRYPTION_KEYS_JSON`
- `VOUCHER_HMAC_KEYS_JSON`
- `DATABASE_SSL_CA_BASE64`
- `BACKUP_MODE=AIVEN_MANAGED` สำหรับการเริ่มติดตั้ง
- Default ของ Port, Timezone, Pre-launch, Runner concurrency และ Discord client fingerprint

Setup เป็น idempotent: การรันซ้ำจะใช้ Secret เดิม ไม่ Rotate หรือสร้าง Key ใหม่ทับข้อมูลที่เข้ารหัสไว้

Production deployment ต้องส่ง `GIT_SHA` ที่เป็น commit SHA 40 ตัวอักษรจาก CI/Image metadata ไม่ใช่ค่าที่
เจ้าของร้านต้องสุ่มหรือกรอกเอง ระบบจะปฏิเสธ `unknown` ใน Production เพื่อให้ Migration, Backup และ UAT
ผูกกับ source revision เดียวกันได้

> [!CAUTION]
> `.env` คือ Secret ถาวรของร้าน ต้องสำรองเข้า Secret manager ที่ปลอดภัย ห้าม Commit, ส่งในแชต,
> ใส่ Docker image หรือปล่อยหายเมื่อ Redeploy หาก Key สูญหาย Token/Receiver เดิมอาจถอดรหัสไม่ได้

### Backup ของ Aiven และ Local S3 แบบ legacy

ค่าเริ่มต้นใช้ `BACKUP_MODE=AIVEN_MANAGED`: inwcloud ไม่ต้องมี PostgreSQL client, `pg_dump`, `pg_restore`, S3 หรือ
Backup key เพิ่ม เพราะ Aiven เป็นผู้สำรองฐานข้อมูลอัตโนมัติเอง

หากในอนาคตต้องการกลับไปใช้ Backup ของ Questshop เอง ให้เปลี่ยนเป็น `BACKUP_MODE=LOCAL_S3` และเพิ่ม
`DATABASE_BACKUP_URL`, `DATABASE_RESTORE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` และ `BACKUP_ENCRYPTION_KEYS_JSON`

ค่า S3 และ Database URL เหล่านี้สร้างอัตโนมัติไม่ได้ เพราะต้องมาจากผู้ให้บริการภายนอก

สำหรับ Docker ให้ Mount `.env` เป็น Secret file หรือย้ายค่าข้างในเข้า Secret manager ของ Platform;
ไฟล์นี้ไม่ถูก Copy เข้า Image โดยตั้งใจ

สำหรับ Host แบบ stateless ให้สร้าง Runtime bundle ที่ตัด `DATABASE_DIRECT_URL` และ `DATABASE_RESTORE_URL` ออก
เพื่อลดสิทธิ์ของบอท 24/7 แล้วนำเนื้อหาไฟล์ไปเก็บใน
Secret manager เป็น `QUESTSHOP_SECRET_BUNDLE`:

```bash
QUESTSHOP_SECRET_BUNDLE_FILE=/secure/questshop.bundle npm run setup:export-secret-bundle
```

Deployment job ที่จบกระบวนการหลัง Migrate/Register ใช้ bundle แยกต่างหาก:

```bash
QUESTSHOP_SECRET_BUNDLE_SCOPE=deployment \
QUESTSHOP_SECRET_BUNDLE_FILE=/secure/questshop-deployment.bundle npm run setup:export-secret-bundle
```

Runtime รับเฉพาะค่า allowlist และลบ shared bundle/`DATABASE_DIRECT_URL` ออกจาก process environment หลังโหลด;
environment variable ที่ Platform กำหนดมีสิทธิ์เหนือกว่า bundle และ bundle ไม่ใช่ช่องทาง Rotate key อัตโนมัติ

> [!IMPORTANT]
> ระบบใหม่ที่ยังไม่มีข้อมูล Durable จะสร้าง Sentinel แบบอัตโนมัติครั้งแรก สำหรับฐานข้อมูลเก่าที่มีข้อมูลแล้ว
> แต่ยังไม่มี Sentinel ให้ตรวจ keyrings ด้วย Owner ก่อน แล้วรัน
> `QUESTSHOP_KEYRING_ADOPTION=VERIFY_KEYS_AND_ADOPT npm run keys:adopt` เพียงครั้งเดียว ห้ามใช้คำสั่งนี้
> เพื่อเดา/แก้ปัญหา key ที่สูญหาย คำสั่งเดียวกันนี้ใช้เพิ่ม Key version ใหม่หลัง Owner ตรวจค่าใน
> Secret manager แล้วได้ แต่ไม่ยอมลบหรือแทนที่ Sentinel ของ Key เดิม

หลัง Worker re-encrypt ข้อมูลด้วย Key ใหม่และ Restore drill ผ่านแล้ว ให้ตรวจความพร้อมก่อนนำ Key เก่าออกจาก
Secret manager ด้วย `QUESTSHOP_RETIRE_DATA_KEY_VERSION=<version> npm run keys:retire:verify`,
`QUESTSHOP_RETIRE_VOUCHER_KEY_VERSION=<version> npm run keys:retire:verify` หรือ
`QUESTSHOP_RETIRE_BACKUP_KEY_VERSION=<version> npm run keys:retire:verify` คำสั่งนี้ไม่แก้ Secret เอง
เพื่อป้องกันการลบ Key ที่ยังมีข้อมูลหรือรายการ Review อ้างอิงอยู่

## Health endpoints

```bash
curl http://127.0.0.1:3000/livez
curl http://127.0.0.1:3000/readyz
STATUS_TOKEN=$(node --env-file=.env -e "process.stdout.write(process.env.STATUS_TOKEN)")
curl -H "Authorization: Bearer $STATUS_TOKEN" http://127.0.0.1:3000/statusz
```

- `/livez`: Process ยังตอบสนอง
- `/readyz`: Config, Schema, Database, Discord และ Runtime lease พร้อม
- `/statusz`: รายละเอียด Worker, Queue, Backup และ Incident; ต้องใช้ Bearer token

## ติดตั้ง Discord surfaces

คำสั่งต่อไปนี้ใช้ได้เฉพาะ `OWNER_ID` และมี option `channel` หากไม่ระบุจะใช้ห้องปัจจุบัน:

| คำสั่ง | Surface |
|---|---|
| `/quest-auto` | หน้าร้านสำหรับเริ่ม Quest และเติมเงิน |
| `/quest-new` | ห้องประกาศ Quest ใหม่ |
| `/quest-history` | ประวัติและ Progress ราย Quest |
| `/admin-panel` | แผงควบคุม Owner/Admin |
| `/log-payments` | Log การเติมเงินและลิงก์ซองเต็ม; ต้องเป็นห้องลับ |
| `/log-quest-operations` | Discovery, Test, Queue, Runner และ Settlement |
| `/log-admin` | Append-only Admin audit |
| `/log-system` | Incident และ Recovery เท่านั้น |

เรียกคำสั่งซ้ำจะ Update/Move surface เดิม ไม่ควรสร้าง Panel ที่ใช้งานได้ซ้ำหลายชุด Persistent components
ถูก Route จาก Server-side session และกลับมาทำงานหลัง Restart

## เปิดร้านครั้งแรก

Feature gates ทุกตัวเริ่มต้นเป็น `false`:

1. ติดตั้ง Surface และตรวจว่าห้อง Log เป็นห้องลับจริง
2. ตั้ง Admin role, Branding/GIF, Receiver, Monitor, ราคา และ Promotion
3. ใช้ปุ่ม **เช็คระบบ Token** ตรวจ Monitor ทุกบัญชี
4. รัน Automated verification และบันทึก Git SHA
5. ทำ [Pre-launch UAT](docs/uat/prelaunch.md) พร้อม
   [evidence template](docs/uat/evidence-template.md)
6. ทดสอบ TrueMoney จริงยอดต่ำ, Quest จริง, Restart recovery, Backup และ Restore drill
7. ปิดรอบทดสอบด้วย Compensating transactions:

```bash
CONFIRM_PRELAUNCH_CLOSEOUT=I_UNDERSTAND_COMPENSATING_TRANSACTIONS npm run prelaunch:closeout
```

8. Owner เปิด Gates ทีละส่วนตามลำดับใน UAT document ห้ามเปิดทุก Gate พร้อมกัน

## Verification

Automated integration tests ต้องใช้ PostgreSQL disposable database และจะ Fail ชัดเจนถ้าไม่ได้กำหนด URL:

```bash
export TEST_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/questshop_ci
npm run verify
```

คำสั่งแยก:

```bash
npm run check
npm run lint
npm run test:unit
npm run test:integration
```

Load test ใช้ฐานข้อมูลที่ทิ้งได้และชื่อฐานข้อมูลต้องมี `questshop_loadtest`:

```bash
LOAD_TEST_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/questshop_loadtest npm run load:test
```

CI ตรวจ Syntax, ESLint, PostgreSQL tests, 2× capacity load test, `npm audit` และ Docker build

## Backup และ Restore

ค่าเริ่มต้นของ Questshop คือ Aiven-managed backup: ระบบบอทไม่สร้างไฟล์ Backup เอง และหน้า Admin จะแสดง
สถานะนี้อย่างชัดเจน การกู้คืนต้องทำผ่าน Aiven Console ตามขีดจำกัดของแผนที่ใช้งาน

คำสั่งด้านล่างมีไว้เฉพาะ `BACKUP_MODE=LOCAL_S3`:

```bash
npm run backup
npm run backup:reconcile
npm run restore:drill
```

Backup ใช้ `pg_dump --format=custom` แบบ streaming → QSBK1 AES-256-GCM → S3 multipart upload → checksum/
manifest verification ส่วน Restore drill สร้างฐานข้อมูลชั่วคราว ตรวจ Schema, Wallet/Ledger, Reservation,
Payment, Queue, Outbox และ Crypto แล้วลบฐานข้อมูลชั่วคราว

หาก Pre-migration backup อัปโหลดสำเร็จแต่ Migration ล้มก่อนบันทึกใน PostgreSQL ให้ Owner ใช้
`npm run backup:reconcile` จาก deployment/DR environment เพื่ออ่าน Manifest ที่ยืนยันแล้วบน S3 กลับเข้า
`backup_runs` ก่อน Restore drill; Runtime bot ปกติไม่มี Restore credential.

ใน Aiven-managed mode Migration จะมี Audit ว่าไม่ได้สร้าง Local backup; จึงห้ามตีความว่า Questshop
ยืนยันความพร้อมกู้คืนของ Aiven แล้ว

## ขอบเขต v1

ไม่มี Web dashboard, Redis, Multi-guild, Automatic Claim, Customer cancellation, Customer dispute button,
Wallet transfer/withdrawal, ช่องทางเติมเงินอื่น หรือ Automated TrueMoney reconciliation ใน v1

TrueMoney Direct เป็น Integration ที่ไม่มี Contract รับประกัน หาก Response/schema/receiver/amount ยืนยันไม่ได้
ระบบต้องไม่ Credit และจะเปิด Circuit breaker/Manual Review ตามความเหมาะสม

## ความปลอดภัย

อ่าน [SECURITY.md](SECURITY.md) ก่อน Deploy หรือรายงานช่องโหว่ โดยเฉพาะ:

- ห้ามเปิด Public issue ที่มี Token, Voucher URL เต็ม, Database URL หรือ Key material
- `log-payments` เป็น Surface เดียวที่อนุญาตลิงก์ซองเต็ม และต้องเป็นห้องลับ
- Ambiguous payment ให้ Owner ตรวจจาก TrueMoney app; ห้าม Blind retry
- Financial/Audit DLQ ห้าม Discard
- Runtime Permission Drift auto-repair ถูกถอดตามนโยบาย Owner; การแก้ Discord permission ทำด้วย Owner เอง

## สถานะ Release

Package version ปัจจุบันคือ `0.1.0` แต่ยังไม่มีหลักฐาน Production release ที่ผ่าน Live boundaries ครบ
ดูการเปลี่ยนแปลงที่ [CHANGELOG.md](CHANGELOG.md) และห้ามใช้คำว่า Production-ready ก่อนผ่าน
[Definition of Done](docs/architecture/definition-of-done.md) บน SHA เดียวกัน

# Questshop

Questshop คือบอท Discord สำหรับรับทำ Discord Quest อัตโนมัติใน Discord Guild เดียว ลูกค้าเติมเครดิต
ด้วย TrueMoney Gift, ส่ง Token ของบัญชี Quest, เลือก Quest ได้หลายรายการ และติดตามสถานะงานผ่าน Discord
โดยไม่ต้องมีเว็บไซต์แยก

ระบบเก็บ Wallet, Ledger, Payment, Order, Runner, Lease, Outbox, Manual Review และ Audit ลง PostgreSQL 16+
จึงกู้สถานะงานต่อหลัง Process restart ได้ ไม่พึ่งข้อมูลใน memory เพียงอย่างเดียว

> [!WARNING]
> Quest Engine ใช้ Discord user token/Self-bot behavior ซึ่งอาจขัดเงื่อนไขของ Discord และทำให้บัญชีถูกจำกัด
> หรือปิดได้ เจ้าของระบบต้องยอมรับและทบทวนความเสี่ยงนี้เองก่อนใช้งาน

> [!IMPORTANT]
> สถานะ source ปัจจุบันคือ **implemented-but-unverified** การที่บอทขึ้น `Questshop ready` หรือ test ผ่าน
> ไม่ใช่หลักฐานว่า TrueMoney, Discord Quest, Monitor token หรือการเปิดร้านจริงผ่านครบแล้ว ต้องทำ UAT
> บน Git SHA เดียวกันตาม [Pre-launch UAT](docs/uat/prelaunch.md) ก่อนถือว่าใช้งานจริงได้

## ภาพรวมสิ่งที่ระบบทำ

- `quest-auto` เป็นหน้าร้านถาวร มีปุ่ม **เริ่มทำเควส** และ **เติมเงิน**
- Checkout เป็น Ephemeral: ตรวจ Token, โหลด Quest, เลือกหลายรายการ, สร้าง Quote และยืนยันออเดอร์
- Wallet เก็บเป็นจำนวนเต็มหน่วยสตางค์ แยกยอด `available` และ `reserved` ไม่มีถอนหรือโอนเครดิต
- ยืนยันออเดอร์แล้วจองเงินแยกต่อ Quest; สำเร็จจึง Capture, ล้มเหลวแน่ชัดจึง Release คืน Wallet
- TrueMoney Gift มี Voucher HMAC, Receiver snapshot, Promotion และ Owner-only Manual Review เมื่อผลไม่ชัดเจน
- Queue มี fairness, lease, fencing token, durable mutation checkpoint และ restart recovery
- Runner รองรับ Video และ Desktop Quest ตาม Executor registry; ไม่มี Automatic Claim
- `quest-new` และประวัติ Quest แก้ข้อความเดิมแทนการส่ง spam; Progress ที่เห็นเป็น `0/25/50/75/100%`
- DM ปิดออเดอร์มี **รับรางวัลทั้งหมด** ไปยัง Quest สำเร็จรายการแรก และ **ดูประวัติ Quest ทั้งหมด**
- Admin panel เหลือ 9 หมวดที่ใช้จริง: ภาพรวม, ราคาทำ Quest, โบนัสเติมเงิน, งานและคิว,
  เติมเงินที่ต้องตรวจ, ปรับเครดิต/คืนเงิน, Monitor, เบอร์รับเงิน และปัญหาที่ต้องจัดการ
- Outbox/DLQ ทำให้การส่งข้อความ Discord กู้ต่อได้หลัง restart
- มี HTTP health endpoints: `/livez`, `/readyz`, `/statusz`

## กฎธุรกิจสำคัญ

### เงิน

```text
ลูกค้ายืนยัน Order
→ Available ลด / Reserved เพิ่ม แยกต่อ Order Item
→ Quest สำเร็จและยืนยันจาก server แล้ว: Capture เต็มราคา snapshot
→ ล้มเหลวแน่ชัด, หมดอายุก่อนเริ่ม หรือเสร็จจากภายนอก: Release คืน Wallet
→ ผลไม่ชัดเจน: คง Reserved และเปิด Manual Review
```

- Refund คืนเป็น Wallet credit เท่านั้นและไม่มีวันหมดอายุ
- Wallet ห้ามติดลบ และ Ledger/Admin audit เป็น append-only
- การแก้ยอดต้องเป็น compensating transaction พร้อมเหตุผล, ผู้กระทำ, Correlation ID และ Audit
- Timeout หลังส่งคำขอ TrueMoney หรือ Quest mutation อาจเกิดผลแล้ว จึงห้าม blind retry

### Quest, Monitor และ Token

- Monitor ทุกบัญชีทำทั้ง Scan และ Test โดยไม่มี capability ให้เลือก
- Quest ที่ Monitor พบจะเป็นข้อมูลหลังบ้านจน Monitor อย่างน้อยหนึ่งบัญชีทดสอบผ่าน หรือ Admin กด
  **ส่งเลย** แบบมี Audit
- ระบบลอง Monitor เดิมได้สูงสุด 3 ครั้ง แล้วเปลี่ยน Monitor ตัวถัดไป; หยุดทันทีเมื่อมีหนึ่งบัญชีผ่าน
- Quest ที่พบจาก Token ลูกค้าอาจแสดงให้บัญชีนั้นเลือกได้ตาม Checkout policy แม้ Monitor ไม่พบ
- Customer token ใช้เฉพาะ session/order, เข้ารหัส AES-256-GCM และลบเมื่อหมดหน้าที่
- Monitor token เข้ารหัสและไม่มีทางให้ Admin เปิดอ่านค่า plaintext
- Quest account เดียวมี active job ซ้อนไม่ได้ทั่วระบบ แม้ผู้ซื้อคนละคน
- งานเสร็จที่ `READY_TO_CLAIM`; ลูกค้าเป็นผู้กดรับรางวัลเองเสมอ

### ราคาและโบนัส

- ราคาเริ่มต้นของ Quest เล่นเกมและ Quest ดูวิดีโอคือ **5.00 บาท** ต่อ Quest (500 สตางค์)
- แอดมินเปลี่ยนราคาได้ทีละประเภทเท่านั้น; ไม่มีราคาเฉพาะ Quest, ราคาชั่วคราว หรือวันเริ่ม/จบให้ต้องจัดการ
- โบนัสเติมเงินตั้งเป็น Tier เช่น `100=10, 300=15`; ใช้จนกว่าแอดมินจะปิดหรือแก้เป็นรุ่นใหม่
- ระบบยังบังคับเพดานจำนวนใช้ต่อผู้ใช้และโบนัสต่อวันตามค่าที่แอดมินกำหนด

## โครงสร้างระบบ

```text
Discord Gateway
    │
    ├── Interaction router ──► Domain services ──► PostgreSQL 16+
    │                               │                    │
    │                               ├─ Wallet/Ledger      ├─ Durable state
    │                               ├─ Payments           ├─ Queue/Lease/Fencing
    │                               ├─ Catalog/Pricing    ├─ Outbox/DLQ
    │                               ├─ Checkout/Orders    └─ Audit/Reviews
    │                               └─ Runner
    │
    ├── Payment / Runner / Outbox workers
    ├── Discovery / Quest test / Maintenance workers
    └── HTTP health server
```

Runtime เป็น all-in-one process แต่ ownership และ state สำคัญอยู่ใน PostgreSQL จึงรองรับ restart ได้

## ข้อกำหนด

- Node.js `>=22.22.0 <23` (inwcloud เลือก Node 22.x LTS)
- PostgreSQL 16+; production URL ต้องมี `sslmode=verify-full`
- Discord application/bot, Discord Guild เดียว และ Bot ต้องมี `Administrator`
- Aiven PostgreSQL หรือ Managed PostgreSQL ที่สร้าง role แยกได้
- `npm` และไฟล์ `package-lock.json` ของ repository

Dependencies ถูก pin ใน [package.json](package.json): `discord.js 14.27.0`, `pg 8.22.0`, `zod 4.4.3`,
`uuid 14.0.1` และ `pino 10.3.1`

## Environment Variables

ห้าม commit `.env` หรือส่งค่าจริงลง Discord, issue, PR, log หรือ screenshot

### ค่าที่ต้องมีตอน deploy บน inwcloud

| Variable | ใช้ทำอะไร | หมายเหตุ |
|---|---|---|
| `NODE_ENV` | ระบุ environment | Production ใช้ `production` |
| `DISCORD_BOT_TOKEN` | Login bot และ register commands | Secret |
| `DISCORD_CLIENT_ID` | Discord Application ID | Snowflake |
| `DISCORD_GUILD_ID` | Guild เดียวที่บอททำงาน | Snowflake |
| `OWNER_ID` | Discord User ID ของ Owner | Snowflake |
| `DATABASE_POOL_URL` | URL ของ role `questshop_runtime` | ต้องมี `sslmode=verify-full` |
| `DATABASE_DIRECT_URL` | URL ของ role `questshop_migrator` | ต้องมี `sslmode=verify-full`; ต้องใช้ตอน `npm run deploy` |
| `DATABASE_SSL_CA_BASE64` | CA certificate ของ Aiven แบบ Base64 | ใส่เมื่อ certificate ไม่ได้ chain ไป Node trusted root |
| `STATUS_TOKEN` | Bearer token ของ `/statusz` | Secret อย่างน้อย 32 ตัวอักษร |
| `DATA_ENCRYPTION_KEYS_JSON` | Keyring เข้ารหัส Token/credential | Secret JSON ที่ `npm run setup` สร้างได้ |
| `VOUCHER_HMAC_KEYS_JSON` | Keyring HMAC สำหรับ Voucher | Secret JSON ที่ `npm run setup` สร้างได้ |
| `BACKUP_MODE` | นโยบาย backup | สำหรับ Aiven ใช้ `AIVEN_MANAGED` |
| `GIT_SHA` | SHA เต็ม 40 ตัวของ source ที่กำลัง deploy | Production บังคับรูปแบบนี้ |

ค่าที่กำหนดไว้แล้วแต่ปรับได้:

| Variable | ค่า/ความหมาย |
|---|---|
| `PRELAUNCH` | `true` เพื่อจำกัดเส้นทางลูกค้าระหว่าง UAT; อย่าเปิดร้านเพียงเพราะบอท start ได้ |
| `TIMEZONE` | ค่าเริ่มต้นและค่าที่รองรับคือ `Asia/Bangkok` |
| `RUNNER_CONCURRENCY` | จำนวน Runner พร้อมกัน; ค่าเริ่มต้น `2` |
| `RUNNER_CONCURRENCY_HARD_MAX` | เพดาน Runner; สูงสุด `5` |
| `PORT` | HTTP health server; ค่าเริ่มต้น `3000` |

`BACKUP_MODE=AIVEN_MANAGED` หมายถึง Aiven เป็นเจ้าของ backup/recovery ของฐานข้อมูล Questshop จะไม่พยายาม
เรียก `pg_dump`, `pg_restore` หรือ S3 ใน inwcloud. โหมด `LOCAL_S3` เป็น compatibility mode และต้องมี
credentials/backup configuration เพิ่มครบชุด; อย่าเปิดโดยไม่ได้วางแผน restore ไว้ก่อน

> [!NOTE]
> โค้ดปัจจุบันอ่าน `DATABASE_SSL_CA_BASE64` โดยตรงแล้ว ไม่ต้องสร้าง `/tmp/aiven-ca.pem` และไม่ต้องตั้ง
> `NODE_EXTRA_CA_CERTS`. URL ต้นฉบับยังต้องเป็น `sslmode=verify-full`; ระบบจะลบเฉพาะ SSL query parameters
> จาก URL สำเนาที่ส่งเข้า `pg` เพื่อป้องกันไม่ให้ CA explicit ถูก override

## PostgreSQL roles ที่ต้องเตรียมครั้งเดียว

ผู้ดูแล Aiven/ฐานข้อมูลต้องสร้างและให้สิทธิ์ก่อน deploy:

| Role | ใช้โดย | สิทธิ์บน `public` |
|---|---|---|
| `questshop_migrator` | `DATABASE_DIRECT_URL` ระหว่าง deploy | `USAGE, CREATE` |
| `questshop_runtime` | `DATABASE_POOL_URL` ระหว่างบอทรัน | `USAGE` เท่านั้น, ไม่มี `CREATE` |

Role ต้องเป็นคนละตัวกัน ห้ามนำ `DATABASE_POOL_URL` ไปใส่เป็น `DATABASE_DIRECT_URL` เพราะ migration จะ fail-closed
ถ้า migrator และ runtime เป็น role เดียวกัน

หลัง migration ทุกครั้ง Questshop จะ sync object privileges แม้ `applied: 0`:

- ตารางทั่วไป: Runtime อ่าน/เขียนได้ตาม domain ต้องใช้
- `wallet_transactions`, `admin_audit_logs`, `release_evidence`: Runtime ได้เพียง `SELECT, INSERT`
- `schema_migrations`, `crypto_key_sentinels`: Runtime อ่านอย่างเดียว
- Runtime ไม่มี DDL และมีสิทธิ์ execute เฉพาะ retention functions ที่ allowlist

รายละเอียด provisioning อยู่ที่ [PostgreSQL role contract](docs/architecture/postgresql-roles.md)

## เริ่มต้นบนเครื่องพัฒนา

1. ติดตั้ง Node 22 และ PostgreSQL 16 ที่เป็นฐานข้อมูล disposable สำหรับ test
2. Clone repository และติดตั้ง dependencies

```bash
npm ci
```

3. คัดลอก [.env.example](.env.example) เป็น `.env` แล้วรัน setup แบบ interactive

```bash
npm run setup
```

คำสั่งนี้ถาม Discord IDs/Token, Runtime URL, Direct/Migrator URL และ CA ถ้าจำเป็น จากนั้นสร้าง
`STATUS_TOKEN`, Data encryption keyring และ Voucher HMAC keyring เพียงครั้งเดียวใน `.env` permission `0600`.
อย่ารัน setup เพื่อหวังให้มันหมุน key ใหม่; การ rotate เป็น workflow แยก

4. ตรวจและ deploy schema/commands แล้วเปิด runtime

```bash
npm run deploy
npm run db:verify-roles
npm run setup:preflight
npm start
```

`npm run deploy` เท่ากับ `setup:verify → migrate → register` และเป็นคำสั่งเดียวที่ควรรับผิดชอบ migration
กับการลงทะเบียน command. `npm start` ไม่ migrate และใช้ Runtime credential เท่านั้น

## รันบน inwcloud + Aiven

1. ตั้ง Runtime เป็น **Node.js 22.x LTS**
2. ตั้ง Environment Variables ตามตารางด้านบน โดยเก็บ secret ในหน้า Environment Variables ของ inwcloud
3. ตั้ง repository/branch ให้ตรง SHA ที่ต้องการ deploy และใส่ SHA เต็มนั้นลง `GIT_SHA`
4. ใช้ Custom Command นี้:

```bash
npm ci --omit=dev && npm run deploy && npm start
```

5. บันทึกค่าและ restart หนึ่งครั้ง

ผลลัพธ์ที่ควรเห็นตามลำดับ:

```text
setup:verify  → {"ok":true,...}
migrate       → privilegeSynchronization: { status: 'PASS', ... }
register      → Registered 8 guild commands
start         → Questshop ready
```

`migration.applied: 0` เป็นเรื่องปกติเมื่อ schema ล่าสุดอยู่แล้ว และยังต้องเห็น
`privilegeSynchronization.status: 'PASS'` เพราะระบบตรวจ/sync privilege ทุก deploy

หากพบ error เหล่านี้:

| ข้อความ | สาเหตุและวิธีแก้ |
|---|---|
| `DATABASE_DIRECT_URL ... undefined` | ยังไม่ได้ตั้ง Migrator URL; เพิ่ม `DATABASE_DIRECT_URL` ที่เป็น role แยก |
| `POSTGRES_RUNTIME_ROLE_CONTRACT_FAILED` | Runtime มีสิทธิ์เกิน policy; รัน `npm run deploy` ด้วย Migrator role ที่ถูกต้อง แล้วตรวจ Aiven provisioning |
| `GIT_SHA must be the 40-character...` | ใส่ SHA เต็มของ revision ที่ inwcloud deploy จริง |
| `Questshop bot must have Discord Administrator permission` | เพิ่ม Administrator ให้ bot แล้ว restart |
| `Questshop startup failed` หลัง `register` | ดู error code ใน log; command registration สำเร็จไม่ได้แปลว่า runtime/database พร้อม |

อย่าตั้ง command แบบสร้างไฟล์ CA ชั่วคราวหรือ `NODE_EXTRA_CA_CERTS` สำหรับ source รุ่นปัจจุบัน

## Discord commands ที่ลงทะเบียน

Owner ใช้คำสั่งเหล่านี้เพื่อติดตั้งหรือย้ายข้อความถาวรไปยังห้องที่ระบุ (ไม่ระบุ `channel` จะใช้ห้องปัจจุบัน):

```text
/quest-auto
/quest-new
/quest-history
/admin-panel
/log-payments
/log-quest-operations
/log-admin
/log-system
```

การเรียกซ้ำจะ update/move Surface เดิม ไม่ควรสร้าง panel ที่ใช้งานซ้อนกัน

> [!CAUTION]
> Owner เลือกให้นำ runtime privacy/permission-drift check ออกแล้ว รวมถึงไม่มี preflight ตรวจสิทธิ์มนุษย์ก่อน
> ส่ง Payment Log. `LOG_PAYMENTS` อาจมี full voucher link ตาม policy ของ Owner ดังนั้น **Owner ต้องตั้งห้อง
> หลังบ้านให้ถูกต้องเอง** และต้องไม่เปิดให้บุคคลที่ไม่เกี่ยวข้องเห็น Bot จะบันทึก Discord 403 เป็น incident
> แต่จะไม่แก้ permission หรือปิด surface ให้อัตโนมัติ

## Health endpoints

Health server ฟังที่ `PORT` (ค่าเริ่มต้น `3000`):

| Path | ต้องใช้ token | ความหมาย |
|---|---|---|
| `/livez` | ไม่ต้อง | Process ยังตอบได้ |
| `/readyz` | ไม่ต้อง | DB, schema, Discord และ runtime lease พร้อมหรือไม่ |
| `/statusz` | ต้องใช้ | รายละเอียด workers/gates/incidents แบบจำกัด |

ตัวอย่าง `/statusz`:

```bash
curl -H 'Authorization: Bearer YOUR_STATUS_TOKEN' http://127.0.0.1:3000/statusz
```

อย่าใส่ `STATUS_TOKEN` ลง shell history, ticket หรือ screenshot. หากเปิด Domain ใน inwcloud ให้ map Domain
มายัง `PORT` เดียวกับ health server

## การทดสอบ source

`TEST_DATABASE_URL` ต้องชี้ไป PostgreSQL 16 ที่ทิ้งได้เท่านั้น และชื่อฐานข้อมูลต้องเข้ากับ guard ของ project
เช่น `questshop_ci` หรือ `questshop_test`; test จะ reset schema `public`

```bash
npm run check
npm run lint
TEST_DATABASE_URL='postgresql://.../questshop_test' \
QUESTSHOP_ALLOW_TEST_DATABASE_RESET=true npm test
git diff --check
```

Full verification ใช้ coverage และ load test เพิ่ม:

```bash
TEST_DATABASE_URL='postgresql://.../questshop_ci' \
QUESTSHOP_ALLOW_TEST_DATABASE_RESET=true npm run test:coverage

LOAD_TEST_DATABASE_URL='postgresql://.../questshop_loadtest' npm run load:test
npm audit --audit-level=high
docker build -t questshop:local .
```

ห้ามชี้ `TEST_DATABASE_URL` หรือ `LOAD_TEST_DATABASE_URL` ไปฐานข้อมูล Aiven/Production

## เอกสารอ้างอิง

- [Architecture](docs/architecture/system.md)
- [Completion audit](docs/architecture/completion-audit.md)
- [Deploy on inwcloud + Aiven](docs/deployment/inwcloud-aiven.md)
- [PostgreSQL role contract](docs/architecture/postgresql-roles.md)
- [State-machine contracts](docs/state-machines/contracts.md)
- [Runbooks](docs/runbooks/README.md)
- [Pre-launch UAT](docs/uat/prelaunch.md)
- [Security policy](SECURITY.md)
- [Engineering contract](AGENTS.md)

## ขอบเขตที่ยังต้องพิสูจน์ใน Live environment

- Discord desktop/mobile, setup panels, persistent components และ Gateway/REST failure handling
- TrueMoney success, ambiguous-after-send และ provider schema drift ด้วยหลักฐานจริง
- Video/Desktop Quest execution และผลของ Monitor token จริง
- Aiven TLS/role provisioning, restart recovery และ health endpoint ผ่าน inwcloud
- Owner pre-launch closeout, Admin UX และการกู้ incident เฉพาะส่วนที่ระบบปิดตัวเอง

ห้ามเรียกโปรเจกต์นี้ว่า production-ready ก่อนหลักฐานทั้งหมดข้างต้นอยู่บน Git SHA เดียวกัน

# Deploy Questshop on inwcloud + Aiven PostgreSQL

คู่มือนี้ใช้สำหรับ source ปัจจุบันของ Questshop บนกิ่ง/commit ที่คุณเลือก deploy เท่านั้น ไม่ทดสอบ
TrueMoney จริง และไม่ทำให้ระบบเป็น production-ready โดยอัตโนมัติ ระบบปกติเริ่มทำงานอัตโนมัติ;
เฉพาะ incident brake ที่เกิดจากความผิดปกติเท่านั้นที่คงปิดไว้จนผ่านการกู้เฉพาะจุด

## สิ่งที่ต้องมี

- inwcloud project ที่ดึง repository และ branch/commit ที่ต้องการได้
- Runtime **Node.js 22.x LTS**
- Aiven PostgreSQL 16+ และ CA certificate ถ้า Aiven service ใช้ private CA
- Discord bot อยู่ใน Guild เป้าหมายและมีสิทธิ์ `Administrator`
- PostgreSQL roles ที่แยกกันแล้ว:
  - `questshop_migrator`: ใช้ migration, มี `USAGE, CREATE` บน schema `public`
  - `questshop_runtime`: ใช้บอทตอนทำงาน, มี `USAGE` บน `public` และไม่มี `CREATE`

Aiven/Admin เป็นผู้รับผิดชอบการสร้าง role, `CONNECT`, role membership และ schema grants. Questshop จะจัดการ
เฉพาะ object privileges ที่ Migrator เป็นเจ้าของหลัง migration เท่านั้น ดูรายละเอียดที่
[PostgreSQL role contract](../architecture/postgresql-roles.md)

> [!CAUTION]
> `questshop_migrator` กับ `questshop_runtime` ต้องเป็นคนละ role. อย่าใช้ URL เดียวกันทั้ง
> `DATABASE_DIRECT_URL` และ `DATABASE_POOL_URL`; deployment จะ fail-closed ตาม design

## 1. เลือก source และ Git SHA

1. เลือก branch/commit ที่ต้องการใน inwcloud
2. หา SHA เต็ม 40 ตัวของ commit นั้นจาก GitHub หรือ local Git:

```bash
git rev-parse HEAD
```

3. ตั้งค่า `GIT_SHA` ให้ตรงกับ SHA เดียวกันทุกตัวอักษร

ใน production ระบบปฏิเสธ SHA ที่ไม่ครบ 40 ตัว เพื่อให้ log, migration audit และ UAT ผูกกับ revision จริงได้

## 2. ตั้ง Project Runtime

ในหน้า Project Settings ของ inwcloud:

- Programming language: **Node.js**
- Version: **Node.js 22.x (LTS)**
- Run mode: **Custom Command**
- Custom Command:

```bash
npm ci --omit=dev && npm run deploy && npm start
```

คำสั่งนี้ตั้งใจให้รันทุกครั้งที่ inwcloud start/restart:

```text
npm ci --omit=dev
→ npm run deploy
  → npm run setup:verify
  → npm run migrate
  → npm run register
→ npm start
```

แม้ไม่มี migration ใหม่ (`applied: 0`) ก็ยังต้องรัน `npm run migrate` เพราะมัน synchronize และตรวจ
PostgreSQL object privileges ทุก deploy. อย่าแทนคำสั่งนี้ด้วย `npm start` หรือ `npm run register && npm start`

## 3. ตั้ง Environment Variables

ใส่ค่าทั้งหมดในหน้า Environment Variables/Secrets ของ inwcloud ไม่ใส่ใน repository, command หรือ log

| Variable | ค่า/หน้าที่ |
|---|---|
| `NODE_ENV` | `production` |
| `DISCORD_BOT_TOKEN` | Bot token จาก Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID ของ Discord |
| `DISCORD_GUILD_ID` | Server ID ของ Guild เป้าหมาย |
| `OWNER_ID` | Discord User ID ของ Owner |
| `DATABASE_POOL_URL` | URL ของ `questshop_runtime`, มี `sslmode=verify-full` |
| `DATABASE_DIRECT_URL` | URL ของ `questshop_migrator`, มี `sslmode=verify-full` |
| `DATABASE_SSL_CA_BASE64` | CA PEM ของ Aiven ที่ Base64 แล้ว; ใส่เมื่อ Aiven CA ไม่ได้อยู่ใน Node trust store |
| `STATUS_TOKEN` | Token สำหรับเรียก `/statusz`, ยาวอย่างน้อย 32 ตัวอักษร |
| `DATA_ENCRYPTION_KEYS_JSON` | JSON keyring เข้ารหัส credential |
| `VOUCHER_HMAC_KEYS_JSON` | JSON keyring HMAC สำหรับ voucher identity |
| `BACKUP_MODE` | `AIVEN_MANAGED` |
| `GIT_SHA` | SHA เต็ม 40 ตัวของ source ที่กำลัง deploy |

ค่าที่แนะนำในช่วง pre-launch:

| Variable | ค่า |
|---|---|
| `PRELAUNCH` | `true` |
| `TIMEZONE` | `Asia/Bangkok` |
| `RUNNER_CONCURRENCY` | `2` |
| `RUNNER_CONCURRENCY_HARD_MAX` | `5` |
| `PORT` | `3000` หรือ port ที่จะ map Domain ของ inwcloud |

### TLS ของ Aiven

URL ทั้งสองต้องคง `sslmode=verify-full` เช่น:

```text
postgresql://questshop_runtime:<PASSWORD>@<AIVEN_HOST>:<PORT>/<DATABASE>?sslmode=verify-full
```

เมื่อจำเป็นต้องใช้ CA ให้แปลง **ไฟล์ PEM ทั้งไฟล์** เป็น Base64 แล้วใส่ผลลัพธ์ลง
`DATABASE_SSL_CA_BASE64`. อย่าใส่ private key และอย่า paste certificate ลง log

Questshop จะ decode CA ใน process และส่งเข้า `pg` โดยตรงพร้อม `rejectUnauthorized: true`. สำหรับ source รุ่นนี้
**ห้ามเพิ่ม workaround เก่า** ต่อไปนี้ใน Custom Command:

```bash
# ไม่ต้องใช้ และไม่ควรใส่
node -e "...writeFileSync('/tmp/aiven-ca.pem', ...)"
export NODE_EXTRA_CA_CERTS=/tmp/aiven-ca.pem
```

ระบบจะลบเฉพาะ SSL query parameters จาก URL สำเนาที่ส่งให้ `pg`; URL ต้นฉบับยังผ่าน validation
`sslmode=verify-full` อยู่เสมอ

### Keyrings และ Status Token

หากมี terminal แบบ interactive บนเครื่องที่ปลอดภัย สามารถให้ Questshop สร้างค่าเริ่มต้นครั้งแรกได้:

```bash
npm ci
npm run setup
```

จากนั้นย้าย `STATUS_TOKEN`, `DATA_ENCRYPTION_KEYS_JSON` และ `VOUCHER_HMAC_KEYS_JSON` ไปเก็บใน inwcloud
Environment Variables. เก็บค่าเดิมให้คงที่ทุก redeploy; ห้ามสุ่มค่าใหม่เพียงเพื่อแก้ startup error เพราะข้อมูล
Token/Voucher ที่เข้ารหัสอยู่เดิมอาจถอดไม่ได้

## 4. Domain และ health endpoint

Questshop เปิด HTTP server ที่ `PORT` เพื่อใช้ health endpoint:

| Path | Authorization | ผลที่ควรได้ |
|---|---|---|
| `/livez` | ไม่ต้อง | `200` เมื่อ process ยังตอบได้ |
| `/readyz` | ไม่ต้อง | `200` เมื่อ runtime พร้อมรับงาน; `503` ระหว่าง startup/incident |
| `/statusz` | `Bearer STATUS_TOKEN` | สถานะ workers, gates, incidents แบบจำกัด |

ถ้าต้องการ inwcloud Domain ให้ map internal port ให้ตรงกับ `PORT` เช่น `3000`. Domain นี้มีไว้ดู health ไม่ใช่
web dashboard และไม่ควรเผย `/statusz` token

ตัวอย่างทดสอบจากเครื่องที่เข้าถึง Domain ได้:

```bash
curl https://YOUR_DOMAIN/livez
curl https://YOUR_DOMAIN/readyz
curl -H 'Authorization: Bearer YOUR_STATUS_TOKEN' https://YOUR_DOMAIN/statusz
```

## 5. อ่านผล deploy ที่ถูกต้อง

หลัง Save/Restart ให้ดู log ตามลำดับนี้:

```text
setup:verify
→ {"ok":true,"nodeEnv":"production",...}

migrate
→ migration: { current: <version>, applied: <number>, privilegeSynchronization: { status: 'PASS', ... } }
→ preMigrationBackup: 'AIVEN_MANAGED'

register
→ Registered 8 guild commands

start
→ Questshop ready
```

ความหมาย:

- `applied: 0` = schema อยู่ version ล่าสุดแล้ว เป็นผลปกติ
- `privilegeSynchronization.status: 'PASS'` = role/object privilege ที่ Questshop ตรวจผ่าน
- `Registered 8 guild commands` = ลงทะเบียนคำสั่ง Guild สำเร็จ แต่ไม่ใช่หลักฐานว่า panel ถูกติดตั้งแล้ว
- `Questshop ready` = DB/schema/Discord/runtime lease พร้อมสำหรับ process นี้ แต่ไม่ใช่การยืนยัน TrueMoney
  หรือ Quest execution จริง

หลังขึ้น ready แล้ว Owner จึงใช้คำสั่งติดตั้ง panel/log ใน Discord:

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

## 6. แก้ปัญหาที่พบบ่อย

| อาการใน log | ความหมาย | สิ่งที่ตรวจ |
|---|---|---|
| `DATABASE_DIRECT_URL ... undefined` | deploy ต้องใช้ Migrator URL แต่ยังไม่ตั้ง | เพิ่ม URL ของ `questshop_migrator` พร้อม `sslmode=verify-full` |
| `GIT_SHA must be the 40-character...` | SHA ไม่ครบหรือไม่ใช่ hexadecimal | คัดลอก commit SHA เต็มของ source ที่ inwcloud ดึงจริง |
| `POSTGRES_RUNTIME_ROLE_CONTRACT_FAILED` | Runtime ได้สิทธิ์ฐานข้อมูลเกิน policy | ยืนยันว่า Direct URL ใช้ migrator แยก, รัน deploy ใหม่; ถ้ายังไม่ผ่านให้ตรวจ Aiven bootstrap grants/membership |
| `Questshop bot must have Discord Administrator permission` | Discord bot ไม่มี Administrator | เพิ่มสิทธิ์ใน Discord แล้ว restart |
| Error TLS/CA | URL/CA ไม่ตรง Aiven certificate chain | URL ต้อง `sslmode=verify-full`; ตรวจ Base64 ของ CA และเอา `/tmp`/`NODE_EXTRA_CA_CERTS` workaround ออก |
| `Registered 8 guild commands` แล้ว process หยุด | register สำเร็จ แต่ startup ล้มในขั้นต่อไป | อ่าน error หลังบรรทัด `start`; มักเป็น env, role contract หรือ Discord permission |
| Log แสดง SHA เก่า | inwcloud ยังดึง source/branch เก่า หรือ `GIT_SHA` ไม่ตรง | เลือก branch/commit ใหม่ แล้วตั้ง `GIT_SHA` ให้ตรง SHA เต็ม |

ห้ามแก้ด้วยการให้ Runtime role มี `CREATE`, `UPDATE` หรือ `DELETE` เกิน policy และห้ามใช้ manual `GRANT`
อย่างถาวรเพื่อให้บอทเปิดผ่าน. ถ้า privilege sync fail ให้แก้ Aiven bootstrap ตาม role contract

## 7. Backup, restart และ rollback

### Aiven-managed backup

`BACKUP_MODE=AIVEN_MANAGED` คือ Aiven ดูแล backup/recovery. inwcloud ไม่ต้องมี `pg_dump`, `pg_restore`,
S3 credential หรือ `DATABASE_RESTORE_URL` สำหรับโหมดนี้. Questshop บันทึกเพียงนโยบาย deploy; ไม่ได้ยืนยันว่า
Aiven backup หรือ restore ผ่านจริงแทน Owner

### Restart

เมื่อ inwcloud restart ให้ใช้ Custom Command เดิมเสมอ. Migration อาจรายงาน `applied: 0` แต่ privilege sync
และ command registration ยังทำซ้ำได้แบบตั้งใจ

### Rollback

- ถ้า schema ยัง compatible ให้เปลี่ยน source กลับไป commit ที่ต้องการ และตั้ง `GIT_SHA` ให้ตรง แล้ว deploy ใหม่
- Questshop ไม่มี automatic down migration. หาก schema เดินหน้าแล้วแต่ app เก่ารองรับไม่ได้ ให้ทำ forward fix
  แทนการแก้/ลบ migration เก่า
- Database restore เป็นการกู้ภัยระดับ Aiven: ปิดร้าน, preserve หลักฐาน, กู้ผ่าน Aiven และ reconcile Ledger ก่อนเปิด
  Gate ใหม่

## 8. Owner responsibility for backoffice channels

Owner เลือกให้บอทไม่ตรวจ privacy/human visibility ของห้องหลังบ้าน และไม่ auto-repair Discord permission drift.
โดยเฉพาะ `LOG_PAYMENTS` อาจมี full voucher link. เจ้าของต้องตั้งห้องหลังบ้าน, สมาชิก, role และ Discord access
history เอง และต้องไม่เปิดห้องนั้นให้คนที่ไม่เกี่ยวข้อง

Discord 403 จะถูกบันทึกเป็น incident แต่บอทจะไม่แก้ permission หรือปิด surface ให้อัตโนมัติ

## 9. หลัง deploy แล้วทำอะไรต่อ

1. ตรวจ `/livez` และ `/readyz`
2. ตรวจ SHA ใน `Questshop ready` ให้ตรงกับ source ที่เลือก
3. Owner ติดตั้ง 8 surfaces ด้วย slash commands
4. ยืนยันว่า `PRELAUNCH=true`; ระบบปกติจะเปิดอัตโนมัติ แต่ลูกค้าทั่วไปยังถูกจำกัดโดย Pre-launch policy
5. ทำ [Pre-launch UAT](../uat/prelaunch.md) ตามลำดับบน SHA เดียวกัน
6. ทำ UAT ต่อตามรายการ; หากเกิด incident ให้ใช้การกู้เฉพาะส่วนนั้นจากหมวด “ปัญหาที่ต้องจัดการ”

การที่คู่มือนี้ deploy ผ่าน ไม่ได้ให้อำนาจเปิดร้าน, ทำ TrueMoney mutation จริง หรือยืนยันว่าระบบพร้อมใช้งานจริง

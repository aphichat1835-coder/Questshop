import https from 'node:https';
import { z } from 'zod';
import { parseBahtToCents } from '../../shared/money.js';
import { QuestshopError } from '../../shared/errors.js';

const VOUCHER_CODE = /^[A-Za-z0-9]{16,128}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_HOST = 'gift.truemoney.com';

const responseSchema = z.object({
  status: z.object({
    code: z.string(),
    message: z.string().optional(),
  }),
  data: z.object({
    my_ticket: z.object({
      amount_baht: z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,2})?$/),
      transaction_id: z.union([z.string(), z.number()]).optional(),
    }).optional(),
    owner_profile: z.object({
      full_name: z.string().optional(),
      mobile: z.string().optional(),
    }).optional(),
    voucher: z.object({
      member: z.number().int().optional(),
      available: z.number().int().optional(),
    }).optional(),
  }).optional(),
});

export function normalizeVoucherUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) {
    throw new QuestshopError('INVALID_VOUCHER_URL', 'รูปแบบลิงก์ซองไม่ถูกต้อง');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new QuestshopError('INVALID_VOUCHER_URL', 'รูปแบบลิงก์ซองไม่ถูกต้อง');
  }
  if (url.protocol !== 'https:' || url.hostname !== PROVIDER_HOST || !['/campaign', '/campaign/'].includes(url.pathname)) {
    throw new QuestshopError('INVALID_VOUCHER_URL', 'รองรับเฉพาะลิงก์ซอง TrueMoney ที่ถูกต้อง');
  }
  const params = [...url.searchParams.keys()];
  const code = url.searchParams.get('v');
  if (params.length !== 1 || params[0] !== 'v' || !VOUCHER_CODE.test(code ?? '')) {
    throw new QuestshopError('INVALID_VOUCHER_CODE', 'ไม่พบรหัสซองที่ถูกต้อง');
  }
  return { code, url: `https://${PROVIDER_HOST}/campaign/?v=${code}` };
}

function singleRecipientConfirmed(data) {
  return data?.voucher?.member === 1 || data?.voucher?.available === 1;
}

function mapProviderFailure(parsed, httpStatus) {
  const code = parsed?.status?.code ?? 'SCHEMA_INCOMPATIBLE';
  const terminal = {
    VOUCHER_OUT_OF_STOCK: 'ALREADY_REDEEMED',
    VOUCHER_EXPIRED: 'EXPIRED',
    VOUCHER_NOT_FOUND: 'INVALID',
    CANNOT_GET_OWN_VOUCHER: 'INVALID',
  }[code];
  if (terminal) return { outcome: terminal, providerCode: code, httpStatus };
  if (code === 'RATE_LIMIT') return { outcome: 'RETRY_WAIT', providerCode: code, httpStatus };
  return { outcome: 'AMBIGUOUS', providerCode: code, httpStatus };
}

export async function redeemVoucher({ code, receiverPhone, signal, onPossiblySent = () => {} }) {
  if (!VOUCHER_CODE.test(code)) throw new TypeError('invalid voucher code');
  if (!/^0\d{9}$/.test(receiverPhone)) throw new TypeError('invalid receiver phone');
  const body = Buffer.from(JSON.stringify({ mobile: receiverPhone, voucher_hash: code }));
  return new Promise((resolve, reject) => {
    let finished = false;
    let settled = false;
    let possiblySentPromise = Promise.resolve();
    const request = https.request({
      protocol: 'https:',
      hostname: PROVIDER_HOST,
      port: 443,
      path: `/campaign/vouchers/${encodeURIComponent(code)}/redeem`,
      method: 'POST',
      timeout: 15_000,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        origin: `https://${PROVIDER_HOST}`,
        referer: `https://${PROVIDER_HOST}/campaign/?v=${code}`,
        'user-agent': 'Questshop/1.0',
      },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new QuestshopError('PROVIDER_RESPONSE_TOO_LARGE', 'TrueMoney response exceeded limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', async () => {
        if (settled) return;
        settled = true;
        try { await possiblySentPromise; }
        catch (cause) {
          reject(new QuestshopError('PAYMENT_INTENT_CHECKPOINT_FAILED',
            'ไม่สามารถยืนยัน Payment intent checkpoint', { category: 'AMBIGUOUS', cause }));
          return;
        }
        let raw;
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (cause) {
          reject(new QuestshopError('PROVIDER_SCHEMA_INCOMPATIBLE', 'TrueMoney response is not valid JSON', {
            category: 'PROVIDER_SCHEMA', cause,
          }));
          return;
        }
        const parsed = responseSchema.safeParse(raw);
        if (!parsed.success) {
          reject(new QuestshopError('PROVIDER_SCHEMA_INCOMPATIBLE', 'TrueMoney response schema changed', {
            category: 'PROVIDER_SCHEMA', details: parsed.error.issues,
          }));
          return;
        }
        if (parsed.data.status.code !== 'SUCCESS') {
          resolve(mapProviderFailure(parsed.data, response.statusCode));
          return;
        }
        if (!parsed.data.data?.my_ticket || !singleRecipientConfirmed(parsed.data.data)) {
          reject(new QuestshopError('PROVIDER_CONFIRMATION_INCOMPLETE', 'Amount or single-recipient confirmation is missing', {
            category: 'PROVIDER_SCHEMA',
          }));
          return;
        }
        let amountCents;
        try {
          amountCents = parseBahtToCents(parsed.data.data.my_ticket.amount_baht);
        } catch (cause) {
          reject(new QuestshopError('PROVIDER_AMOUNT_INVALID', 'TrueMoney returned an invalid amount', {
            category: 'PROVIDER_SCHEMA', cause,
          }));
          return;
        }
        resolve({
          outcome: 'REDEEMED',
          amountCents,
          currency: 'THB',
          senderName: parsed.data.data.owner_profile?.full_name ?? null,
          senderPhone: parsed.data.data.owner_profile?.mobile ?? null,
          providerCode: 'SUCCESS',
          httpStatus: response.statusCode,
          receiverConfirmation: 'REQUEST_BOUND_SUCCESS',
          providerTransactionId: parsed.data.data.my_ticket.transaction_id == null
            ? null
            : String(parsed.data.data.my_ticket.transaction_id),
        });
      });
    });
    request.once('finish', () => {
      finished = true;
      possiblySentPromise = Promise.resolve(onPossiblySent());
      possiblySentPromise.catch((error) => request.destroy(error));
    });
    request.once('timeout', () => request.destroy(new Error('provider timeout')));
    request.once('error', (cause) => {
      if (settled) return;
      settled = true;
      reject(new QuestshopError(
        finished ? 'PROVIDER_RESULT_AMBIGUOUS' : 'PROVIDER_NOT_SENT',
        finished ? 'TrueMoney result is ambiguous after request dispatch' : 'TrueMoney request was not sent',
        { category: finished ? 'AMBIGUOUS' : 'NETWORK', retryable: !finished, cause },
      ));
    });
    if (signal) {
      const abort = () => request.destroy(new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    request.end(body);
  });
}

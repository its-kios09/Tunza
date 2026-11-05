import { cfg } from '../config';

export class PayPalError extends Error {
  constructor(public status: number, public body: any) {
    super(`PayPal ${status}: ${[body?.name, body?.message].filter(Boolean).join(' - ')}`);
  }
}

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const basic = Buffer.from(`${cfg.paypal.clientId}:${cfg.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${cfg.paypal.api}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const json: any = await res.json();
  if (!res.ok) throw new PayPalError(res.status, json);
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return cached.token;
}

// One payout per claim. senderBatchId = claim-<id>, so PayPal refuses a second payment for the same claim.
export async function sendPayout(p: {
  senderBatchId: string;
  receiver: string;
  amount: number;
  note: string;
  itemId: string;
}): Promise<{ batchId: string; status: string }> {
  const res = await fetch(`${cfg.paypal.api}/v1/payments/payouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: p.senderBatchId,
        email_subject: 'Tunza payment for verified care',
        email_message: p.note,
      },
      items: [{
        recipient_type: 'EMAIL',
        receiver: p.receiver,
        amount: { value: p.amount.toFixed(2), currency: 'USD' },
        note: p.note,
        sender_item_id: p.itemId,
      }],
    }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new PayPalError(res.status, json);
  return { batchId: json.batch_header.payout_batch_id, status: json.batch_header.batch_status };
}

import crypto from 'node:crypto';
import { cfg } from './config.js';
import { logMessage } from './store.js';

const base = () =>
  `https://graph.facebook.com/${cfg.wa.graphVersion}/${cfg.wa.phoneNumberId}/messages`;

// WhatsApp hard limits. Exceeding any of these makes the API reject the message.
const LIM = { button: 20, rowTitle: 24, rowDesc: 72, sectionTitle: 24, body: 1024, header: 60 };
const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…';
};

async function send(payload, waId, logBody) {
  if (process.env.DRY_RUN === '1') {
    console.log('[dry-run] ->', waId, JSON.stringify(payload.interactive ?? payload.text ?? payload));
    logMessage(null, waId, 'out', logBody ?? JSON.stringify(payload));
    return { dryRun: true };
  }
  const res = await fetch(base(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.wa.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[whatsapp] send failed', res.status, JSON.stringify(json));
    throw new Error(`WhatsApp send failed: ${res.status}`);
  }
  logMessage(json?.messages?.[0]?.id, waId, 'out', logBody ?? JSON.stringify(payload));
  return json;
}

export function sendText(to, body) {
  return send(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: cut(body, LIM.body) },
    },
    to,
    body
  );
}

/**
 * Interactive list. One tap inside the chat beats a link to a web form,
 * which is the whole point for this audience.
 * rows: [{ id, title, description }]
 */
export function sendList(to, { header, body, footer, button, sectionTitle, rows }) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: cut(body, LIM.body) },
      action: {
        button: cut(button, LIM.button),
        sections: [
          {
            title: cut(sectionTitle, LIM.sectionTitle),
            rows: rows.slice(0, 10).map(r => ({
              id: r.id,
              title: cut(r.title, LIM.rowTitle),
              ...(r.description ? { description: cut(r.description, LIM.rowDesc) } : {}),
            })),
          },
        ],
      },
    },
  };
  if (header) payload.interactive.header = { type: 'text', text: cut(header, LIM.header) };
  if (footer) payload.interactive.footer = { text: cut(footer, 60) };
  return send(payload, to, body);
}

export function sendButtons(to, { body, buttons }) {
  return send(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: cut(body, LIM.body) },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: b.id, title: cut(b.title, LIM.button) },
          })),
        },
      },
    },
    to,
    body
  );
}

export function markRead(messageId) {
  if (process.env.DRY_RUN === '1' || !messageId) return Promise.resolve();
  return fetch(base(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.wa.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {});
}

/** Meta signs every webhook. Reject anything that is not genuinely from them. */
export function verifySignature(rawBody, header) {
  if (!cfg.wa.appSecret) return true; // warned about at startup
  if (!header) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', cfg.wa.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Flattens Meta's deeply nested webhook into something workable. */
export function parseInbound(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const profileName = value?.contacts?.[0]?.profile?.name;
      for (const m of value?.messages ?? []) {
        const base = {
          id: m.id,
          from: m.from,
          name: profileName,
          timestamp: m.timestamp,
          type: m.type,
        };
        if (m.type === 'text') {
          out.push({ ...base, text: m.text?.body ?? '' });
        } else if (m.type === 'interactive') {
          const i = m.interactive;
          const reply = i?.list_reply ?? i?.button_reply;
          out.push({ ...base, replyId: reply?.id, text: reply?.title ?? '' });
        } else if (m.type === 'audio' || m.type === 'voice') {
          out.push({ ...base, text: '', audioId: m.audio?.id });
        } else {
          out.push({ ...base, text: '' });
        }
      }
    }
  }
  return out;
}

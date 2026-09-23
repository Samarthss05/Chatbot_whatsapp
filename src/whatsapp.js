import crypto from "node:crypto";
import { cfg } from "./config.js";
import { request, ServiceError } from "./http.js";
export function verifySignature(rawBody, header) {
  if (
    !cfg.wa.appSecret ||
    !Buffer.isBuffer(rawBody) ||
    typeof header !== "string"
  )
    return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", cfg.wa.appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected),
    b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cut = (s, n) =>
  Array.from(String(s || ""))
    .slice(0, n)
    .join("");
export function textPayload(to, body) {
  if (!String(body).trim() || Array.from(body).length > 4096)
    throw new Error("Message must contain 1–4096 characters");
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body },
  };
}
export function listPayload(to, { body, rows, header, button, sectionTitle }) {
  if (!rows.length || rows.length > 10) throw new Error("Invalid list size");
  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: cut(header, 60) },
      body: { text: cut(body, 1024) },
      action: {
        button: cut(button, 20),
        sections: [
          {
            title: cut(sectionTitle, 24),
            rows: rows.map((r) => ({
              id: r.id,
              title: cut(r.title, 24),
              description: cut(r.description, 72),
            })),
          },
        ],
      },
    },
  };
}
export function buttonsPayload(to, body, buttons) {
  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: cut(body, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: cut(b.title, 20) },
        })),
      },
    },
  };
}
export async function deliver(payload, jobId, attempt) {
  if (cfg.dryRun) return { messages: [{ id: `dry-${jobId}-${attempt}` }] };
  return request(
    `https://graph.facebook.com/${cfg.wa.graphVersion}/${cfg.wa.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.wa.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...payload,
        biz_opaque_callback_data: `job:${jobId}:${attempt}`,
      }),
    },
    "WhatsApp",
  );
}
/** A media id is opaque to us; validate its shape, never trust its length. */
const mediaId = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_=-]{1,256}$/.test(v) ? v : null;

export function parseDocument(doc) {
  const id = mediaId(doc?.id);
  if (!id) return null;
  return {
    id,
    filename: cut(doc.filename, 200) || null,
    mimeType: cut(doc.mime_type, 100) || null,
    sha256: cut(doc.sha256, 128) || null,
  };
}

/**
 * Contact cards, as WhatsApp already structures them. Numbers are reduced to
 * digits so they compare against `leads.wa_id` without a second normaliser.
 */
export function parseContacts(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const c of list.slice(0, 20)) {
    const name =
      cut(c?.name?.formatted_name, 120) ||
      cut(
        [c?.name?.first_name, c?.name?.last_name].filter(Boolean).join(" "),
        120,
      ) ||
      null;
    for (const p of Array.isArray(c?.phones) ? c.phones.slice(0, 5) : []) {
      const digits = String(p?.wa_id || p?.phone || "").replace(/\D/g, "");
      if (digits.length >= 7 && digits.length <= 20)
        out.push({ name, phone: digits });
    }
  }
  return out.length ? out : null;
}

export function parseWebhook(body) {
  const messages = [],
    statuses = [];
  if (body?.object !== "whatsapp_business_account")
    return { messages, statuses };
  for (const entry of Array.isArray(body.entry) ? body.entry : [])
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const v = change.value;
      if (
        change.field !== "messages" ||
        v?.metadata?.phone_number_id !== cfg.wa.phoneNumberId
      )
        continue;
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        if (
          typeof m.id !== "string" ||
          m.id.length > 256 ||
          !/^\d{7,20}$/.test(m.from || "") ||
          !/^\d+$/.test(String(m.timestamp || ""))
        )
          continue;
        const contact = Array.isArray(v.contacts)
          ? v.contacts.find((c) => c.wa_id === m.from)
          : null;
        const reply = m.interactive?.list_reply || m.interactive?.button_reply;
        const rawReply = reply?.id || m.button?.payload;
        messages.push({
          id: m.id,
          from: m.from,
          name: cut(contact?.profile?.name, 120),
          type: m.type,
          timestamp: Number(m.timestamp) * 1000,
          text: cut(m.text?.body || reply?.title || m.button?.text || "", 4096),
          replyId:
            typeof rawReply === "string" && rawReply.length <= 256
              ? rawReply
              : null,
          // A chat export arrives as a document, and a supplier's number as a
          // contact card. Both used to be discarded here, which made them
          // unrecoverable by the time anything downstream could ask.
          document: parseDocument(m.document),
          contacts: parseContacts(m.contacts),
        });
      }
      for (const s of Array.isArray(v.statuses) ? v.statuses : [])
        if (
          typeof s.id === "string" &&
          ["sent", "delivered", "read", "failed"].includes(s.status)
        ) {
          statuses.push({
            id: s.id,
            status: s.status,
            timestamp: Number(s.timestamp) * 1000 || Date.now(),
            errorCode: s.errors?.[0]?.code ? String(s.errors[0].code) : null,
            jobId: /^job:\d+:\d+$/.test(s.biz_opaque_callback_data || "")
              ? Number(s.biz_opaque_callback_data.split(":")[1])
              : null,
            attempt: /^job:\d+:\d+$/.test(s.biz_opaque_callback_data || "")
              ? Number(s.biz_opaque_callback_data.split(":")[2])
              : null,
          });
        }
    }
  return { messages, statuses };
}
export const parseInbound = (body) => parseWebhook(body).messages;

/**
 * Download one media object as text.
 *
 * Two steps, deliberately in one call: the lookup returns a download URL that
 * is valid for only a few minutes, so caching it in a job payload and using it
 * on a later retry would fail in a way that looks like a network fault. The
 * media id itself stays valid for about a month, so a retry re-resolves it.
 *
 * The size limit is enforced twice, once on the declared size and once while
 * reading, because the declared size is supplied by the other end.
 */
export async function fetchMediaText(id, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const meta = await request(
    `https://graph.facebook.com/${cfg.wa.graphVersion}/${id}`,
    { headers: { Authorization: `Bearer ${cfg.wa.token}` } },
    "WhatsApp media lookup",
  );
  if (!meta?.url) throw new ServiceError("WhatsApp media lookup", null, true);
  if (Number(meta.file_size) > maxBytes)
    throw new ServiceError("Attachment is too large to import", null, true);

  let res;
  try {
    res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${cfg.wa.token}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ServiceError("WhatsApp media download");
  }
  if (!res.ok)
    /**
     * Only an authorisation failure is permanent here. A 404 or 410 means the
     * short-lived download URL died, not that the export is gone: the media id
     * behind it lives for about a month, and every attempt re-resolves it. The
     * default client-error rule would give up on a file we could still fetch.
     */
    throw new ServiceError(
      "WhatsApp media download",
      res.status,
      [401, 403].includes(res.status),
    );

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes)
      throw new ServiceError("Attachment is too large to import", null, true);
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return {
    text: buffer.toString("utf8"),
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    mimeType: meta.mime_type || null,
  };
}

import crypto from "node:crypto";
import { cfg } from "./config.js";
import { request } from "./http.js";
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

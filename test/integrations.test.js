import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.DRY_RUN = "0";
process.env.DB_FILE = ":memory:";
process.env.ADMIN_TOKEN = "integration-test-token-32-characters";
process.env.OWNER_WHATSAPP = "";
for (const k of [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
])
  process.env[k] = "integration-fixture-credentials-32";
process.env.OPENROUTER_API_KEY = "fixture";
process.env.OPENROUTER_MODEL = "fixture/model";
const { db, ingest, currentBooking, getLead, retryJob, getBooking } =
  await import("../src/store.js");
const { drain } = await import("../src/worker.js");
const { classify } = await import("../src/brain.js");
const events = new Map();
let mode = "ok",
  waCalls = 0,
  createCalls = 0,
  modelPayload;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
globalThis.fetch = async (url, options) => {
  const u = String(url);
  const body =
    options?.body && typeof options.body === "string"
      ? JSON.parse(options.body)
      : null;
  if (u.includes("oauth2.googleapis.com"))
    return response(200, { access_token: "fixture-access", expires_in: 3600 });
  if (u.includes("openrouter.ai")) {
    modelPayload = body;
    return response(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              intent: "other",
              lang: "en",
              confidence: 0.2,
              shop: null,
              address: null,
              time_hint: null,
            }),
          },
        },
      ],
    });
  }
  if (u.includes("graph.facebook.com")) {
    waCalls++;
    return response(200, { messages: [{ id: "wa-" + waCalls }] });
  }
  if (u.endsWith("/freeBusy")) {
    if (mode === "availability-error")
      return response(200, {
        calendars: { primary: { errors: [{ reason: "notFound" }] } },
      });
    return response(200, {
      calendars: {
        primary: {
          busy: [...events.values()].map((e) => ({
            start: e.start.dateTime,
            end: e.end.dateTime,
          })),
        },
      },
    });
  }
  if (u.endsWith("/events") && options.method === "POST") {
    createCalls++;
    if (mode === "create-error") return response(503, { error: "outage" });
    if (events.has(body.id)) return response(409, {});
    events.set(body.id, body);
    if (mode === "lost-response") {
      mode = "ok";
      throw new Error("Connection lost after Google committed");
    }
    return response(200, { id: body.id });
  }
  const id = u.split("/").at(-1);
  if (options.method === "GET")
    return events.has(id) ? response(200, events.get(id)) : response(404, {});
  if (options.method === "DELETE") {
    if (mode === "delete-error") return response(503, {});
    events.delete(id);
    return response(204, null);
  }
  if (options.method === "PATCH") {
    Object.assign(events.get(id), body);
    return response(200, events.get(id));
  }
  throw new Error("Unexpected test request " + u);
};
const A = "6592220001",
  B = "6592220002";
const msg = (from, text, replyId) => ({
  id: randomUUID(),
  from,
  text,
  type: replyId ? "interactive" : "text",
  replyId,
  timestamp: Date.now(),
});
async function send(from, text, replyId) {
  ingest([msg(from, text, replyId)]);
  await drain();
}
const offer = (wa) =>
  db.prepare("SELECT * FROM slot_offers WHERE wa_id=? ORDER BY start").get(wa);
async function book(wa = A) {
  await send(wa, "hi");
  const o = offer(wa);
  await send(wa, "tap", "slot:" + o.id);
  return currentBooking(wa);
}
const retry = async () => {
  db.prepare("UPDATE jobs SET available_at=0 WHERE status='retry'").run();
  await drain();
};
beforeEach(() => {
  for (const t of [
    "jobs",
    "messages",
    "slot_offers",
    "notifications",
    "audit",
    "bookings",
    "leads",
    "delivery_events",
  ])
    db.prepare("DELETE FROM " + t).run();
  events.clear();
  mode = "ok";
  waCalls = 0;
  createCalls = 0;
});
after(() => db.close());
test("calendar creation confirms only after event succeeds", async () => {
  mode = "create-error";
  const b = await book();
  assert.equal(b.status, "pending");
  assert.equal(getLead(A).state, "BOOKING_PENDING");
  assert.equal(events.size, 0);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM messages WHERE direction='out' AND body LIKE 'Booked:%'",
      )
      .get().n,
    0,
  );
  mode = "ok";
  await retry();
  assert.equal(getBooking(b.id).status, "confirmed");
  assert.equal(events.size, 1);
});
test("calendar event IDs reconcile a lost successful response without duplicate events", async () => {
  mode = "lost-response";
  const b = await book();
  assert.equal(b.status, "pending");
  assert.equal(events.size, 1);
  await retry();
  assert.equal(getBooking(b.id).status, "confirmed");
  assert.equal(events.size, 1);
  assert.equal(createCalls, 2);
});
test("calendar availability errors hand to a person and never offer unchecked slots", async () => {
  mode = "availability-error";
  await send(A, "hi");
  assert.equal(getLead(A).state, "HUMAN");
  assert.equal(offer(A), undefined);
  assert.equal(events.size, 0);
});
test("two simultaneous users cannot reserve the same calendar slot", async () => {
  await send(A, "hi");
  await send(B, "hi");
  const a = offer(A),
    b = offer(B);
  assert.equal(a.start, b.start);
  ingest([msg(A, "tap", "slot:" + a.id), msg(B, "tap", "slot:" + b.id)]);
  await drain();
  assert.equal(events.size, 1);
  assert.equal(currentBooking(B), undefined);
});
test("reschedule cancellation failure keeps the original slot blocked until recovery", async () => {
  const original = await book();
  await send(A, "Shop, Test Road");
  await send(A, "reschedule");
  const o = offer(A);
  mode = "delete-error";
  await send(A, "tap", "slot:" + o.id);
  const replacement = currentBooking(A);
  assert.notEqual(replacement.id, original.id);
  assert.equal(replacement.status, "confirmed");
  assert.equal(getBooking(original.id).status, "cancel_pending");
  assert.equal(events.size, 2);
  mode = "ok";
  await retry();
  assert.equal(getBooking(original.id).status, "cancelled");
  assert.equal(events.size, 1);
});
test("closed WhatsApp reply windows become actionable failures, not blind sends", async () => {
  await send(A, "hi");
  db.prepare("UPDATE leads SET last_inbound_at=0 WHERE wa_id=?").run(A);
  const { say } = await import("../src/messaging.js");
  say(A, "Late reply", { automated: false });
  const before = waCalls;
  await drain();
  assert.equal(waCalls, before);
  assert.match(
    db.prepare("SELECT last_error FROM jobs WHERE status='dead'").get()
      .last_error,
    /window expired/,
  );
});
test("OpenRouter request contains schema and bounded context; low-confidence output is rejected", async () => {
  const result = await classify("something ambiguous", {
    lang: "en",
    state: "AWAITING_SLOT",
    history: Array.from({ length: 20 }, () => ({
      direction: "in",
      body: "x".repeat(1000),
    })),
  });
  assert.equal(result, null);
  assert.equal(modelPayload.response_format.type, "json_schema");
  const context = JSON.parse(modelPayload.messages[1].content);
  assert.equal(context.history.length, 8);
  assert.equal(context.history[0].text.length, 500);
});

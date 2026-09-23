import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
process.env.DRY_RUN = "1";
process.env.DB_FILE = ":memory:";
process.env.ADMIN_TOKEN = "test-only-operator-token-32-characters";
process.env.OWNER_WHATSAPP = "";
globalThis.fetch = async () => {
  throw new Error("External network is forbidden in offline tests");
};
const store = await import("../src/store.js");
const { cfg, validateConfig } = await import("../src/config.js");
const { drain, startWorker } = await import("../src/worker.js");
const { parseDetails } = await import("../src/flow.js");
const { pickSlots } = await import("../src/slots.js");
const { rules, validateVerdict } = await import("../src/brain.js");
const {
  db,
  ingest,
  getLead,
  currentBooking,
  getBooking,
  activeBookings,
  reserveBooking,
  history,
} = store;
const A = "6591110001",
  B = "6591110002";
const inbound = (from, text, replyId) => ({
  id: randomUUID(),
  from,
  name: "Test shop",
  type: replyId ? "interactive" : "text",
  text,
  replyId,
  timestamp: Date.now(),
});
async function message(from, text, replyId) {
  const m = inbound(from, text, replyId);
  ingest([m]);
  await drain();
  return m;
}
const offers = (from) =>
  db
    .prepare("SELECT * FROM slot_offers WHERE wa_id=? ORDER BY start")
    .all(from);
async function book(from = A) {
  await message(from, "Hi Ledger");
  const offer = offers(from)[0];
  assert.ok(offer);
  await message(from, "Choose", "slot:" + offer.id);
  return currentBooking(from);
}
beforeEach(() => {
  for (const table of [
    "jobs",
    "messages",
    "slot_offers",
    "notifications",
    "audit",
    "bookings",
    "leads",
    "worker_lock",
    "delivery_events",
  ])
    db.prepare("DELETE FROM " + table).run();
});
after(() => db.close());
test("complete booking stores validated details and one independent reservation", async () => {
  const b = await book();
  assert.equal(b.status, "confirmed");
  assert.equal(getLead(A).state, "AWAITING_DETAILS");
  await message(A, "Ah Seng Provisions, Blk 824 #01-24");
  assert.equal(getLead(A).state, "BOOKED");
  assert.equal(getLead(A).shop_address, "Blk 824 #01-24");
  assert.equal(activeBookings().length, 1);
  assert.ok(
    history(A).some(
      (m) => m.direction === "out" && m.body.startsWith("Booked:"),
    ),
  );
});
test("duplicate webhook never creates duplicate replies or transitions", async () => {
  const m = await message(A, "Hi");
  const before = db.prepare("SELECT count(*) n FROM jobs").get().n;
  ingest([m]);
  await drain();
  assert.equal(db.prepare("SELECT count(*) n FROM jobs").get().n, before);
});
test("second contact cannot book a reserved slot while details are pending", async () => {
  await message(A, "Hi");
  await message(B, "Hi");
  const a = offers(A)[0],
    b = offers(B).find((o) => o.start === a.start);
  assert.ok(b);
  ingest([
    inbound(A, "tap", "slot:" + a.id),
    inbound(B, "tap", "slot:" + b.id),
  ]);
  await drain();
  assert.equal(activeBookings().length, 1);
  assert.equal(getLead(B).state, "AWAITING_SLOT");
});
test("reservation overlap and travel buffer are checked atomically", () => {
  store.upsertLead(A);
  store.upsertLead(B);
  const start = new Date(Date.now() + 86400000),
    end = new Date(+start + 20 * 60000);
  assert.ok(
    reserveBooking({
      id: "one",
      waId: A,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
  );
  const second = new Date(+end + 5 * 60000);
  assert.equal(
    reserveBooking({
      id: "two",
      waId: B,
      start: second.toISOString(),
      end: new Date(+second + 20 * 60000).toISOString(),
    }),
    null,
  );
});
test("handover keeps an appointment reserved", async () => {
  const b = await book();
  await message(A, "human");
  assert.equal(getLead(A).state, "HUMAN");
  assert.equal(getBooking(b.id).status, "confirmed");
  assert.ok(activeBookings().some((x) => x.id === b.id));
});
test("cancellation at details stage asks confirmation instead of saving shop name", async () => {
  const b = await book();
  await message(A, "Please cancel my appointment");
  assert.equal(getLead(A).shop_name, null);
  assert.equal(getBooking(b.id).status, "confirmed");
  await message(A, "Cancel", "cancel:" + b.id);
  assert.equal(getBooking(b.id).status, "cancelled");
  assert.equal(getLead(A).state, "CANCELLED");
});
test("a contact cannot cancel another contact’s appointment", async () => {
  const b = await book();
  await message(B, "Hi");
  await message(B, "Cancel", "cancel:" + b.id);
  assert.equal(getBooking(b.id).status, "confirmed");
});
test("rescheduling preserves the old booking until replacement commits", async () => {
  const original = await book();
  await message(A, "Shop, Block 1 #01-01");
  await message(A, "reschedule");
  assert.equal(getBooking(original.id).status, "confirmed");
  const offer = offers(A)[0];
  await message(A, "Choose", "slot:" + offer.id);
  const next = currentBooking(A);
  assert.notEqual(next.id, original.id);
  assert.equal(getBooking(original.id).status, "cancelled");
  assert.equal(next.replaces_id, original.id);
  assert.equal(activeBookings().length, 1);
});
test("old list taps cannot overwrite a completed booking", async () => {
  await message(A, "Hi");
  const saved = offers(A);
  await message(A, "Choose", "slot:" + saved[0].id);
  await message(A, "Shop, 20 Test Road");
  const b = currentBooking(A);
  await message(A, "Old selection", "slot:" + saved[1].id);
  assert.equal(currentBooking(A).id, b.id);
  assert.equal(activeBookings().length, 1);
});
test("expired offer is replaced without booking", async () => {
  await message(A, "Hi");
  const o = offers(A)[0];
  db.prepare("UPDATE slot_offers SET expires_at=0 WHERE id=?").run(o.id);
  await message(A, "Choose", "slot:" + o.id);
  assert.equal(currentBooking(A), undefined);
  assert.ok(offers(A).every((x) => x.id !== o.id));
});
test("first contact STOP opts out, and explicit START opts back in", async () => {
  await message(A, "Stop messaging me");
  assert.equal(getLead(A).state, "DECLINED");
  assert.equal(offers(A).length, 0);
  const before = history(A).filter((m) => m.direction === "out").length;
  await message(A, "what is this");
  assert.equal(history(A).filter((m) => m.direction === "out").length, before);
  await message(A, "START");
  assert.equal(getLead(A).human_takeover, 0);
  assert.equal(getLead(A).state, "AWAITING_SLOT");
});
test("details parser handles Chinese punctuation and rejects commands/questions", () => {
  assert.deepEqual(parseDetails("发记杂货，824座 #01-24"), {
    shop: "发记杂货",
    address: "824座 #01-24",
  });
  assert.equal(parseDetails("Cancel, please"), null);
  assert.equal(parseDetails("How much?"), null);
  assert.equal(parseDetails("Shop only"), null);
});
test("unsupported media asks for text without recording false shop details", async () => {
  await book();
  const m = { ...inbound(A, ""), type: "audio" };
  ingest([m]);
  await drain();
  assert.equal(getLead(A).shop_name, null);
  assert.equal(getLead(A).state, "AWAITING_DETAILS");
  assert.match(history(A).at(-1).body, /voice notes/);
});
test("transaction failure rolls back state and outbound messages; retry recovers", async () => {
  db.exec(
    "CREATE TEMP TRIGGER fail_state BEFORE UPDATE ON leads WHEN NEW.state='AWAITING_SLOT' BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  const m = inbound(A, "Hi");
  ingest([m]);
  await drain();
  assert.equal(getLead(A), undefined);
  assert.equal(history(A).length, 0);
  assert.equal(
    db.prepare("SELECT count(*) n FROM jobs WHERE kind='wa'").get().n,
    0,
  );
  db.exec("DROP TRIGGER fail_state");
  db.prepare("UPDATE jobs SET available_at=0 WHERE status='retry'").run();
  await drain();
  assert.equal(getLead(A).state, "AWAITING_SLOT");
});
test("one active worker owns a database; restart recovers interrupted actions", async () => {
  ingest([inbound(A, "Hi")]);
  db.prepare("UPDATE jobs SET status='processing'").run();
  const worker = startWorker();
  assert.throws(() => startWorker(), /Another worker/);
  await worker.stop();
  await drain();
  assert.equal(getLead(A).state, "AWAITING_SLOT");
});
test("configuration rejects malformed schedules and placeholder secrets", () => {
  assert.deepEqual(validateConfig(), []);
  assert.ok(
    validateConfig({ ...cfg, adminToken: "pick-another-long-random-string" })
      .length,
  );
  assert.ok(
    validateConfig({ ...cfg, booking: { ...cfg.booking, times: ["25:99"] } })
      .length,
  );
});
test("LLM schema rejects unsupported language, low confidence and unexpected types", () => {
  const good = {
    intent: "book",
    lang: "en",
    confidence: 0.9,
    shop: null,
    address: null,
    time_hint: null,
  };
  assert.deepEqual(validateVerdict(good), good);
  assert.equal(validateVerdict({ ...good, lang: "xx" }), null);
  assert.equal(validateVerdict({ ...good, confidence: 0.1 }), null);
  assert.equal(validateVerdict({ ...good, shop: {} }), null);
  assert.equal(rules("tidak berminat").intent, "stop");
});
test("local reservations disappear only after cancellation, not state changes", async () => {
  const b = await book();
  assert.ok(!pickSlots([], 1000).some((x) => x.toISOString() === b.start));
  store.updateLead(A, { state: "HUMAN", human_takeover: 1 });
  assert.ok(!pickSlots([], 1000).some((x) => x.toISOString() === b.start));
});
test("obsolete confirmation is suppressed after appointment cancellation", async () => {
  const b = await book();
  const { say } = await import("../src/messaging.js");
  say(A, "Stale booked confirmation", {
    bookingId: b.id,
    bookingStatus: "confirmed",
  });
  store.setBooking(b.id, "cancelled");
  await drain();
  assert.ok(!history(A).some((m) => m.body === "Stale booked confirmation"));
});
test("manual messages queued before an opt-out are suppressed", async () => {
  await message(A, "hi");
  const { say } = await import("../src/messaging.js");
  say(A, "Do not deliver this later", { automated: false });
  store.updateLead(A, { state: "DECLINED", human_takeover: 1 });
  await drain();
  assert.ok(!history(A).some((m) => m.body === "Do not deliver this later"));
});
test("an unrecovered failed inbound action blocks later messages for that contact", async () => {
  const first = inbound(A, "hi"),
    second = inbound(A, "book");
  ingest([first, second]);
  db.prepare("UPDATE jobs SET status='dead' WHERE job_key=?").run(
    "in:" + first.id,
  );
  await drain();
  assert.equal(getLead(A), undefined);
  store.retryJob(
    db.prepare("SELECT id FROM jobs WHERE job_key=?").get("in:" + first.id).id,
  );
  await drain();
  assert.equal(getLead(A).state, "AWAITING_SLOT");
});

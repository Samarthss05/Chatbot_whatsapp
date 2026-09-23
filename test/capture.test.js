import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.DB_FILE = ":memory:";
process.env.DRY_RUN = "1";
process.env.ADMIN_TOKEN = "capture-test-operator-token-32-chars";
process.env.WHATSAPP_APP_SECRET = "capture-test-secret";
process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-fixture";
process.env.WHATSAPP_VERIFY_TOKEN = "capture-webhook-token-32-characters";
process.env.IMPORT_RETENTION_DAYS = "30";
const { createApp } = await import("../src/app.js");
const store = await import("../src/store.js");
const { drain } = await import("../src/worker.js");
const { db, getLead, updateLead, batchesFor, supplierContactsFor } = store;

let server, base;
const auth = { "x-admin-token": process.env.ADMIN_TOKEN };
const SHOP = "6591110007";

before(async () => {
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** A signed webhook, the way Meta sends one. */
async function deliverWebhook(message) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-fixture" },
              contacts: [{ wa_id: SHOP, profile: { name: "Ah Seng" } }],
              messages: [
                {
                  from: SHOP,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
      .update(Buffer.from(body))
      .digest("hex");
  const res = await fetch(base + "/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hub-signature-256": signature,
    },
    body,
  });
  assert.equal(res.status, 200);
  await drain();
}

const exportDoc = (id, over = {}) => ({
  id,
  type: "document",
  document: {
    id: "media-" + id,
    filename: "WhatsApp Chat with Hock Lee.txt",
    mime_type: "text/plain",
    sha256: "abc",
    ...over,
  },
});

test("TC-CAP-01 an export without recorded consent is logged but never stored", async () => {
  await deliverWebhook(exportDoc("wam-no-consent"));
  const [batch] = batchesFor(SHOP);
  assert.equal(batch.state, "rejected");
  assert.equal(batch.reason, "no_consent");
  assert.equal(batch.has_raw, 0);
  // The operator is told, because the shop is standing there expecting it to work.
  const notice = db
    .prepare(
      "SELECT body FROM notifications WHERE wa_id=? ORDER BY created_at DESC",
    )
    .get(SHOP);
  assert.match(notice.body, /no import consent/i);
});

test("TC-CAP-02 consent is recorded by an operator, not granted by sending a file", async () => {
  assert.equal(getLead(SHOP).import_consent_at, null);
  const res = await post(
    `/api/leads/${SHOP}/consent`,
    { granted: true, method: "in_person" },
    auth,
  );
  assert.equal(res.status, 200);
  const lead = getLead(SHOP);
  assert.ok(lead.import_consent_at > 0);
  assert.equal(lead.import_consent_method, "in_person");
});

test("TC-CAP-03 with consent, an export is accepted and carries a retention date", async () => {
  await deliverWebhook(exportDoc("wam-consented"));
  const batch = batchesFor(SHOP).find(
    (b) => b.id !== batchesFor(SHOP).at(-1).id,
  );
  assert.ok(batch, "a batch was opened");
  assert.ok(
    batch.consent_at > 0,
    "the consent in force is snapshotted onto it",
  );
  assert.ok(
    batch.retention_expires_at > Date.now() + 29 * 24 * 3600000,
    "the retention clock starts at capture, not at review",
  );
  // Demo mode never reaches out to Meta, so the download stops here by design
  // rather than by a missing credential surfacing as a mysterious failure.
  assert.equal(batch.state, "failed");
  assert.equal(batch.reason, "demo_mode");
  assert.equal(batch.has_raw, 0);
});

test("TC-CAP-04 capture survives an operator having taken the conversation over", async () => {
  updateLead(SHOP, { state: "HUMAN", human_takeover: 1 });
  const before = batchesFor(SHOP).length;
  await deliverWebhook(exportDoc("wam-during-takeover"));
  assert.equal(
    batchesFor(SHOP).length,
    before + 1,
    "an export sent while a person is handling the chat must still be captured",
  );
  updateLead(SHOP, { human_takeover: 0, state: "NEW" });
});

test("TC-CAP-05 a replayed webhook does not create a second import", async () => {
  const before = batchesFor(SHOP).length;
  await deliverWebhook(exportDoc("wam-consented"));
  assert.equal(batchesFor(SHOP).length, before);
});

test("TC-CAP-06 a zip or image is refused rather than queued", async () => {
  const before = batchesFor(SHOP).length;
  await deliverWebhook(
    exportDoc("wam-zip", {
      filename: "WhatsApp Chat.zip",
      mime_type: "application/zip",
    }),
  );
  assert.equal(batchesFor(SHOP).length, before, "no batch is opened at all");
});

test("TC-CAP-07 supplier contact cards are captured and deduplicated", async () => {
  await deliverWebhook({
    id: "wam-contacts",
    type: "contacts",
    contacts: [
      {
        name: { formatted_name: "Hock Lee Trading" },
        phones: [{ phone: "+65 6222 3344", wa_id: "6562223344" }],
      },
      {
        name: { first_name: "Seng", last_name: "Vegetables" },
        phones: [{ wa_id: "6562223355" }],
      },
      // Their own card is not a supplier.
      { name: { formatted_name: "Me" }, phones: [{ wa_id: SHOP }] },
    ],
  });
  const contacts = supplierContactsFor(SHOP);
  assert.equal(contacts.length, 2);
  assert.ok(contacts.some((c) => c.phone === "6562223344"));
  assert.ok(!contacts.some((c) => c.phone === SHOP));

  await deliverWebhook({
    id: "wam-contacts-again",
    type: "contacts",
    contacts: [
      {
        name: { formatted_name: "Hock Lee Trading" },
        phones: [{ wa_id: "6562223344" }],
      },
    ],
  });
  assert.equal(supplierContactsFor(SHOP).length, 2, "same number, one row");
});

test("TC-CAP-08 an opted-out contact is not captured from at all", async () => {
  updateLead(SHOP, { state: "DECLINED", human_takeover: 1 });
  const beforeBatches = batchesFor(SHOP).length;
  const beforeContacts = supplierContactsFor(SHOP).length;
  await deliverWebhook(exportDoc("wam-after-optout"));
  await deliverWebhook({
    id: "wam-contacts-after-optout",
    type: "contacts",
    contacts: [
      {
        name: { formatted_name: "Anything" },
        phones: [{ wa_id: "6599990000" }],
      },
    ],
  });
  assert.equal(batchesFor(SHOP).length, beforeBatches);
  assert.equal(supplierContactsFor(SHOP).length, beforeContacts);
  updateLead(SHOP, { state: "NEW", human_takeover: 0 });
});

test("TC-CAP-09 retention purges the text and keeps the counts", () => {
  const id = "batch-retention";
  db.prepare(
    "INSERT INTO import_batch(id,wa_id,state,raw,summary,retention_expires_at,created_at,updated_at) VALUES (?,?,'stored',?,?,?,?,?)",
  ).run(
    id,
    SHOP,
    "23/09/2026, 8:14 am - Ah Seng: onion 2 bag",
    JSON.stringify({ messageCount: 1, distinctDays: 1 }),
    Date.now() - 1000,
    Date.now(),
    Date.now(),
  );
  assert.equal(store.purgeExpiredBatches(), 1);
  const batch = store.getBatch(id);
  assert.equal(batch.raw, null);
  assert.equal(batch.state, "purged");
  assert.ok(batch.purged_at > 0);
  assert.equal(JSON.parse(batch.summary).messageCount, 1, "counts survive");
  assert.equal(store.purgeExpiredBatches(), 0, "purging twice is a no-op");
});

test("TC-CAP-10 withdrawing consent does not silently delete what is stored", async () => {
  const res = await post(
    `/api/leads/${SHOP}/consent`,
    { granted: false },
    auth,
  );
  assert.equal(res.status, 200);
  assert.equal(getLead(SHOP).import_consent_at, null);
  // Deletion is a separate, deliberate decision through the purge action.
  assert.ok(batchesFor(SHOP).length > 0);
});

test("TC-CAP-11 the outlet link is validated before it is stored", async () => {
  assert.equal(
    (await post(`/api/leads/${SHOP}/outlet`, { outletId: "../../etc" }, auth))
      .status,
    400,
  );
  assert.equal(
    (await post(`/api/leads/${SHOP}/outlet`, { outletId: "outlet-42" }, auth))
      .status,
    200,
  );
  assert.equal(getLead(SHOP).outlet_id, "outlet-42");
});

test("TC-CAP-12 import endpoints require the operator token", async () => {
  const batch = batchesFor(SHOP)[0];
  assert.equal((await fetch(`${base}/api/imports/${batch.id}`)).status, 401);
  assert.equal((await post(`/api/imports/${batch.id}/purge`, {})).status, 401);
});

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
process.env.DB_FILE = ":memory:";
process.env.DRY_RUN = "1";
process.env.ADMIN_TOKEN = "api-test-operator-token-32-characters";
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-fixture";
process.env.WHATSAPP_VERIFY_TOKEN = "test-webhook-token-32-characters";
const { createApp } = await import("../src/app.js");
const { db } = await import("../src/store.js");
const { drain } = await import("../src/worker.js");
let server, base;
const auth = { "x-admin-token": process.env.ADMIN_TOKEN };
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
function payload(id = "signed-one", phone = "phone-fixture") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phone },
              contacts: [{ wa_id: "6591110001", profile: { name: "Test" } }],
              messages: [
                {
                  id,
                  from: "6591110001",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "Hi" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
const signature = (p) =>
  "sha256=" +
  crypto
    .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
    .update(JSON.stringify(p))
    .digest("hex");
test("admin endpoints require header token; query token is rejected", async () => {
  assert.equal((await fetch(base + "/api/overview")).status, 401);
  assert.equal(
    (await fetch(base + "/leads?token=" + process.env.ADMIN_TOKEN)).status,
    401,
  );
  assert.equal(
    (await fetch(base + "/api/overview", { headers: auth })).status,
    200,
  );
});
test("webhook authenticates raw bytes and durably ingests before reply", async () => {
  const p = payload();
  assert.equal((await post("/webhook", p)).status, 401);
  assert.equal(
    (await post("/webhook", p, { "x-hub-signature-256": signature(p) })).status,
    200,
  );
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE job_key='in:signed-one'").get()
      .status,
    "queued",
  );
  await post("/webhook", p, { "x-hub-signature-256": signature(p) });
  assert.equal(
    db.prepare("SELECT count(*) n FROM jobs WHERE kind='inbox'").get().n,
    1,
  );
  await drain();
});
test("signed messages for a different business phone number are ignored", async () => {
  const p = payload("wrong-phone", "different-phone");
  await post("/webhook", p, { "x-hub-signature-256": signature(p) });
  assert.equal(
    db.prepare("SELECT id FROM jobs WHERE job_key='in:wrong-phone'").get(),
    undefined,
  );
});
test("verification challenge and security headers work", async () => {
  const res = await fetch(
    base +
      "/webhook?hub.mode=subscribe&hub.verify_token=" +
      process.env.WHATSAPP_VERIFY_TOKEN +
      "&hub.challenge=123",
  );
  assert.equal(await res.text(), "123");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    res.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
});
test("operator notes and replies validate input and audit actions", async () => {
  assert.equal(
    (await post("/api/leads/6591110001/notes", { notes: { bad: true } }, auth))
      .status,
    400,
  );
  assert.equal(
    (
      await post(
        "/api/leads/6591110001/notes",
        { notes: "Call before visiting" },
        auth,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await post(
        "/api/leads/6591110001/reply",
        { text: "Hello from the team" },
        auth,
      )
    ).status,
    200,
  );
  await drain();
  const data = await (
    await fetch(base + "/api/leads/6591110001", { headers: auth })
  ).json();
  assert.equal(data.lead.human_takeover, 1);
  assert.equal(data.lead.notes, "Call before visiting");
  assert.ok(data.messages.some((m) => m.body === "Hello from the team"));
});
test("status webhooks associate failed delivery with its outbound action", async () => {
  const job = db
    .prepare("SELECT * FROM jobs WHERE kind='wa' ORDER BY id DESC LIMIT 1")
    .get();
  const p = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-fixture" },
              statuses: [
                {
                  id: job.external_id,
                  status: "failed",
                  timestamp: "1800000000",
                  biz_opaque_callback_data:
                    "job:" + job.id + ":" + job.attempts,
                  errors: [{ code: 131047 }],
                },
              ],
            },
          },
        ],
      },
    ],
  };
  await post("/webhook", p, { "x-hub-signature-256": signature(p) });
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "dead",
  );
});
test("malformed JSON returns a bounded error, without a stack trace", async () => {
  const res = await fetch(base + "/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid request body." });
});
test("retrying a failed delivery clears the previous external message ID and sends again", async () => {
  const job = db
    .prepare("SELECT * FROM jobs WHERE kind='wa' AND status='dead' LIMIT 1")
    .get();
  assert.ok(job.external_id);
  const res = await post("/api/jobs/" + job.id + "/retry", {}, auth);
  assert.equal(res.status, 200);
  assert.equal(
    db.prepare("SELECT external_id FROM jobs WHERE id=?").get(job.id)
      .external_id,
    null,
  );
  await drain();
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "done",
  );
});
test("late callbacks from an earlier send attempt cannot fail its successful retry", async () => {
  const job = db
    .prepare("SELECT * FROM jobs WHERE kind='wa' AND attempts>1 LIMIT 1")
    .get();
  assert.ok(job);
  const { ingest } = await import("../src/store.js");
  ingest(
    [],
    [
      {
        id: `dry-${job.id}-1`,
        status: "failed",
        timestamp: 1800000001000,
        errorCode: "131047",
        jobId: job.id,
        attempt: 1,
      },
    ],
  );
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "done",
  );
});

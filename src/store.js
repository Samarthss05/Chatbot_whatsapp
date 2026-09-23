import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { cfg } from "./config.js";
if (cfg.dbFile !== ":memory:")
  mkdirSync(dirname(cfg.dbFile), { recursive: true });
export const db = new Database(cfg.dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
const ACTIVE = "'pending','confirmed','cancel_pending'";
export function migrate() {
  if (db.pragma("user_version", { simple: true }) > 3)
    throw new Error("Database schema is newer than this application");
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS leads (wa_id TEXT PRIMARY KEY, name TEXT, lang TEXT DEFAULT 'en', state TEXT DEFAULT 'NEW', shop_name TEXT, shop_address TEXT, slot_iso TEXT, calendar_id TEXT, source TEXT, first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), human_takeover INTEGER DEFAULT 0, notes TEXT);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, wa_id TEXT, direction TEXT, body TEXT, at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, wa_id TEXT NOT NULL REFERENCES leads(wa_id), start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','confirmed','cancel_pending','cancelled','failed')), calendar_id TEXT, replaces_id TEXT REFERENCES bookings(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bookings_overlap ON bookings(status,start,end);
      CREATE INDEX IF NOT EXISTS bookings_contact ON bookings(wa_id,created_at);
      CREATE TABLE IF NOT EXISTS slot_offers (id TEXT PRIMARY KEY, wa_id TEXT NOT NULL REFERENCES leads(wa_id), start TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, lane TEXT NOT NULL, payload TEXT NOT NULL, status TEXT DEFAULT 'queued', attempts INTEGER DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT, external_id TEXT);
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,available_at,id);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, entity TEXT, actor TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, body TEXT NOT NULL, wa_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
      CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_events (message_id TEXT NOT NULL, status TEXT NOT NULL, timestamp INTEGER NOT NULL, error_code TEXT, PRIMARY KEY(message_id,status,timestamp));
      CREATE TABLE IF NOT EXISTS import_batch (id TEXT PRIMARY KEY, wa_id TEXT NOT NULL REFERENCES leads(wa_id), message_id TEXT, media_id TEXT, filename TEXT, mime_type TEXT, bytes INTEGER, sha256 TEXT, raw TEXT, state TEXT NOT NULL CHECK(state IN ('pending','stored','rejected','accepted','purged','failed')), reason TEXT, supplier_label TEXT, summary TEXT, consent_at INTEGER, consent_method TEXT, retention_expires_at INTEGER, purged_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS import_batch_contact ON import_batch(wa_id,created_at);
      CREATE INDEX IF NOT EXISTS import_batch_retention ON import_batch(state,retention_expires_at);
      CREATE TABLE IF NOT EXISTS supplier_contact (id TEXT PRIMARY KEY, wa_id TEXT NOT NULL REFERENCES leads(wa_id), name TEXT, phone TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('captured','accepted','rejected')), message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS supplier_contact_unique ON supplier_contact(wa_id,phone);
    `);
    const add = (table, column, type) => {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((c) => c.name === column)
      )
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    };
    add("leads", "last_inbound_at", "INTEGER DEFAULT 0");
    add("leads", "details_attempts", "INTEGER DEFAULT 0");
    add("messages", "external_id", "TEXT");
    add("messages", "type", "TEXT DEFAULT 'text'");
    // The bridge to the order pipeline. One nullable column is the whole join:
    // conversations and appointments stay here, outlets and aliases stay there,
    // and "did this outlet order a second time" stays answerable.
    add("leads", "outlet_id", "TEXT");
    // Import consent is recorded per contact by an operator at the visit, before
    // any export is kept. It is a narrower purpose than the booking consent, so
    // it is tracked separately rather than folded into the lead's state.
    add("leads", "import_consent_at", "INTEGER");
    add("leads", "import_consent_method", "TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS messages_contact ON messages(wa_id,at); CREATE INDEX IF NOT EXISTS messages_external ON messages(external_id);",
    );
    if (db.pragma("user_version", { simple: true }) < 2) {
      for (const lead of db
        .prepare("SELECT * FROM leads WHERE slot_iso IS NOT NULL")
        .all()) {
        const ms = Date.parse(lead.slot_iso);
        if (!Number.isFinite(ms)) continue;
        const id =
          "legacy-" +
          createHash("sha256").update(lead.wa_id).digest("hex").slice(0, 24);
        db.prepare(
          "INSERT OR IGNORE INTO bookings (id,wa_id,start,end,status,calendar_id,created_at,updated_at) VALUES (?,?,?,?, 'confirmed',?,?,?)",
        ).run(
          id,
          lead.wa_id,
          new Date(ms).toISOString(),
          new Date(ms + cfg.booking.minutes * 60000).toISOString(),
          lead.calendar_id,
          Date.now(),
          Date.now(),
        );
      }
      db.pragma("user_version = 2");
    }
    if (db.pragma("user_version", { simple: true }) < 3)
      db.pragma("user_version = 3");
  }).immediate();
}
migrate();
export const atomic = (fn) => db.transaction(fn).immediate();
export const getLead = (id) =>
  db.prepare("SELECT * FROM leads WHERE wa_id=?").get(id);
export function upsertLead(
  id,
  { name = null, lang = "en", source = null } = {},
) {
  db.prepare(
    "INSERT OR IGNORE INTO leads(wa_id,name,lang,source) VALUES (?,?,?,?)",
  ).run(id, name, lang, source);
  return getLead(id);
}
const leadKeys = new Set([
  "name",
  "lang",
  "state",
  "shop_name",
  "shop_address",
  "slot_iso",
  "calendar_id",
  "human_takeover",
  "notes",
  "last_inbound_at",
  "details_attempts",
  "outlet_id",
  "import_consent_at",
  "import_consent_method",
]);
export function updateLead(id, patch) {
  const keys = Object.keys(patch);
  if (keys.some((k) => !leadKeys.has(k))) throw new Error("Invalid lead field");
  if (keys.length)
    db.prepare(
      `UPDATE leads SET ${keys.map((k) => `${k}=@${k}`).join(",")}, last_seen=datetime('now') WHERE wa_id=@wa_id`,
    ).run({ ...patch, wa_id: id });
  return getLead(id);
}
export function logMessage(
  id,
  waId,
  direction,
  body,
  type = "text",
  externalId = null,
) {
  db.prepare(
    "INSERT OR IGNORE INTO messages(id,wa_id,direction,body,type,external_id) VALUES (?,?,?,?,?,?)",
  ).run(id || randomUUID(), waId, direction, body || "", type, externalId);
}
export const history = (id, limit = 40) =>
  db
    .prepare(
      "SELECT * FROM (SELECT rowid AS sequence,* FROM messages WHERE wa_id=? ORDER BY rowid DESC LIMIT ?) ORDER BY sequence",
    )
    .all(id, limit);
export const allLeads = () =>
  db.prepare("SELECT * FROM leads ORDER BY last_seen DESC,wa_id").all();
export const getBooking = (id) =>
  db.prepare("SELECT * FROM bookings WHERE id=?").get(id);
export const currentBooking = (wa) =>
  db
    .prepare(
      `SELECT * FROM bookings WHERE wa_id=? AND status IN (${ACTIVE}) ORDER BY created_at DESC,rowid DESC LIMIT 1`,
    )
    .get(wa);
export const activeBookings = () =>
  db.prepare(`SELECT * FROM bookings WHERE status IN (${ACTIVE})`).all();
export const bookedSlots = () => activeBookings().map((b) => b.start);
export function reserveBooking({
  id,
  waId,
  start,
  end,
  replacesId = null,
  calendarId = null,
}) {
  return atomic(() => {
    const existing = getBooking(id);
    if (existing) return existing;
    const buffer = cfg.booking.bufferMinutes * 60000;
    const clash = db
      .prepare(
        `SELECT id FROM bookings WHERE status IN (${ACTIVE}) AND start < ? AND end > ? LIMIT 1`,
      )
      .get(
        new Date(Date.parse(end) + buffer).toISOString(),
        new Date(Date.parse(start) - buffer).toISOString(),
      );
    if (clash) return null;
    if (currentBooking(waId) && !replacesId) return null;
    if (
      replacesId &&
      (currentBooking(waId)?.id !== replacesId ||
        getBooking(replacesId)?.wa_id !== waId ||
        getBooking(replacesId)?.status !== "confirmed")
    )
      return null;
    db.prepare(
      "INSERT INTO bookings(id,wa_id,start,end,status,calendar_id,replaces_id,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?,?)",
    ).run(id, waId, start, end, calendarId, replacesId, Date.now(), Date.now());
    return getBooking(id);
  });
}
export function setBooking(id, status) {
  db.prepare("UPDATE bookings SET status=?,updated_at=? WHERE id=?").run(
    status,
    Date.now(),
    id,
  );
  return getBooking(id);
}
export function recordOffers(waId, slots) {
  db.prepare("DELETE FROM slot_offers WHERE wa_id=?").run(waId);
  return slots.map((start) => {
    const offer = {
      id: randomUUID(),
      start,
      expires_at: Date.now() + cfg.booking.offerMinutes * 60000,
    };
    db.prepare(
      "INSERT INTO slot_offers(id,wa_id,start,expires_at) VALUES (?,?,?,?)",
    ).run(offer.id, waId, start, offer.expires_at);
    return offer;
  });
}
export const getOffer = (wa, id) =>
  db
    .prepare(
      "SELECT * FROM slot_offers WHERE wa_id=? AND id=? AND expires_at>?",
    )
    .get(wa, id, Date.now());
export function audit(action, entity, detail = {}, actor = "system") {
  db.prepare(
    "INSERT INTO audit(action,entity,actor,detail,at) VALUES (?,?,?,?,?)",
  ).run(action, entity, actor, JSON.stringify(detail), Date.now());
}
export function enqueue(kind, lane, payload, key = randomUUID()) {
  return db
    .prepare(
      "INSERT OR IGNORE INTO jobs(job_key,kind,lane,payload,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      key,
      kind,
      lane,
      JSON.stringify(payload),
      Date.now(),
      Date.now(),
      Date.now(),
    ).changes;
}
export function ingest(messages, statuses = []) {
  return atomic(() => {
    let accepted = 0;
    for (const msg of messages) {
      if (
        !db
          .prepare("SELECT 1 FROM messages WHERE id=? AND direction='in'")
          .get(msg.id)
      )
        accepted += enqueue("inbox", "in:" + msg.from, msg, "in:" + msg.id);
    }
    for (const s of statuses) {
      const inserted = db
        .prepare(
          "INSERT OR IGNORE INTO delivery_events(message_id,status,timestamp,error_code) VALUES (?,?,?,?)",
        )
        .run(s.id, s.status, s.timestamp, s.errorCode || null).changes;
      if (!inserted) continue;
      const job =
        s.jobId && s.attempt
          ? db
              .prepare(
                "SELECT * FROM jobs WHERE id=? AND kind='wa' AND attempts=? AND status IN ('processing','retry','done','dead')",
              )
              .get(s.jobId, s.attempt)
          : db
              .prepare("SELECT * FROM jobs WHERE kind='wa' AND external_id=?")
              .get(s.id);
      if (!job || (job.external_id && job.external_id !== s.id)) continue;
      if (s.status !== "failed")
        db.prepare("UPDATE jobs SET external_id=? WHERE id=?").run(
          s.id,
          job.id,
        );
      else {
        db.prepare(
          "UPDATE jobs SET status='dead',last_error=?,updated_at=? WHERE id=?",
        ).run(
          "WhatsApp delivery failed: " + (s.errorCode || "unknown"),
          Date.now(),
          job.id,
        );
        audit("delivery_failed", s.id, { code: s.errorCode });
      }
    }
    return accepted;
  });
}
export function claimJob() {
  return atomic(() => {
    const job = db
      .prepare(
        `SELECT j.* FROM jobs j WHERE j.status IN ('queued','retry') AND j.available_at<=? AND NOT EXISTS (SELECT 1 FROM jobs earlier WHERE earlier.lane=j.lane AND earlier.id<j.id AND (earlier.status IN ('queued','processing','retry') OR (earlier.status='dead' AND j.kind='inbox'))) ORDER BY j.id LIMIT 1`,
      )
      .get(Date.now());
    if (!job) return null;
    db.prepare(
      "UPDATE jobs SET status='processing',attempts=attempts+1,updated_at=? WHERE id=?",
    ).run(Date.now(), job.id);
    return {
      ...job,
      attempts: job.attempts + 1,
      payload: JSON.parse(job.payload),
    };
  });
}
export function completeJob(id, externalId = null) {
  db.prepare(
    "UPDATE jobs SET status='done',updated_at=?,last_error=NULL,external_id=COALESCE(?,external_id) WHERE id=?",
  ).run(Date.now(), externalId, id);
}
export function failJob(job, error) {
  const terminal =
    error.permanent ||
    job.attempts - (job.payload._retryBase || 0) >= cfg.jobAttempts;
  const reason = String(
    error.safeMessage || error.message || "Operation failed",
  ).slice(0, 300);
  db.prepare(
    "UPDATE jobs SET status=?,available_at=?,updated_at=?,last_error=? WHERE id=?",
  ).run(
    terminal ? "dead" : "retry",
    Date.now() +
      Math.min(
        300000,
        1000 * 2 ** Math.min(20, job.attempts - (job.payload._retryBase || 0)),
      ) +
      Math.floor(Math.random() * 500),
    Date.now(),
    reason,
    job.id,
  );
  if (terminal) audit("job_failed", String(job.id), { kind: job.kind, reason });
  return terminal;
}
export function retryJob(id) {
  return db
    .prepare(
      "UPDATE jobs SET status='queued',payload=json_set(payload,'$._retryBase',attempts),available_at=?,updated_at=?,last_error=NULL,external_id=CASE WHEN kind='wa' THEN NULL ELSE external_id END WHERE id=? AND status='dead'",
    )
    .run(Date.now(), Date.now(), id).changes;
}

/* ------------------------------------------------------------------ imports
 * Chat exports a shop owner forwards to us, and supplier contact cards.
 *
 * Nothing here keeps a document we were not invited to keep: a batch only
 * reaches 'stored' when the contact has an import consent record, and the
 * verbatim text is dropped at 'purged' while the derived counts survive.
 */

export const getBatch = (id) =>
  db.prepare("SELECT * FROM import_batch WHERE id=?").get(id);

export const batchesFor = (waId) =>
  db
    .prepare(
      "SELECT id,wa_id,filename,mime_type,bytes,state,reason,supplier_label,summary,consent_at,retention_expires_at,purged_at,created_at,updated_at,raw IS NOT NULL AS has_raw FROM import_batch WHERE wa_id=? ORDER BY created_at DESC",
    )
    .all(waId);

export function openBatch({ id, waId, messageId, media }) {
  const now = Date.now();
  const changes = db
    .prepare(
      "INSERT OR IGNORE INTO import_batch(id,wa_id,message_id,media_id,filename,mime_type,bytes,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?, 'pending',?,?)",
    )
    .run(
      id,
      waId,
      messageId,
      media.id || null,
      media.filename || null,
      media.mimeType || null,
      media.bytes || null,
      now,
      now,
    ).changes;
  return changes ? getBatch(id) : null;
}

export function updateBatch(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return getBatch(id);
  const allowed = new Set([
    "raw",
    "state",
    "reason",
    "supplier_label",
    "summary",
    "sha256",
    "bytes",
    "consent_at",
    "consent_method",
    "retention_expires_at",
    "purged_at",
  ]);
  if (keys.some((k) => !allowed.has(k))) throw new Error("Invalid batch field");
  db.prepare(
    `UPDATE import_batch SET ${keys.map((k) => `${k}=@${k}`).join(",")}, updated_at=@updated_at WHERE id=@id`,
  ).run({ ...patch, id, updated_at: Date.now() });
  return getBatch(id);
}

/**
 * Drop the verbatim export, keep the derived summary.
 *
 * This is the retention promise made to the shop owner at the visit, so it
 * runs on a clock rather than on someone remembering.
 */
export function purgeBatch(id) {
  return db
    .prepare(
      "UPDATE import_batch SET raw=NULL,state='purged',purged_at=?,updated_at=? WHERE id=? AND raw IS NOT NULL",
    )
    .run(Date.now(), Date.now(), id).changes;
}

export function purgeExpiredBatches(now = Date.now()) {
  const due = db
    .prepare(
      "SELECT id FROM import_batch WHERE raw IS NOT NULL AND retention_expires_at IS NOT NULL AND retention_expires_at<=?",
    )
    .all(now);
  for (const row of due) {
    purgeBatch(row.id);
    audit("import_purged", row.id, { reason: "retention" });
  }
  return due.length;
}

export function captureSupplierContact({ id, waId, name, phone, messageId }) {
  const now = Date.now();
  const inserted = db
    .prepare(
      "INSERT OR IGNORE INTO supplier_contact(id,wa_id,name,phone,state,message_id,created_at,updated_at) VALUES (?,?,?,?, 'captured',?,?,?)",
    )
    .run(id, waId, name || null, phone, messageId || null, now, now).changes;
  return Boolean(inserted);
}

export const supplierContactsFor = (waId) =>
  db
    .prepare(
      "SELECT * FROM supplier_contact WHERE wa_id=? ORDER BY created_at DESC",
    )
    .all(waId);

export function setSupplierContactState(id, state) {
  return db
    .prepare(
      "UPDATE supplier_contact SET state=?,updated_at=? WHERE id=? AND state='captured'",
    )
    .run(state, Date.now(), id).changes;
}

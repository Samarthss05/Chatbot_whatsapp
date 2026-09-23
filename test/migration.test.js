import test, { after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "ledger-migration-"));
const path = join(dir, "legacy.db");
const old = new Database(path);
old.exec(`CREATE TABLE leads (wa_id TEXT PRIMARY KEY,name TEXT,lang TEXT DEFAULT 'en',state TEXT DEFAULT 'NEW',shop_name TEXT,shop_address TEXT,slot_iso TEXT,calendar_id TEXT,source TEXT,first_seen TEXT DEFAULT (datetime('now')),last_seen TEXT DEFAULT (datetime('now')),human_takeover INTEGER DEFAULT 0,notes TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY,wa_id TEXT,direction TEXT,body TEXT,at TEXT DEFAULT (datetime('now')));
CREATE TABLE offers (wa_id TEXT,slot_iso TEXT,offered TEXT,PRIMARY KEY(wa_id,slot_iso));
INSERT INTO leads(wa_id,name,state,human_takeover,slot_iso,calendar_id) VALUES ('6593330001','Existing shop','HUMAN',1,'2030-01-02T06:00:00.000Z','legacy-event');
INSERT INTO messages(id,wa_id,direction,body) VALUES ('legacy-message','6593330001','in','Existing private conversation');`);
old.close();
process.env.DB_FILE = path;
process.env.DRY_RUN = "1";
const { db, migrate, ingest, activeBookings, getLead } = await import(
  "../src/store.js"
);
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
test("legacy data migrates without losing reservations, history, or takeover", () => {
  assert.equal(db.pragma("user_version", { simple: true }), 3);
  assert.equal(getLead("6593330001").human_takeover, 1);
  assert.equal(activeBookings().length, 1);
  assert.equal(activeBookings()[0].calendar_id, "legacy-event");
  assert.equal(
    db.prepare("SELECT body FROM messages").get().body,
    "Existing private conversation",
  );
  migrate();
  assert.equal(activeBookings().length, 1);
});
test("import columns and tables arrive empty on an upgraded database", () => {
  const lead = getLead("6593330001");
  // Present, and null: an upgrade never implies a consent nobody gave.
  assert.equal(lead.outlet_id, null);
  assert.equal(lead.import_consent_at, null);
  for (const table of ["import_batch", "supplier_contact"])
    assert.equal(
      db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
      0,
      `${table} should exist and be empty`,
    );
  migrate(); // idempotent
  assert.equal(db.pragma("user_version", { simple: true }), 3);
});
test("legacy webhook IDs remain deduplicated after upgrade", () => {
  ingest([
    {
      id: "legacy-message",
      from: "6593330001",
      text: "Existing private conversation",
    },
  ]);
  assert.equal(db.prepare("SELECT count(*) n FROM jobs").get().n, 0);
});
test("online backup includes committed data and passes SQLite integrity check", async () => {
  const target = join(dir, "backup.db");
  await db.backup(target);
  const backup = new Database(target, { readonly: true });
  assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
  assert.equal(backup.prepare("SELECT count(*) n FROM bookings").get().n, 1);
  backup.close();
});

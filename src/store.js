import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE = process.env.DB_FILE || './data/ledgerbot.db';
mkdirSync(dirname(FILE), { recursive: true });

export const db = new Database(FILE);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  wa_id         TEXT PRIMARY KEY,
  name          TEXT,
  lang          TEXT DEFAULT 'en',
  state         TEXT DEFAULT 'NEW',
  shop_name     TEXT,
  shop_address  TEXT,
  slot_iso      TEXT,
  calendar_id   TEXT,
  source        TEXT,
  first_seen    TEXT DEFAULT (datetime('now')),
  last_seen     TEXT DEFAULT (datetime('now')),
  human_takeover INTEGER DEFAULT 0,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  wa_id     TEXT,
  direction TEXT,
  body      TEXT,
  at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offers (
  wa_id    TEXT,
  slot_iso TEXT,
  offered  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (wa_id, slot_iso)
);
`);

const _get = db.prepare('SELECT * FROM leads WHERE wa_id = ?');
const _ins = db.prepare(`INSERT INTO leads (wa_id, name, lang, source) VALUES (?, ?, ?, ?)`);
const _touch = db.prepare(`UPDATE leads SET last_seen = datetime('now') WHERE wa_id = ?`);
const _seen = db.prepare('SELECT 1 FROM messages WHERE id = ?');
const _logMsg = db.prepare('INSERT OR IGNORE INTO messages (id, wa_id, direction, body) VALUES (?, ?, ?, ?)');

export function getLead(waId) {
  return _get.get(waId);
}

export function upsertLead(waId, { name, lang, source } = {}) {
  let lead = _get.get(waId);
  if (!lead) {
    _ins.run(waId, name ?? null, lang ?? 'en', source ?? null);
    lead = _get.get(waId);
  } else {
    _touch.run(waId);
  }
  return lead;
}

export function updateLead(waId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return getLead(waId);
  const sets = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE leads SET ${sets}, last_seen = datetime('now') WHERE wa_id = @wa_id`)
    .run({ ...patch, wa_id: waId });
  return getLead(waId);
}

/** WhatsApp retries webhooks. Returns true the first time only. */
export function firstTimeSeeing(messageId) {
  if (!messageId) return true;
  if (_seen.get(messageId)) return false;
  return true;
}

export function logMessage(id, waId, direction, body) {
  _logMsg.run(id ?? `${direction}-${Date.now()}-${Math.random()}`, waId, direction, body ?? '');
}

export function recordOffers(waId, slots) {
  const stmt = db.prepare('INSERT OR REPLACE INTO offers (wa_id, slot_iso) VALUES (?, ?)');
  const tx = db.transaction(list => list.forEach(s => stmt.run(waId, s)));
  tx(slots);
}

export function wasOffered(waId, iso) {
  return Boolean(db.prepare('SELECT 1 FROM offers WHERE wa_id = ? AND slot_iso = ?').get(waId, iso));
}

export function allLeads() {
  return db.prepare('SELECT * FROM leads ORDER BY last_seen DESC').all();
}

export function bookedSlots() {
  return db.prepare(`SELECT slot_iso FROM leads WHERE slot_iso IS NOT NULL AND state = 'BOOKED'`)
    .all().map(r => r.slot_iso);
}

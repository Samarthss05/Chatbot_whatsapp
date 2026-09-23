/**
 * Runs the whole conversation without touching WhatsApp.
 *   DRY_RUN=1 npm run simulate
 * Outbound messages are printed, not sent.
 */
process.env.DRY_RUN = '1';
process.env.DB_FILE = process.env.DB_FILE || './data/simulate.db';

import { rmSync } from 'node:fs';
try { rmSync('./data/simulate.db', { force: true }); } catch {}
try { rmSync('./data/simulate.db-wal', { force: true }); } catch {}
try { rmSync('./data/simulate.db-shm', { force: true }); } catch {}

const { handleMessage } = await import('../src/flow.js');
const { getLead, db } = await import('../src/store.js');

let n = 0;
const inbound = (from, text, replyId) => ({
  id: `sim-${++n}`, from, name: 'Test Shop', type: replyId ? 'interactive' : 'text', text, replyId,
});

function show(title) {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

function offeredSlot(waId, i = 0) {
  const row = db.prepare('SELECT slot_iso FROM offers WHERE wa_id = ? ORDER BY slot_iso').all(waId)[i];
  return row?.slot_iso;
}

const A = '6591110001'; // English, books cleanly
const B = '6591110002'; // Chinese poster, asks a question
const C = '6591110003'; // Malay poster, declines

show('A: scans the English QR');
await handleMessage(inbound(A, 'Hi Ledger, I saw your poster. Tell me more.'));
console.log('state =', getLead(A).state, '| lang =', getLead(A).lang);

show('A: taps the first slot');
await handleMessage(inbound(A, 'Tue 24 Sep, 2:00pm', 'slot|' + offeredSlot(A, 0)));
console.log('state =', getLead(A).state, '| slot =', getLead(A).slot_iso);

show('A: sends shop name and unit');
await handleMessage(inbound(A, 'Ah Seng Provisions, Blk 824 Tampines St 81 #01-24'));
const a = getLead(A);
console.log('state =', a.state, '| shop =', a.shop_name, '| addr =', a.shop_address);

show('A: messages again after booking');
await handleMessage(inbound(A, 'Can I change to Thursday?'));
console.log('state =', getLead(A).state, '| human =', getLead(A).human_takeover);

show('B: scans the Chinese QR');
await handleMessage(inbound(B, '你好,想了解 Ledger。'));
console.log('state =', getLead(B).state, '| lang =', getLead(B).lang);

show('B: taps "another time"');
await handleMessage(inbound(B, '其他时间', 'other_time'));
console.log('state =', getLead(B).state, '| human =', getLead(B).human_takeover);

show('C: scans the Malay QR');
await handleMessage(inbound(C, 'Hi Ledger, saya nampak poster anda. Nak tahu lebih lanjut.'));
console.log('state =', getLead(C).state, '| lang =', getLead(C).lang);

show('C: free text (no classifier configured -> human)');
await handleMessage(inbound(C, 'Berapa harga selepas percuma?'));
console.log('state =', getLead(C).state, '| human =', getLead(C).human_takeover);

show('Duplicate webhook delivery is ignored');
const dup = inbound(A, 'duplicate');
dup.id = 'sim-1';
const { firstTimeSeeing } = await import('../src/store.js');
console.log('firstTimeSeeing("sim-1") =', firstTimeSeeing('sim-1'), '(expect false)');

show('Pipeline');
for (const l of db.prepare('SELECT wa_id, lang, state, shop_name, slot_iso FROM leads').all()) {
  console.log(' ', l.wa_id, '|', l.lang, '|', l.state, '|', l.shop_name ?? '-', '|', l.slot_iso ?? '-');
}
console.log();

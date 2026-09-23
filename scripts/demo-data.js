import { randomUUID } from "node:crypto";
import { db, ingest, updateLead, audit } from "../src/store.js";
import { drain } from "../src/worker.js";
async function send(from, name, text, replyId) {
  ingest([
    {
      id: randomUUID(),
      from,
      name,
      type: replyId ? "interactive" : "text",
      text,
      replyId,
      timestamp: Date.now(),
    },
  ]);
  await drain();
}
export async function seedDemo() {
  if (db.prepare("SELECT count(*) n FROM leads").get().n) return;
  const people = [
    ["6590001001", "Mei Lin", "Lotus Provisions, Blk 824 #01-24"],
    ["6590001002", "Arif", "Arif’s Corner Shop, 18 Market Street"],
    ["6590001003", "Jia Wei", "Everyday Goods, 62 Garden Road"],
  ];
  for (const [id, name, details] of people) {
    await send(id, name, "Hello");
    const offer = db
      .prepare("SELECT * FROM slot_offers WHERE wa_id=? ORDER BY start")
      .get(id);
    if (offer) {
      await send(id, name, "Choose this time", "slot:" + offer.id);
      await send(id, name, details);
    }
  }
  await send("6590001004", "Priya", "Hello");
  await send("6590001004", "Priya", "Can I talk to a person?");
  updateLead("6590001004", {
    notes: "Demo contact. Prefers a quick call before choosing a visit time.",
  });
  await send("6590001005", "陈叔", "你好，想了解 Ledger");
  const o = db
    .prepare("SELECT * FROM slot_offers WHERE wa_id=? ORDER BY start")
    .get("6590001005");
  if (o) await send("6590001005", "陈叔", "这个时间", "slot:" + o.id);
  await send("6590001006", "Daniel", "Hi");
  audit("demo_loaded", null, { synthetic: true });
}

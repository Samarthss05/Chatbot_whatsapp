// An in-memory database and a hard network block make simulation safe even with a live .env.
process.env.NODE_ENV = "development";
process.env.DRY_RUN = "1";
process.env.DB_FILE = ":memory:";
process.env.OWNER_WHATSAPP = "";
process.env.NOTIFY_WEBHOOK = "";
globalThis.fetch = async () => {
  throw new Error("Simulation attempted an external request");
};
const { seedDemo } = await import("./demo-data.js");
const { db } = await import("../src/store.js");
await seedDemo();
console.table(
  db
    .prepare(
      "SELECT name,lang,state,shop_name,slot_iso FROM leads ORDER BY wa_id",
    )
    .all(),
);
console.log(
  "Simulation complete. No files changed, no messages sent, no external calls.",
);
db.close();

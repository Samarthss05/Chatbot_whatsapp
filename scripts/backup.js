import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { db } from "../src/store.js";
const destination = resolve(
  process.argv[2] ||
    `./data/backups/ledger-${new Date().toISOString().replace(/[:.]/g, "-")}.db`,
);
mkdirSync(dirname(destination), { recursive: true });
try {
  await db.backup(destination);
  console.log("Consistent SQLite backup saved to " + destination);
} finally {
  db.close();
}

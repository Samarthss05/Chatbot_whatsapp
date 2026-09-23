import { randomUUID } from "node:crypto";
import { cfg } from "./config.js";
import { db, enqueue } from "./store.js";
/** Always visible in the operator inbox. Webhook delivery is independently retried. */
export function notifyOwner(body, { wa_id = null } = {}) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO notifications(id,body,wa_id,created_at) VALUES (?,?,?,?)",
  ).run(id, body, wa_id, Date.now());
  if (cfg.notifyWebhook && !cfg.dryRun)
    enqueue("notify", "notify", { text: body, wa_id }, "notify:" + id);
}

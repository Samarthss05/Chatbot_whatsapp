import { randomUUID } from "node:crypto";
import { cfg, calendarEnabled } from "./config.js";
import {
  db,
  atomic,
  claimJob,
  completeJob,
  failJob,
  getLead,
  getBooking,
  getOffer,
  logMessage,
  audit,
  getBatch,
  updateBatch,
  purgeExpiredBatches,
} from "./store.js";
import { handleMessage, finishBooking, finishCancellation } from "./flow.js";
import { createEvent, updateEvent, deleteEvent } from "./calendar.js";
import { deliver, fetchMediaText } from "./whatsapp.js";
import { parseExport, looksLikeExport } from "./import.js";
import { notifyOwner } from "./notify.js";
import { ServiceError } from "./http.js";
export async function processJob(job) {
  try {
    const p = job.payload;
    if (job.kind === "inbox") return await handleMessage(p, job.id);
    if (job.kind === "wa") {
      const lead = getLead(p.waId);
      const offerId =
        p.payload.interactive?.type === "list"
          ? p.payload.interactive.action.sections[0]?.rows[0]?.id
          : null;
      const obsolete =
        (p.bookingId && getBooking(p.bookingId)?.status !== p.bookingStatus) ||
        (offerId?.startsWith("slot:") && !getOffer(p.waId, offerId.slice(5)));
      if (
        (p.automated && lead?.human_takeover) ||
        (lead?.state === "DECLINED" && !p.allowOptOut) ||
        obsolete
      ) {
        atomic(() => {
          completeJob(job.id);
          audit("reply_suppressed", String(job.id), {
            reason: obsolete ? "obsolete" : "human_takeover_or_opt_out",
          });
        });
        return;
      }
      if (
        !cfg.dryRun &&
        (!lead?.last_inbound_at ||
          Date.now() - lead.last_inbound_at >= 24 * 3600000)
      )
        throw new ServiceError(
          "WhatsApp reply window expired; a new inbound message is required",
          null,
          true,
        );
      // Status webhooks may already have reconciled a timed-out previous attempt.
      const known = db
        .prepare("SELECT external_id FROM jobs WHERE id=?")
        .get(job.id)?.external_id;
      const result = known
        ? { messages: [{ id: known }] }
        : await deliver(p.payload, job.id, job.attempts);
      const externalId = result?.messages?.[0]?.id;
      if (!externalId) throw new ServiceError("WhatsApp response");
      atomic(() => {
        logMessage(
          "out:" + job.id + ":" + externalId,
          p.waId,
          "out",
          p.payload.text?.body || p.payload.interactive?.body?.text || "",
          p.payload.type,
          externalId,
        );
        completeJob(job.id, externalId);
        const failure = db
          .prepare(
            "SELECT error_code FROM delivery_events WHERE message_id=? AND status='failed' ORDER BY timestamp DESC LIMIT 1",
          )
          .get(externalId);
        if (failure)
          db.prepare(
            "UPDATE jobs SET status='dead',last_error=? WHERE id=?",
          ).run(
            "WhatsApp delivery failed: " + (failure.error_code || "unknown"),
            job.id,
          );
      });
      return;
    }
    if (job.kind.startsWith("calendar_")) {
      const booking = getBooking(p.bookingId);
      if (!booking)
        throw new ServiceError("Appointment no longer exists", null, true);
      if (!calendarEnabled)
        throw new ServiceError(
          "Calendar credentials are required to finish this operation",
          null,
          true,
        );
      if (job.kind === "calendar_create" && booking.status === "pending") {
        await createEvent(booking, getLead(booking.wa_id));
        atomic(() => {
          finishBooking(booking.id);
          completeJob(job.id);
        });
        return;
      }
      if (
        job.kind === "calendar_cancel" &&
        booking.status === "cancel_pending"
      ) {
        await deleteEvent(booking);
        atomic(() => {
          finishCancellation(booking.id, { silent: p.silent });
          completeJob(job.id);
        });
        return;
      }
      if (job.kind === "calendar_update" && booking.status === "confirmed")
        await updateEvent(booking, getLead(booking.wa_id));
      completeJob(job.id);
      return;
    }
    /**
     * Download a chat export and record what it contains.
     *
     * The media id is resolved on every attempt rather than carried in the
     * payload, because the download URL behind it expires in minutes while the
     * id itself lives for about a month. A retry tomorrow still works.
     */
    if (job.kind === "import_fetch") {
      const batch = getBatch(p.batchId);
      if (!batch) throw new ServiceError("Import no longer exists", null, true);
      if (batch.state !== "pending") {
        completeJob(job.id);
        return;
      }
      if (cfg.dryRun) {
        atomic(() => {
          updateBatch(batch.id, { state: "failed", reason: "demo_mode" });
          completeJob(job.id);
        });
        return;
      }
      const file = await fetchMediaText(batch.media_id, {
        maxBytes: cfg.imports.maxBytes,
      });
      if (!looksLikeExport(file.text)) {
        atomic(() => {
          updateBatch(batch.id, {
            state: "rejected",
            reason: "not_a_chat_export",
          });
          audit("import_rejected", batch.id, { reason: "not_a_chat_export" });
          notifyOwner(
            "A forwarded file did not look like a chat export, so nothing was kept.",
            { wa_id: batch.wa_id },
          );
          completeJob(job.id);
        });
        return;
      }
      const { meta } = parseExport(file.text);
      atomic(() => {
        updateBatch(batch.id, {
          raw: file.text,
          sha256: file.sha256,
          bytes: file.bytes,
          state: "stored",
          summary: JSON.stringify(meta),
        });
        audit("import_stored", batch.id, {
          messages: meta.messageCount,
          days: meta.distinctDays,
        });
        notifyOwner(
          `Chat export ready to review: ${meta.messageCount} messages across ${meta.distinctDays} days.`,
          { wa_id: batch.wa_id },
        );
        completeJob(job.id);
      });
      return;
    }
    if (job.kind === "notify") {
      if (!cfg.dryRun && cfg.notifyWebhook) {
        let res;
        try {
          res = await fetch(cfg.notifyWebhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(p),
            signal: AbortSignal.timeout(8000),
          });
        } catch {
          throw new ServiceError("Notification webhook");
        }
        if (!res.ok)
          throw new ServiceError(
            "Notification webhook",
            res.status,
            res.status >= 400 && res.status < 500 && res.status !== 429,
          );
      }
      completeJob(job.id);
      return;
    }
    throw new ServiceError("Unknown job type", null, true);
  } catch (error) {
    atomic(() => {
      if (
        db.prepare("SELECT status FROM jobs WHERE id=?").get(job.id)?.status ===
        "done"
      )
        return;
      if (failJob(job, error)) {
        const id = randomUUID(),
          wa =
            job.payload.waId ||
            job.payload.from ||
            getBooking(job.payload.bookingId)?.wa_id ||
            null;
        db.prepare(
          "INSERT INTO notifications(id,body,wa_id,created_at) VALUES (?,?,?,?)",
        ).run(
          id,
          `Action needs attention: ${job.kind}. ${error.safeMessage || "Processing failed. Check the activity log."}`,
          wa,
          Date.now(),
        );
      }
    });
    console.error(
      JSON.stringify({
        event: "job_error",
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        error: error.safeMessage || "Internal processing error",
      }),
    );
  }
}
export async function drain(limit = 1000) {
  let count = 0;
  for (; count < limit; count++) {
    const job = claimJob();
    if (!job) break;
    await processJob(job);
  }
  return count;
}
export function startWorker() {
  const owner = randomUUID();
  let stopping = false,
    active = null,
    lastTick = Date.now();
  const acquire = () =>
    db
      .prepare(
        "INSERT INTO worker_lock(id,owner,expires_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE worker_lock.expires_at<=? OR worker_lock.owner=?",
      )
      .run(owner, Date.now() + 60000, Date.now(), owner).changes;
  if (!acquire())
    throw new Error(
      "Another worker owns this database. Run one instance, or wait 60 seconds after a crash.",
    );
  db.prepare(
    "UPDATE jobs SET status='queued',available_at=?,updated_at=? WHERE status='processing'",
  ).run(Date.now(), Date.now());
  const heartbeat = setInterval(() => {
    try {
      if (!acquire()) stopping = true;
    } catch {
      stopping = true;
    }
  }, 10000);
  heartbeat.unref();
  /**
   * Retention runs here rather than in the HTTP process because the worker
   * holds the lease, so exactly one instance purges. A promise made to a shop
   * owner about how long we keep their chat should not depend on anyone
   * remembering to run something.
   */
  const sweep = () => {
    try {
      purgeExpiredBatches();
    } catch {
      console.error(JSON.stringify({ event: "retention_sweep_failed" }));
    }
  };
  sweep();
  const retention = setInterval(sweep, 3600000);
  retention.unref();
  const tick = async () => {
    if (stopping || active) return;
    lastTick = Date.now();
    active = (async () => {
      const job = claimJob();
      if (job) await processJob(job);
    })();
    try {
      await active;
    } catch {
      console.error(JSON.stringify({ event: "worker_error" }));
    } finally {
      active = null;
    }
  };
  const timer = setInterval(tick, cfg.pollMs);
  timer.unref();
  void tick();
  return {
    status: () => ({ running: !stopping, lastTick }),
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      clearInterval(heartbeat);
      clearInterval(retention);
      await active;
      db.prepare("DELETE FROM worker_lock WHERE owner=?").run(owner);
    },
  };
}

import express from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { cfg, calendarEnabled, brainEnabled } from "./config.js";
import { verifySignature, parseWebhook } from "./whatsapp.js";
import {
  db,
  atomic,
  ingest,
  getLead,
  updateLead,
  currentBooking,
  getBooking,
  history,
  audit,
  retryJob,
} from "./store.js";
import { cancelBooking } from "./flow.js";
import { say } from "./messaging.js";
const safeEqual = (a, b) => {
  if (typeof a !== "string" || !b) return false;
  const x = crypto.createHash("sha256").update(a).digest(),
    y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
export function createApp({ workerStatus = () => ({ running: true }) } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Cache-Control": "no-store",
    });
    next();
  });
  app.use(
    express.json({
      limit: "512kb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/ready", (_req, res) => {
    db.prepare("SELECT 1").get();
    const ready = workerStatus().running;
    res.status(ready ? 200 : 503).json({ ok: ready });
  });
  app.get("/webhook", (req, res) => {
    if (
      req.query["hub.mode"] === "subscribe" &&
      safeEqual(req.query["hub.verify_token"], cfg.wa.verifyToken) &&
      typeof req.query["hub.challenge"] === "string"
    )
      return res
        .status(200)
        .type("text/plain")
        .send(req.query["hub.challenge"]);
    res.sendStatus(403);
  });
  app.post("/webhook", (req, res) => {
    if (!verifySignature(req.rawBody, req.get("x-hub-signature-256")))
      return res.sendStatus(401);
    const { messages, statuses } = parseWebhook(req.body);
    ingest(messages, statuses); // Commit to disk BEFORE acknowledging Meta.
    res.sendStatus(200);
  });
  const failures = new Map();
  const auth = (req, res, next) => {
    const now = Date.now(),
      ip = req.socket.remoteAddress;
    let item = failures.get(ip);
    if (item && now - item.at > 60000) {
      failures.delete(ip);
      item = null;
    }
    if (item?.count >= 20)
      return res
        .status(429)
        .set("Retry-After", "60")
        .json({ error: "Too many sign-in attempts. Try again in a minute." });
    if (!safeEqual(req.get("x-admin-token"), cfg.adminToken)) {
      if (failures.size > 10000) failures.clear();
      failures.set(ip, { at: item?.at || now, count: (item?.count || 0) + 1 });
      return res
        .status(401)
        .json({ error: "Enter a valid operator access token." });
    }
    failures.delete(ip);
    next();
  };
  app.use("/api", auth);
  app.get("/api/overview", (_req, res) => {
    const states = db
      .prepare("SELECT state,COUNT(*) count FROM leads GROUP BY state")
      .all();
    const queues = db
      .prepare("SELECT status,COUNT(*) count FROM jobs GROUP BY status")
      .all();
    res.json({
      activeCount: db
        .prepare(
          "SELECT COUNT(*) n FROM bookings WHERE status IN ('pending','confirmed','cancel_pending') AND end>?",
        )
        .get(new Date().toISOString()).n,
      mode: cfg.dryRun ? "demo" : "live",
      timezone: cfg.booking.tz,
      calendar: calendarEnabled,
      llm: brainEnabled,
      worker: workerStatus(),
      states,
      queues,
      upcoming: db
        .prepare(
          "SELECT b.*,l.name,l.shop_name,l.shop_address,l.lang FROM bookings b JOIN leads l ON l.wa_id=b.wa_id WHERE b.status IN ('pending','confirmed','cancel_pending') AND b.end>? ORDER BY b.start LIMIT 30",
        )
        .all(new Date().toISOString()),
      notifications: db
        .prepare(
          "SELECT * FROM notifications ORDER BY created_at DESC LIMIT 30",
        )
        .all(),
    });
  });
  app.get("/api/leads", (req, res) => {
    const q = String(req.query.q || "").slice(0, 100),
      state = String(req.query.state || "");
    const page = Math.max(
      0,
      Math.min(100000, Number.parseInt(req.query.page) || 0),
    );
    const where =
      "WHERE (?='' OR wa_id LIKE ? OR name LIKE ? OR shop_name LIKE ?) AND (?='' OR state=?)";
    const args = [q, "%" + q + "%", "%" + q + "%", "%" + q + "%", state, state];
    res.json({
      items: db
        .prepare(
          `SELECT * FROM leads ${where} ORDER BY last_seen DESC,wa_id LIMIT 50 OFFSET ?`,
        )
        .all(...args, page * 50),
      total: db.prepare(`SELECT COUNT(*) n FROM leads ${where}`).get(...args).n,
      page,
    });
  });
  app.get("/api/leads/:id", (req, res) => {
    const lead = getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: "Conversation not found" });
    const messages = history(lead.wa_id, 100).map((m) => ({
      ...m,
      delivery:
        db
          .prepare(
            "SELECT status,error_code FROM delivery_events WHERE message_id=? ORDER BY timestamp DESC LIMIT 1",
          )
          .get(m.external_id) || null,
    }));
    res.json({
      lead,
      messages,
      bookings: db
        .prepare(
          "SELECT * FROM bookings WHERE wa_id=? ORDER BY created_at DESC",
        )
        .all(lead.wa_id),
      canReply: cfg.dryRun || Date.now() - lead.last_inbound_at < 24 * 3600000,
    });
  });
  app.post("/api/leads/:id/:action", (req, res) => {
    const lead = getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: "Conversation not found" });
    const action = req.params.action;
    if (!["takeover", "resume", "notes", "reply"].includes(action))
      return res.status(404).json({ error: "Unknown action" });
    if (action === "resume" && lead.state === "DECLINED")
      return res.status(409).json({
        error:
          "This contact opted out. They must send START or BOOK to opt in again.",
      });
    if (action === "reply") {
      if (
        typeof req.body?.text !== "string" ||
        !req.body.text.trim() ||
        Array.from(req.body.text).length > 4096
      )
        return res
          .status(400)
          .json({ error: "Enter a message of 1–4096 characters." });
      if (!cfg.dryRun && Date.now() - lead.last_inbound_at >= 24 * 3600000)
        return res.status(409).json({
          error:
            "The reply window is closed. Wait for a new message from the contact.",
        });
      if (lead.state === "DECLINED")
        return res.status(409).json({ error: "This contact has opted out." });
    }
    if (
      action === "notes" &&
      (typeof req.body?.notes !== "string" || req.body.notes.length > 4000)
    )
      return res
        .status(400)
        .json({ error: "Notes must be under 4,000 characters." });
    atomic(() => {
      if (action === "takeover")
        updateLead(lead.wa_id, { state: "HUMAN", human_takeover: 1 });
      if (action === "resume") {
        const b = currentBooking(lead.wa_id);
        const state = b
          ? b.status === "confirmed"
            ? lead.shop_name && lead.shop_address
              ? "BOOKED"
              : "AWAITING_DETAILS"
            : "BOOKING_PENDING"
          : "NEW";
        updateLead(lead.wa_id, { human_takeover: 0, state });
      }
      if (action === "notes") updateLead(lead.wa_id, { notes: req.body.notes });
      if (action === "reply") {
        updateLead(lead.wa_id, { state: "HUMAN", human_takeover: 1 });
        say(lead.wa_id, req.body.text.trim(), { automated: false });
      }
      audit("operator_" + action, lead.wa_id, {}, "operator");
    });
    res.json({ ok: true });
  });
  app.post("/api/bookings/:id/cancel", (req, res) => {
    const booking = getBooking(req.params.id);
    if (!booking)
      return res.status(404).json({ error: "Appointment not found" });
    if (booking.status !== "confirmed")
      return res.status(409).json({
        error:
          "Only confirmed appointments can be cancelled. Check pending actions first.",
      });
    atomic(() => {
      cancelBooking(booking.id, { silent: true });
      audit("operator_cancel", booking.id, {}, "operator");
    });
    res.json({ ok: true });
  });
  app.get("/api/jobs", (_req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id,kind,lane,status,attempts,last_error,created_at,updated_at FROM jobs WHERE status!='done' ORDER BY CASE status WHEN 'dead' THEN 0 ELSE 1 END,id DESC LIMIT 100",
        )
        .all(),
    ),
  );
  app.post("/api/jobs/:id/retry", (req, res) => {
    const id = Number(req.params.id);
    const changed = atomic(() => {
      const result = retryJob(id);
      if (result) audit("operator_retry", String(id), {}, "operator");
      return result;
    });
    if (!changed)
      return res
        .status(409)
        .json({ error: "Only failed actions can be retried." });
    res.json({ ok: true });
  });
  app.get("/api/activity", (_req, res) =>
    res.json(
      db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100").all(),
    ),
  );
  app.post("/api/notifications/:id/read", (req, res) => {
    db.prepare("UPDATE notifications SET read_at=? WHERE id=?").run(
      Date.now(),
      req.params.id,
    );
    res.json({ ok: true });
  });
  app.get("/api/export", (_req, res) => {
    const columns = [
      "wa_id",
      "name",
      "lang",
      "state",
      "shop_name",
      "shop_address",
      "slot_iso",
      "first_seen",
      "last_seen",
    ];
    const cell = (v) =>
      '"' +
      String(v ?? "")
        .replace(/^[=+\-@\t\r]/, "'" + "$&")
        .replaceAll('"', '""') +
      '"';
    const rows = db
      .prepare("SELECT * FROM leads ORDER BY last_seen DESC")
      .all();
    res
      .type("text/csv")
      .attachment("ledger-leads.csv")
      .send(
        [
          columns.join(","),
          ...rows.map((r) => columns.map((k) => cell(r[k])).join(",")),
        ].join("\r\n"),
      );
  });
  app.get("/leads", auth, (_req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM leads ORDER BY last_seen DESC LIMIT 1000")
        .all(),
    ),
  );
  app.use(
    express.static(fileURLToPath(new URL("../public/", import.meta.url)), {
      index: "index.html",
    }),
  );
  app.use((err, _req, res, _next) => {
    const status =
      err.type === "entity.too.large"
        ? 413
        : err instanceof SyntaxError
          ? 400
          : 500;
    console.error(JSON.stringify({ event: "request_error", status }));
    res.status(status).json({
      error:
        status === 500
          ? "Something went wrong. Check server health and activity."
          : "Invalid request body.",
    });
  });
  return app;
}

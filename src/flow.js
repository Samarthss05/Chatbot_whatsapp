import { createHash, randomUUID } from "node:crypto";
import { cfg, calendarEnabled } from "./config.js";
import {
  db,
  atomic,
  getLead,
  upsertLead,
  updateLead,
  logMessage,
  history,
  currentBooking,
  getBooking,
  reserveBooking,
  setBooking,
  recordOffers,
  getOffer,
  audit,
  enqueue,
  completeJob,
  openBatch,
  updateBatch,
  captureSupplierContact,
} from "./store.js";
import { pickSlots, label, slotEnd } from "./slots.js";
import { freeBusy } from "./calendar.js";
import { detectLang, t } from "./copy.js";
import { classify, rules } from "./brain.js";
import { say, list, buttons } from "./messaging.js";
import { notifyOwner } from "./notify.js";
const languageCommand = (text) =>
  ({
    english: "en",
    中文: "zh",
    华语: "zh",
    mandarin: "zh",
    malay: "ms",
    "bahasa melayu": "ms",
  })[text.toLowerCase().trim()];
/** WhatsApp exports arrive as plain text. A .zip means they kept the media. */
const EXPORTABLE = (doc) =>
  /^text\/plain/i.test(doc.mimeType || "") ||
  /\.txt$/i.test(doc.filename || "");

/**
 * Capture a chat export or a supplier contact card.
 *
 * Runs BEFORE the human-takeover check on purpose. During onboarding an
 * operator has almost always taken the conversation over, and that is exactly
 * when the owner is sitting there forwarding their supplier threads. Handled
 * after the check, every one of them would be swallowed into "awaiting a
 * person" and lost. Capture is not a conversational reply, so the two-turn
 * handover rule does not apply to it; the acknowledgement still respects it.
 *
 * Returns true when the message was an attachment and needs nothing else.
 */
function captureAttachment(lead, msg) {
  const quiet = Boolean(lead.human_takeover);
  const ack = (key) => {
    if (!quiet) say(lead.wa_id, t(lead.lang, key));
  };

  if (msg.contacts?.length) {
    let saved = 0;
    for (const card of msg.contacts) {
      // Their own card, and ours, are not suppliers.
      if (card.phone === lead.wa_id || card.phone === cfg.owner.whatsapp)
        continue;
      if (
        captureSupplierContact({
          id: randomUUID(),
          waId: lead.wa_id,
          name: card.name,
          phone: card.phone,
          messageId: msg.id,
        })
      )
        saved++;
    }
    audit("supplier_contact_captured", lead.wa_id, {
      saved,
      offered: msg.contacts.length,
    });
    if (saved) {
      notifyOwner(`${saved} supplier contact(s) shared for review.`, {
        wa_id: lead.wa_id,
      });
      ack("contactSaved");
    }
    return true;
  }

  if (!msg.document) return false;

  const id =
    "imp-" + createHash("sha256").update(msg.id).digest("hex").slice(0, 24);

  if (!EXPORTABLE(msg.document)) {
    audit("import_rejected", lead.wa_id, {
      reason: "not_a_text_export",
      mime: msg.document.mimeType,
    });
    ack("importUnreadable");
    return true;
  }

  const batch = openBatch({
    id,
    waId: lead.wa_id,
    messageId: msg.id,
    media: msg.document,
  });
  // A replayed webhook finds the batch already open and must not re-enqueue.
  if (!batch) return true;

  /**
   * Consent is recorded by an operator at the visit, before the owner sends
   * anything. An export arriving without it is a file we were not invited to
   * keep, so we keep the fact of it and not the contents.
   */
  if (!lead.import_consent_at) {
    updateBatch(id, { state: "rejected", reason: "no_consent" });
    audit("import_rejected", lead.wa_id, { batch: id, reason: "no_consent" });
    notifyOwner(
      "A chat export arrived but no import consent is on record. Record consent, then ask them to send it again.",
      { wa_id: lead.wa_id },
    );
    ack("importNoConsent");
    return true;
  }

  updateBatch(id, {
    consent_at: lead.import_consent_at,
    consent_method: lead.import_consent_method,
    retention_expires_at: Date.now() + cfg.imports.retentionDays * 24 * 3600000,
  });
  enqueue(
    "import_fetch",
    "import:" + lead.wa_id,
    { batchId: id, waId: lead.wa_id },
    id,
  );
  audit("import_received", lead.wa_id, { batch: id });
  ack("importReceived");
  return true;
}

export function handOver(lead, reason, message) {
  updateLead(lead.wa_id, { state: "HUMAN", human_takeover: 1 });
  say(lead.wa_id, message || t(lead.lang, "handover"), { automated: false });
  notifyOwner(`Human help requested: ${reason}`, { wa_id: lead.wa_id });
  audit("handover", lead.wa_id, { reason });
}
function offerSlots(lead, busy, { reschedule = false, prefix = "" } = {}) {
  if (busy === null)
    return handOver(
      lead,
      "Calendar availability unavailable",
      t(lead.lang, "unavailable"),
    );
  const slots = pickSlots(busy, 3);
  if (!slots.length)
    return handOver(lead, "No available appointments", t(lead.lang, "noSlots"));
  const offers = recordOffers(
    lead.wa_id,
    slots.map((s) => s.toISOString()),
  );
  list(lead.wa_id, {
    header: t(lead.lang, "listHeader"),
    body: prefix || t(lead.lang, "listBody"),
    button: t(lead.lang, "listButton"),
    sectionTitle: t(lead.lang, "listSection"),
    rows: [
      ...offers.map((o) => ({
        id: "slot:" + o.id,
        title: label(new Date(o.start), lead.lang),
        description: t(lead.lang, "slotDesc")(cfg.booking.minutes),
      })),
      {
        id: "human",
        title: t(lead.lang, "otherTime"),
        description: t(lead.lang, "otherTimeDesc"),
      },
    ],
  });
  updateLead(lead.wa_id, {
    state: reschedule ? "AWAITING_RESCHEDULE" : "AWAITING_SLOT",
  });
}
export function finishBooking(id) {
  const booking = getBooking(id);
  if (!booking || booking.status !== "pending") return;
  setBooking(id, "confirmed");
  const lead = getLead(booking.wa_id);
  if (booking.replaces_id) cancelBooking(booking.replaces_id, { silent: true });
  updateLead(lead.wa_id, {
    slot_iso: booking.start,
    calendar_id: booking.calendar_id,
    details_attempts: 0,
    ...(!lead.human_takeover ? { state: "AWAITING_DETAILS" } : {}),
  });
  if (!lead.human_takeover)
    say(
      lead.wa_id,
      t(lead.lang, "booked")(label(new Date(booking.start), lead.lang)),
      { bookingId: id, bookingStatus: "confirmed" },
    );
  notifyOwner(
    `Appointment confirmed for ${label(new Date(booking.start), "en")}${booking.replaces_id ? " (rescheduled)" : ""}.`,
    { wa_id: lead.wa_id },
  );
  audit("booking_confirmed", id, { wa_id: lead.wa_id });
}
export function finishCancellation(id, { silent = false } = {}) {
  const booking = getBooking(id);
  if (!booking || booking.status === "cancelled") return;
  setBooking(id, "cancelled");
  const lead = getLead(booking.wa_id),
    remaining = currentBooking(lead.wa_id);
  if (!remaining)
    updateLead(lead.wa_id, {
      slot_iso: null,
      calendar_id: null,
      ...(!lead.human_takeover ? { state: "CANCELLED" } : {}),
    });
  if (!silent && !lead.human_takeover)
    say(lead.wa_id, t(lead.lang, "cancelled"), {
      bookingId: id,
      bookingStatus: "cancelled",
    });
  notifyOwner("Appointment cancelled.", { wa_id: lead.wa_id });
  audit("booking_cancelled", id);
}
export function cancelBooking(id, { silent = false } = {}) {
  const booking = getBooking(id);
  if (!booking || booking.status !== "confirmed") return;
  setBooking(id, "cancel_pending");
  if (booking.calendar_id) {
    enqueue(
      "calendar_cancel",
      "calendar:" + booking.wa_id,
      { bookingId: id, silent },
      "cancel:" + id,
    );
    if (!silent)
      say(booking.wa_id, t(getLead(booking.wa_id).lang, "cancelPending"), {
        bookingId: id,
        bookingStatus: "cancel_pending",
      });
  } else finishCancellation(id, { silent });
}
function chooseSlot(lead, offerId, busy, messageId) {
  const reschedule = lead.state === "AWAITING_RESCHEDULE";
  if (!["AWAITING_SLOT", "AWAITING_RESCHEDULE"].includes(lead.state))
    return say(
      lead.wa_id,
      t(lead.lang, currentBooking(lead.wa_id) ? "alreadyBooked" : "stale"),
    );
  const current = currentBooking(lead.wa_id);
  if (current && (!reschedule || current.status !== "confirmed"))
    return say(lead.wa_id, t(lead.lang, "pending"));
  const offer = getOffer(lead.wa_id, offerId);
  if (busy === null)
    return handOver(lead, "Calendar unavailable", t(lead.lang, "unavailable"));
  if (
    !offer ||
    !pickSlots(busy, 10000).some((d) => d.toISOString() === offer.start)
  )
    return offerSlots(lead, busy, {
      reschedule,
      prefix: t(lead.lang, "stale"),
    });
  const id = createHash("sha256").update(messageId).digest("hex").slice(0, 40);
  const booking = reserveBooking({
    id,
    waId: lead.wa_id,
    start: offer.start,
    end: slotEnd(offer.start).toISOString(),
    replacesId: reschedule ? current?.id : null,
    calendarId: calendarEnabled ? id : null,
  });
  if (!booking)
    return offerSlots(lead, busy, {
      reschedule,
      prefix: t(lead.lang, "stale"),
    });
  db.prepare("DELETE FROM slot_offers WHERE wa_id=?").run(lead.wa_id);
  updateLead(lead.wa_id, { state: "BOOKING_PENDING" });
  audit("booking_reserved", id);
  if (calendarEnabled) {
    enqueue(
      "calendar_create",
      "calendar:" + lead.wa_id,
      { bookingId: id },
      "create:" + id,
    );
    say(lead.wa_id, t(lead.lang, "processing"), {
      bookingId: id,
      bookingStatus: "pending",
    });
  } else finishBooking(id);
}
export function parseDetails(text) {
  if (rules(text) || text.length > 350) return null;
  const split = text.split(/[,，\n]/);
  const shop = split.shift()?.trim(),
    address = split.join(", ").trim();
  if (
    !shop ||
    shop.length < 2 ||
    shop.length > 120 ||
    !address ||
    address.length < 3 ||
    address.length > 200
  )
    return null;
  return { shop, address };
}
function saveDetails(lead, text, verdict) {
  const details =
    parseDetails(text) ||
    (verdict?.intent === "details" &&
    verdict.shop?.length >= 2 &&
    verdict.shop.length <= 120 &&
    verdict.address?.length >= 3 &&
    verdict.address.length <= 200
      ? { shop: verdict.shop, address: verdict.address }
      : null);
  if (!details) {
    if (lead.details_attempts >= 2)
      return handOver(lead, "Needs help providing shop details");
    updateLead(lead.wa_id, { details_attempts: lead.details_attempts + 1 });
    return say(lead.wa_id, t(lead.lang, "detailsInvalid"));
  }
  const booking = currentBooking(lead.wa_id);
  if (!booking || booking.status !== "confirmed")
    return handOver(lead, "Booking details need reconciliation");
  updateLead(lead.wa_id, {
    shop_name: details.shop,
    shop_address: details.address,
    state: "BOOKED",
    details_attempts: 0,
  });
  if (booking.calendar_id)
    enqueue("calendar_update", "calendar:" + lead.wa_id, {
      bookingId: booking.id,
    });
  say(lead.wa_id, t(lead.lang, "saved"), {
    bookingId: booking.id,
    bookingStatus: "confirmed",
  });
  notifyOwner("Shop details received.", { wa_id: lead.wa_id });
  audit("details_saved", lead.wa_id);
}
export async function handleMessage(msg, jobId) {
  const text = (msg.text || "").trim();
  const snapshot = getLead(msg.from);
  const langCommand = languageCommand(text);
  const verdict =
    !msg.replyId && !snapshot?.human_takeover
      ? await classify(text, {
          lang: snapshot?.lang || detectLang(text),
          state: snapshot?.state || "NEW",
          history: snapshot ? history(msg.from, 8) : [],
        })
      : rules(text);
  const restarting =
    snapshot?.state === "DECLINED" &&
    /^(start|restart|book|tempah|mula|预约|开始)$/i.test(text);
  let busy = [];
  const mayNeedSlots =
    (!snapshot ||
      ["NEW", "CANCELLED"].includes(snapshot.state) ||
      ["book", "reschedule"].includes(verdict?.intent) ||
      msg.replyId === "book" ||
      msg.replyId?.startsWith("slot:")) &&
    !["stop", "cancel", "human", "question"].includes(verdict?.intent) &&
    (!snapshot?.human_takeover || restarting);
  if (mayNeedSlots) {
    try {
      busy = await freeBusy();
    } catch {
      busy = null;
    }
  }
  atomic(() => {
    // Replaying an already completed job never repeats state changes.
    if (
      jobId &&
      db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId)?.status ===
        "done"
    )
      return;
    let lead = upsertLead(msg.from, {
      name: msg.name,
      lang: detectLang(text),
      source: text.slice(0, 120),
    });
    const timestamp = Math.min(Date.now(), Number(msg.timestamp) || Date.now());
    lead = updateLead(msg.from, {
      last_inbound_at: Math.max(lead.last_inbound_at || 0, timestamp),
    });
    logMessage(
      msg.id,
      msg.from,
      "in",
      text || `[${msg.type || "unsupported"}]`,
      msg.type || "text",
    );
    const run = () => {
      if (cfg.owner.whatsapp && msg.from === cfg.owner.whatsapp) {
        updateLead(msg.from, { human_takeover: 1, state: "HUMAN" });
        return;
      }
      if (verdict?.intent === "stop") {
        updateLead(msg.from, { state: "DECLINED", human_takeover: 1 });
        say(msg.from, t(lead.lang, "notInterested"), {
          automated: false,
          allowOptOut: true,
        });
        notifyOwner(
          "Contact opted out of automated replies. Existing appointments remain reserved.",
          { wa_id: msg.from },
        );
        audit("opt_out", msg.from);
        return;
      }
      // Before the takeover check, and never for a contact who opted out.
      if (lead.state !== "DECLINED" && captureAttachment(lead, msg)) return;
      if (lead.human_takeover) {
        if (
          lead.state === "DECLINED" &&
          /^(start|restart|book|tempah|mula|预约|开始)$/i.test(text)
        ) {
          lead = updateLead(msg.from, {
            human_takeover: 0,
            state: currentBooking(msg.from) ? "BOOKED" : "NEW",
          });
          audit("opt_in", msg.from);
        } else {
          notifyOwner("New message in a conversation awaiting a person.", {
            wa_id: msg.from,
          });
          return;
        }
      }
      if (langCommand) {
        lead = updateLead(msg.from, { lang: langCommand });
        say(msg.from, t(langCommand, "languageChanged"));
        return;
      }
      if (verdict?.lang && ["en", "zh", "ms"].includes(verdict.lang))
        lead = updateLead(msg.from, { lang: verdict.lang });
      if (msg.replyId === "human" || verdict?.intent === "human")
        return handOver(lead, "Contact asked for a person");
      if (msg.replyId === "keep") return say(msg.from, t(lead.lang, "kept"));
      if (msg.replyId?.startsWith("cancel:")) {
        const b = getBooking(msg.replyId.slice(7));
        if (!b || b.wa_id !== msg.from || b.status !== "confirmed")
          return say(msg.from, t(lead.lang, "noBooking"));
        return cancelBooking(b.id);
      }
      if (verdict?.intent === "cancel") {
        const b = currentBooking(msg.from);
        if (!b) return say(msg.from, t(lead.lang, "noBooking"));
        if (b.status !== "confirmed")
          return say(msg.from, t(lead.lang, "pending"));
        return buttons(
          msg.from,
          `${label(new Date(b.start), lead.lang)}\n\n${t(lead.lang, "cancelPrompt")}`,
          [
            { id: "cancel:" + b.id, title: t(lead.lang, "cancelYes") },
            { id: "keep", title: t(lead.lang, "keep") },
          ],
        );
      }
      if (msg.replyId?.startsWith("slot:"))
        return chooseSlot(lead, msg.replyId.slice(5), busy, msg.id);
      if (msg.replyId && msg.replyId !== "book")
        return say(msg.from, t(lead.lang, "stale"));
      if (msg.type && !["text", "interactive", "button"].includes(msg.type))
        return say(msg.from, t(lead.lang, "media"));
      if (verdict?.intent === "question")
        return buttons(msg.from, t(lead.lang, "faq"), [
          { id: "book", title: t(lead.lang, "chooseBook") },
          { id: "human", title: t(lead.lang, "chooseHuman") },
        ]);
      if (verdict?.intent === "reschedule") {
        const b = currentBooking(msg.from);
        if (!b) return offerSlots(lead, busy);
        if (b.status !== "confirmed")
          return say(msg.from, t(lead.lang, "pending"));
        return offerSlots(lead, busy, { reschedule: true });
      }
      if (lead.state === "AWAITING_DETAILS")
        return saveDetails(lead, text, verdict);
      if (["BOOKING_PENDING"].includes(lead.state))
        return say(msg.from, t(lead.lang, "pending"));
      if (["BOOKED"].includes(lead.state) || currentBooking(msg.from))
        return say(msg.from, t(lead.lang, "alreadyBooked"));
      if (
        ["NEW", "CANCELLED"].includes(lead.state) ||
        verdict?.intent === "book" ||
        msg.replyId === "book"
      ) {
        if (verdict?.time_hint)
          return handOver(lead, "Contact requested a specific time");
        return offerSlots(lead, busy);
      }
      return handOver(lead, "Request needs a person");
    };
    run();
    if (jobId) completeJob(jobId);
  });
}

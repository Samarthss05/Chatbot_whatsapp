import { cfg } from './config.js';
import { sendText, sendList, markRead } from './whatsapp.js';
import { getLead, upsertLead, updateLead, logMessage, recordOffers, wasOffered } from './store.js';
import { pickSlots, label } from './slots.js';
import { freeBusy, createEvent, updateEventTitle } from './calendar.js';
import { detectLang, t } from './copy.js';
import { classify } from './brain.js';
import { notifyOwner } from './notify.js';

const SLOT = 'slot|';
const OTHER = 'other_time';

/** Two bot turns, then a human. A chatty bot loses this audience. */
async function handOver(lead, why) {
  updateLead(lead.wa_id, { state: 'HUMAN', human_takeover: 1 });
  await sendText(lead.wa_id, t(lead.lang, 'handover'));
  await notifyOwner(
    `Needs you: +${lead.wa_id}${lead.name ? ` (${lead.name})` : ''}\n` +
    `Reason: ${why}\n` +
    `Language: ${lead.lang}` +
    (lead.shop_name ? `\nShop: ${lead.shop_name}` : '') +
    (lead.slot_iso ? `\nBooked: ${label(new Date(lead.slot_iso), 'en')}` : ''),
    { wa_id: lead.wa_id, reason: why }
  );
}

async function offerSlots(lead, { prefix } = {}) {
  const busy = await freeBusy();
  const slots = pickSlots(busy, 3);

  if (!slots.length) {
    await sendText(lead.wa_id, t(lead.lang, 'noSlots'));
    return handOver(lead, 'no slots available');
  }

  recordOffers(lead.wa_id, slots.map(s => s.toISOString()));

  const rows = slots.map(s => ({
    id: SLOT + s.toISOString(),
    title: label(s, lead.lang),
    description: t(lead.lang, 'slotDesc')(cfg.booking.minutes),
  }));
  rows.push({ id: OTHER, title: t(lead.lang, 'otherTime'), description: t(lead.lang, 'otherTimeDesc') });

  const body = prefix ? `${prefix}\n\n${t(lead.lang, 'listBody')}` : t(lead.lang, 'listBody');

  await sendList(lead.wa_id, {
    header: t(lead.lang, 'listHeader'),
    body,
    button: t(lead.lang, 'listButton'),
    sectionTitle: t(lead.lang, 'listSection'),
    rows,
  });

  updateLead(lead.wa_id, { state: 'AWAITING_SLOT' });
}

async function book(lead, iso) {
  const when = new Date(iso);
  const busy = await freeBusy();
  const stillFree = pickSlots(busy, 20).some(s => s.toISOString() === when.toISOString());

  if (!stillFree) {
    return offerSlots(lead, { prefix: t(lead.lang, 'slotGone') });
  }

  const eventId = await createEvent({
    start: when,
    waId: lead.wa_id,
    shopName: lead.shop_name,
    lang: lead.lang,
  });

  updateLead(lead.wa_id, {
    slot_iso: when.toISOString(),
    calendar_id: eventId,
    state: 'AWAITING_DETAILS',
  });

  await sendText(lead.wa_id, t(lead.lang, 'booked')(label(when, lead.lang)));

  await notifyOwner(
    `BOOKED  ${label(when, 'en')}\n` +
    `+${lead.wa_id}${lead.name ? ` (${lead.name})` : ''}\n` +
    `Language: ${lead.lang}` +
    (eventId ? `\nCalendar event created.` : `\nCalendar off, not in your diary.`),
    { wa_id: lead.wa_id, slot: when.toISOString() }
  );
}

async function saveDetails(lead, text) {
  const [shop, ...rest] = text.split(/,|\n/);
  const shopName = (shop || '').trim().slice(0, 120) || null;
  const address = rest.join(', ').trim().slice(0, 200) || null;

  updateLead(lead.wa_id, { shop_name: shopName, shop_address: address, state: 'BOOKED' });
  await updateEventTitle(lead.calendar_id, shopName, address);
  await sendText(lead.wa_id, t(lead.lang, 'saved'));

  await notifyOwner(
    `Details in for ${label(new Date(lead.slot_iso), 'en')}\n` +
    `${shopName ?? '(no name given)'}\n` +
    `${address ?? '(no address given)'}\n` +
    `+${lead.wa_id}`,
    { wa_id: lead.wa_id }
  );
}

/** Entry point. One inbound message in, zero or more replies out. */
export async function handleMessage(msg) {
  const waId = msg.from;
  const text = (msg.text ?? '').trim();

  logMessage(msg.id, waId, 'in', text);
  markRead(msg.id);

  let lead = getLead(waId);

  // First contact: the poster QR prefill tells us which language to speak.
  if (!lead) {
    const lang = detectLang(text);
    lead = upsertLead(waId, { name: msg.name, lang, source: text.slice(0, 120) });
    await notifyOwner(
      `New lead: +${waId}${msg.name ? ` (${msg.name})` : ''}\n` +
      `Language: ${lang}\nFirst message: ${text.slice(0, 160)}`,
      { wa_id: waId }
    );
    return offerSlots(lead);
  }

  lead = upsertLead(waId, { name: msg.name });

  // Once a human is on it, the bot stays out of the way for good.
  if (lead.human_takeover) {
    logMessage(null, waId, 'in-silent', text);
    await notifyOwner(`+${waId} replied: ${text.slice(0, 200)}`, { wa_id: waId });
    return;
  }

  // --- tapped an interactive row ------------------------------------------
  if (msg.replyId) {
    if (msg.replyId === OTHER) return handOver(lead, 'asked for another time');
    if (msg.replyId.startsWith(SLOT)) {
      const iso = msg.replyId.slice(SLOT.length);
      if (!wasOffered(waId, iso)) return handOver(lead, 'picked a slot we did not offer');
      return book(lead, iso);
    }
    return handOver(lead, 'unrecognised selection');
  }

  // --- free text -----------------------------------------------------------
  if (lead.state === 'AWAITING_DETAILS') {
    const looksLikeDetails = text.length > 2 && text.length < 220;
    if (looksLikeDetails) return saveDetails(lead, text);
    return handOver(lead, 'unclear shop details');
  }

  const verdict = await classify(text, { lang: lead.lang });

  // No classifier, or it failed: a human is the safe default.
  if (!verdict) return handOver(lead, 'free text, classifier unavailable');

  if (verdict.lang && verdict.lang !== lead.lang) {
    lead = updateLead(waId, { lang: verdict.lang });
  }

  switch (verdict.intent) {
    case 'book':
      // They named a specific time rather than tapping. That is a human job.
      if (verdict.time_hint) return handOver(lead, `named a time: ${verdict.time_hint}`);
      return offerSlots(lead);

    case 'not_interested':
      updateLead(waId, { state: 'DECLINED', human_takeover: 1 });
      await sendText(waId, t(lead.lang, 'notInterested'));
      return notifyOwner(`Declined: +${waId}\n${text.slice(0, 160)}`, { wa_id: waId });

    case 'reschedule':
      return handOver(lead, 'wants to reschedule');

    case 'question':
      return handOver(lead, `question: ${text.slice(0, 120)}`);

    default:
      return handOver(lead, 'off-script message');
  }
}

/**
 * WhatsApp chat-export parsing.
 *
 * A shop owner exports one supplier thread from their phone ("Export chat",
 * without media) and forwards the .txt to us. That file is months of how they
 * actually order: their words, their quantities, their cadence. It is the only
 * way to fill an outlet's alias table before their first order rather than
 * after twenty of them.
 *
 * This module is pure. No database, no network, no clock. Everything it needs
 * arrives as a string, which is what makes the format variants testable.
 *
 * IMPORTANT: it deliberately does NOT emit aliases or items. Turning phrases
 * into aliases needs the closed item list, which lives in the order pipeline,
 * and needs real exports to calibrate against. Extract structure here; decide
 * meaning there, with a human confirming.
 */

/** Left-to-right marks that iOS sprinkles through exports. */
const INVISIBLE = /[‎‏‪-‮]/g;

/**
 * One line's timestamp prefix. Bracketed (iOS) or dash-separated (Android),
 * with the am/pm marker either side of the time because Chinese locales put
 * it in front.
 */
const PREFIX =
  /^\[?\s*(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})[,\s]+(上午|下午|晚上|凌晨|中午)?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(am|pm|a\.m\.|p\.m\.|上午|下午|晚上|凌晨|中午|pg|ptg|mlm)?\s*\]?\s*(?:[-–]\s*)?([\s\S]*)$/i;

/** "Author: body". First colon wins; a long run without one is a system line. */
const AUTHOR = /^([^:\n]{1,60}?):\s?([\s\S]*)$/;

const MEDIA =
  /<(media|attached|archivo|imagen)[^>]*>|\b(image|video|audio|sticker|document|GIF|contact card)\s+omitted\b|未包含媒体文件|省略|tiada media/i;

const PM_MARKS = new Set(["pm", "p.m.", "下午", "晚上", "ptg", "mlm"]);
const AM_MARKS = new Set(["am", "a.m.", "上午", "凌晨", "pg"]);

const clean = (s) => String(s ?? "").replace(INVISIBLE, "");

/**
 * Decide whether dates read day-first or month-first.
 *
 * Singapore writes day-first, but an export from a phone set to a US locale
 * does not, and silently reading 09/05 as 5 September when it means 9 May
 * corrupts every cadence figure downstream. So look for a component above 12
 * somewhere in the file, and when the file genuinely cannot tell us, say so
 * rather than guess quietly.
 */
export function detectDateOrder(parts) {
  for (const [a, b] of parts) {
    if (a > 12 && b <= 12) return { dayFirst: true, ambiguous: false };
    if (b > 12 && a <= 12) return { dayFirst: false, ambiguous: false };
  }
  return { dayFirst: true, ambiguous: true };
}

function splitDate(text) {
  const bits = text.split(/[./-]/).map((n) => Number.parseInt(n, 10));
  if (bits.length !== 3 || bits.some((n) => !Number.isFinite(n))) return null;
  // A four-digit leading component is an ISO-style date and is unambiguous.
  if (text.split(/[./-]/)[0].length === 4)
    return { year: bits[0], a: bits[1], b: bits[2], iso: true };
  return { year: bits[2], a: bits[0], b: bits[1], iso: false };
}

function toTimestamp(date, time, marker, dayFirst) {
  const [h, m, s = 0] = time.split(":").map((n) => Number.parseInt(n, 10));
  let hour = h;
  const mark = String(marker || "").toLowerCase();
  if (PM_MARKS.has(mark) && hour < 12) hour += 12;
  if (AM_MARKS.has(mark) && hour === 12) hour = 0;
  let year = date.year;
  if (year < 100) year += 2000;
  const day = date.iso || !dayFirst ? date.b : date.a;
  const month = date.iso || !dayFirst ? date.a : date.b;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) return null;
  const at = Date.UTC(year, month - 1, day, hour, m, s);
  return Number.isFinite(at) ? at : null;
}

/**
 * Parse an export into messages plus a summary.
 *
 * Timestamps are returned as "floating" local wall-clock instants: the export
 * carries no zone, so we do not pretend to know one. Cadence and cut-off
 * reasoning only ever compares them to each other, which is safe. Never render
 * one as if it were absolute.
 */
export function parseExport(raw, { maxLines = 200000 } = {}) {
  const text = clean(raw).replace(/\r\n?/g, "\n");
  const lines = text.split("\n").slice(0, maxLines);

  const dateParts = [];
  for (const line of lines) {
    const m = PREFIX.exec(line);
    if (!m) continue;
    const d = splitDate(m[1]);
    if (d && !d.iso) dateParts.push([d.a, d.b]);
  }
  const { dayFirst, ambiguous } = detectDateOrder(dateParts);

  const messages = [];
  let bracketed = 0;
  let dashed = 0;
  let malformed = 0;

  for (const line of lines) {
    const m = PREFIX.exec(line);
    if (!m) {
      // A line with no timestamp continues the previous message.
      if (messages.length) messages[messages.length - 1].body += "\n" + line;
      else if (line.trim()) malformed++;
      continue;
    }
    const date = splitDate(m[1]);
    const at = date && toTimestamp(date, m[3], m[2] || m[4], dayFirst);
    if (at === null || at === undefined) {
      malformed++;
      continue;
    }
    if (line.trimStart().startsWith("[")) bracketed++;
    else dashed++;
    const rest = m[5] ?? "";
    const named = AUTHOR.exec(rest);
    messages.push(
      named
        ? { at, author: named[1].trim(), body: named[2], system: false }
        : { at, author: null, body: rest, system: true },
    );
  }

  for (const msg of messages) {
    msg.body = msg.body.trim();
    msg.media = MEDIA.test(msg.body);
  }

  const authors = new Map();
  let mediaCount = 0;
  let systemCount = 0;
  const days = new Set();
  for (const msg of messages) {
    if (msg.media) mediaCount++;
    if (msg.system) {
      systemCount++;
      continue;
    }
    authors.set(msg.author, (authors.get(msg.author) || 0) + 1);
    days.add(new Date(msg.at).toISOString().slice(0, 10));
  }

  const times = messages.map((m) => m.at).sort((a, b) => a - b);
  const iso = (ms) =>
    ms === undefined ? null : new Date(ms).toISOString().replace(".000Z", "Z");

  return {
    messages,
    meta: {
      format: bracketed > dashed ? "ios" : dashed ? "android" : "unknown",
      messageCount: messages.length,
      systemCount,
      mediaCount,
      malformedLines: malformed,
      dateOrderAmbiguous: ambiguous,
      dayFirst,
      distinctDays: days.size,
      firstMessageAt: iso(times[0]),
      lastMessageAt: iso(times[times.length - 1]),
      authors: [...authors.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    },
  };
}

/**
 * Is this plausibly a chat export rather than an invoice or a photo caption?
 *
 * Cheap and deliberately strict: a wrong answer here means we retain a
 * document we had no business retaining.
 */
export function looksLikeExport(raw) {
  const { meta } = parseExport(String(raw ?? "").slice(0, 200000));
  return meta.messageCount >= 5 && meta.authors.length >= 1;
}

/** Message counts per weekday and hour. Cadence, without keeping the text. */
export function activityProfile(messages, author) {
  const weekday = Array(7).fill(0);
  const hour = Array(24).fill(0);
  for (const msg of messages) {
    if (msg.system || (author && msg.author !== author)) continue;
    const d = new Date(msg.at);
    weekday[d.getUTCDay()]++;
    hour[d.getUTCHours()]++;
  }
  return { weekday, hour };
}

/**
 * The repeated lines one author sends, most frequent first.
 *
 * This is what an operator actually reads on the review screen: "onion 2 bag,
 * 43 times" is the shop's vocabulary, visible at a glance. It is computed from
 * the stored export on demand and never written to its own table, so purging
 * the export purges this too.
 */
export function phraseFrequency(messages, author, { limit = 40 } = {}) {
  const counts = new Map();
  const shown = new Map();
  for (const msg of messages) {
    if (msg.system || msg.media) continue;
    if (author && msg.author !== author) continue;
    for (const line of msg.body.split("\n")) {
      const raw = line.trim();
      if (raw.length < 2 || raw.length > 120) continue;
      const key = raw
        .toLowerCase()
        .replace(/[.,;!?()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!shown.has(key)) shown.set(key, raw);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ phrase: shown.get(key), key, count }));
}

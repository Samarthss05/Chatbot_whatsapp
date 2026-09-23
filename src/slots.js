import { cfg } from './config.js';
import { bookedSlots } from './store.js';

const TZ = cfg.booking.tz;

/** Minutes that `tz` is ahead of UTC at this instant. */
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

/** Wall-clock time in `tz` -> a real Date. Handles DST by settling twice. */
function zoned(y, m, d, hh, mm, tz = TZ) {
  let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMinutes(new Date(guess), tz);
    guess = Date.UTC(y, m - 1, d, hh, mm, 0) - off * 60000;
  }
  return new Date(guess);
}

const LOCALE = { en: 'en-GB', zh: 'zh-CN', ms: 'ms-MY' };

function partsInTz(date, tz = TZ, locale = 'en-GB') {
  const dtf = new Intl.DateTimeFormat(locale, {
    timeZone: tz, weekday: 'short',
    year: 'numeric', month: 'short', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
}

/**
 * A row title the owner reads in their own language.
 * Must stay inside WhatsApp's 24-character limit.
 *   en  "Thu 24 Sep, 2:00pm"
 *   zh  "9月24日 周四 下午2:00"
 *   ms  "Kha 24 Sep, 2:00ptg"
 */
export function label(date, lang = 'en', tz = TZ) {
  if (lang === 'zh') {
    const p = partsInTz(date, tz, 'zh-CN');
    return `${p.month}月${p.day}日 ${p.weekday} ${p.dayPeriod}${p.hour}:${p.minute}`;
  }
  const p = partsInTz(date, tz, LOCALE[lang] ?? 'en-GB');
  const ampm = (p.dayPeriod || '').toLowerCase().replace(/\s|\./g, '');
  const mon = (p.month || '').replace(/^Sept$/, 'Sep').replace(/\.$/, '');
  const wd = (p.weekday || '').replace(/,$/, '').replace(/\.$/, '');
  return `${wd} ${p.day} ${mon}, ${p.hour}:${p.minute}${ampm}`;
}

export function dayLabel(date, tz = TZ) {
  const p = partsInTz(date, tz);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** ISO 1..7 weekday (Mon=1) in the booking timezone. */
function isoWeekday(date, tz = TZ) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd];
}

function ymdInTz(date, tz = TZ) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const o = Object.fromEntries(p.map(x => [x.type, x.value]));
  return { y: +o.year, m: +o.month, d: +o.day };
}

/** Every slot the booking rules allow, before availability filtering. */
export function candidateSlots(now = new Date()) {
  const { times, days, lookahead, minLeadHours } = cfg.booking;
  const earliest = new Date(now.getTime() + minLeadHours * 3600_000);
  const out = [];

  for (let i = 0; i <= lookahead; i++) {
    const probe = new Date(now.getTime() + i * 86400_000);
    if (!days.includes(isoWeekday(probe))) continue;
    const { y, m, d } = ymdInTz(probe);
    for (const t of times) {
      const [hh, mm] = t.split(':').map(Number);
      const when = zoned(y, m, d, hh, mm);
      if (when <= earliest) continue;
      out.push(when);
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Offer slots, skipping anything already booked here or busy on the calendar.
 * `busy` is [{start, end}] from Google, or [] when the calendar is not wired up.
 */
export function pickSlots(busy = [], count = 3, now = new Date()) {
  const taken = new Set(bookedSlots());
  const mins = cfg.booking.minutes;

  const free = candidateSlots(now).filter(when => {
    if (taken.has(when.toISOString())) return false;
    const end = new Date(when.getTime() + mins * 60000);
    return !busy.some(b => when < new Date(b.end) && end > new Date(b.start));
  });

  // Spread across different days so the owner gets a real choice,
  // not three times on the same afternoon.
  const chosen = [];
  const seenDays = new Set();
  for (const s of free) {
    const key = dayLabel(s);
    if (seenDays.has(key)) continue;
    seenDays.add(key);
    chosen.push(s);
    if (chosen.length >= count) break;
  }
  for (const s of free) {
    if (chosen.length >= count) break;
    if (!chosen.includes(s)) chosen.push(s);
  }
  return chosen.sort((a, b) => a - b);
}

export const slotEnd = start =>
  new Date(new Date(start).getTime() + cfg.booking.minutes * 60000);

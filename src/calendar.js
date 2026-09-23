import { cfg, calendarEnabled } from './config.js';
import { slotEnd } from './slots.js';

let cached = { token: null, expires: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expires - 30_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
      refresh_token: cfg.google.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error('Google token refresh failed: ' + JSON.stringify(j));
  cached = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

/** Busy intervals over the lookahead window. Returns [] if calendar is off. */
export async function freeBusy(from = new Date(), days = cfg.booking.lookahead + 1) {
  if (!calendarEnabled) return [];
  try {
    const token = await accessToken();
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: new Date(from.getTime() + days * 86400_000).toISOString(),
        timeZone: cfg.booking.tz,
        items: [{ id: cfg.google.calendarId }],
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(j));
    return j.calendars?.[cfg.google.calendarId]?.busy ?? [];
  } catch (e) {
    console.error('[calendar] freeBusy failed, offering slots unchecked:', e.message);
    return [];
  }
}

/** Creates the onboarding event. Returns the event id, or null if calendar is off. */
export async function createEvent({ start, waId, shopName, lang }) {
  if (!calendarEnabled) return null;
  try {
    const token = await accessToken();
    const title = shopName
      ? `ReStock onboarding: ${shopName}`
      : `ReStock onboarding: +${waId}`;
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.google.calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: title,
          description:
            `Booked automatically from WhatsApp.\n` +
            `Contact: +${waId}\n` +
            `Language: ${lang}\n\n` +
            `Bring: supplier capture sheet, leave-behind flyer.\n` +
            `Capture: suppliers + contacts, core items in their words, ordering rhythm, ` +
            `who else orders, baseline ordering time, referral ask.`,
          start: { dateTime: new Date(start).toISOString(), timeZone: cfg.booking.tz },
          end: { dateTime: slotEnd(start).toISOString(), timeZone: cfg.booking.tz },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
        }),
      }
    );
    const j = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(j));
    return j.id ?? null;
  } catch (e) {
    console.error('[calendar] createEvent failed:', e.message);
    return null;
  }
}

export async function updateEventTitle(eventId, shopName, address) {
  if (!calendarEnabled || !eventId) return;
  try {
    const token = await accessToken();
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.google.calendarId)}/events/${eventId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: `ReStock onboarding: ${shopName}`,
          location: address || undefined,
        }),
      }
    );
  } catch (e) {
    console.error('[calendar] updateEventTitle failed:', e.message);
  }
}

import { cfg, calendarEnabled } from "./config.js";
import { request, ServiceError } from "./http.js";
let cached = { token: null, expires: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.expires - 30000) return cached.token;
  const j = await request(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.google.clientId,
        client_secret: cfg.google.clientSecret,
        refresh_token: cfg.google.refreshToken,
        grant_type: "refresh_token",
      }),
    },
    "Google authorization",
  );
  if (!j?.access_token) throw new ServiceError("Google authorization");
  cached = {
    token: j.access_token,
    expires: Date.now() + Number(j.expires_in || 3600) * 1000,
  };
  return cached.token;
}
async function api(path, method = "GET", body) {
  const token = await accessToken();
  try {
    return await request(
      `https://www.googleapis.com/calendar/v3/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      "Google Calendar",
    );
  } catch (e) {
    if (e.status === 401) {
      cached = { token: null, expires: 0 };
      e.permanent = false;
    }
    throw e;
  }
}
const events = () =>
  `calendars/${encodeURIComponent(cfg.google.calendarId)}/events`;
export async function freeBusy(
  from = new Date(),
  days = cfg.booking.lookahead + 1,
) {
  if (!calendarEnabled) return [];
  const j = await api("freeBusy", "POST", {
    timeMin: from.toISOString(),
    timeMax: new Date(from.getTime() + days * 86400000).toISOString(),
    timeZone: cfg.booking.tz,
    items: [{ id: cfg.google.calendarId }],
  });
  const calendar = j?.calendars?.[cfg.google.calendarId];
  if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy))
    throw new ServiceError("Calendar availability");
  return calendar.busy;
}
export async function createEvent(booking, lead) {
  if (!calendarEnabled) return;
  const body = {
    id: booking.calendar_id,
    summary: `ReStock onboarding: ${lead.shop_name || "Shop visit"}`,
    description: `WhatsApp: +${lead.wa_id}\nLanguage: ${lead.lang}`,
    location: lead.shop_address || undefined,
    start: { dateTime: booking.start, timeZone: cfg.booking.tz },
    end: { dateTime: booking.end, timeZone: cfg.booking.tz },
    extendedProperties: { private: { ledgerBookingId: booking.id } },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 60 }],
    },
  };
  try {
    await api(events(), "POST", body);
  } catch (e) {
    if (e.status !== 409) throw e;
    const existing = await api(`${events()}/${booking.calendar_id}`);
    if (
      existing?.extendedProperties?.private?.ledgerBookingId !== booking.id ||
      existing.status === "cancelled" ||
      Date.parse(existing.start?.dateTime) !== Date.parse(booking.start) ||
      Date.parse(existing.end?.dateTime) !== Date.parse(booking.end)
    )
      throw new ServiceError("Calendar event reconciliation", 409, true);
  }
}
export async function updateEvent(booking, lead) {
  if (!calendarEnabled || !booking.calendar_id) return;
  await api(`${events()}/${booking.calendar_id}`, "PATCH", {
    summary: `ReStock onboarding: ${lead.shop_name || "Shop visit"}`,
    location: lead.shop_address || "",
  });
}
export async function deleteEvent(booking) {
  if (!calendarEnabled || !booking.calendar_id) return;
  try {
    await api(`${events()}/${booking.calendar_id}`, "DELETE");
  } catch (e) {
    if (![404, 410].includes(e.status)) throw e;
  }
}

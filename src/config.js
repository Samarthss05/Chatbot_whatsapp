import 'dotenv/config';

const req = (k, fallback) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === '') return undefined;
  return v;
};

export const cfg = {
  wa: {
    token: req('WHATSAPP_TOKEN'),
    phoneNumberId: req('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: req('WHATSAPP_VERIFY_TOKEN'),
    appSecret: req('WHATSAPP_APP_SECRET'),
    graphVersion: req('GRAPH_VERSION', 'v21.0'),
  },
  owner: {
    name: req('OWNER_NAME', 'Samarth'),
    whatsapp: req('OWNER_WHATSAPP'),
  },
  openrouter: {
    key: req('OPENROUTER_API_KEY'),
    model: req('OPENROUTER_MODEL', 'google/gemini-2.0-flash-001'),
  },
  google: {
    clientId: req('GOOGLE_CLIENT_ID'),
    clientSecret: req('GOOGLE_CLIENT_SECRET'),
    refreshToken: req('GOOGLE_REFRESH_TOKEN'),
    calendarId: req('GOOGLE_CALENDAR_ID', 'primary'),
  },
  booking: {
    tz: req('TIMEZONE', 'Asia/Singapore'),
    times: req('SLOT_TIMES', '14:00,15:00,16:00').split(',').map(s => s.trim()),
    minutes: Number(req('SLOT_MINUTES', '20')),
    days: req('BOOKING_DAYS', '1,2,3,4,5,6').split(',').map(Number),
    lookahead: Number(req('LOOKAHEAD_DAYS', '6')),
    minLeadHours: Number(req('MIN_LEAD_HOURS', '3')),
  },
  port: Number(req('PORT', '3000')),
  adminToken: req('ADMIN_TOKEN'),
};

export const calendarEnabled = Boolean(
  cfg.google.clientId && cfg.google.clientSecret && cfg.google.refreshToken
);
export const brainEnabled = Boolean(cfg.openrouter.key);

export function assertReady() {
  const missing = [];
  if (!cfg.wa.token) missing.push('WHATSAPP_TOKEN');
  if (!cfg.wa.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!cfg.wa.verifyToken) missing.push('WHATSAPP_VERIFY_TOKEN');
  if (missing.length) {
    console.error('\nMissing required env vars: ' + missing.join(', '));
    console.error('Copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  if (!cfg.wa.appSecret) {
    console.warn('[warn] WHATSAPP_APP_SECRET not set: webhook signatures will NOT be verified.');
  }
  if (!calendarEnabled) {
    console.warn('[warn] Google Calendar not configured: slots will not be checked against your real availability.');
  }
  if (!brainEnabled) {
    console.warn('[warn] OPENROUTER_API_KEY not set: off-script messages hand straight to you instead of being classified.');
  }
}

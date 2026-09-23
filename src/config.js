import "dotenv/config";
const env = (key, fallback = "") => process.env[key]?.trim() || fallback;
const number = (key, fallback) => Number(env(key, String(fallback)));
export const cfg = {
  production: env("NODE_ENV") === "production",
  dryRun: env("DRY_RUN") === "1",
  host: env("HOST", "127.0.0.1"),
  port: number("PORT", 3000),
  dbFile: env("DB_FILE", "./data/ledgerbot.db"),
  adminToken: env("ADMIN_TOKEN"),
  wa: {
    token: env("WHATSAPP_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    graphVersion: env("GRAPH_VERSION", "v21.0"),
  },
  owner: {
    name: env("OWNER_NAME", "Samarth"),
    whatsapp: env("OWNER_WHATSAPP"),
  },
  notifyWebhook: env("NOTIFY_WEBHOOK"),
  openrouter: {
    key: env("OPENROUTER_API_KEY"),
    model: env("OPENROUTER_MODEL"),
    minConfidence: number("LLM_MIN_CONFIDENCE", 0.8),
  },
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_REFRESH_TOKEN"),
    calendarId: env("GOOGLE_CALENDAR_ID", "primary"),
  },
  booking: {
    tz: env("TIMEZONE", "Asia/Singapore"),
    times: env("SLOT_TIMES", "14:00,15:00,16:00")
      .split(",")
      .map((s) => s.trim()),
    minutes: number("SLOT_MINUTES", 20),
    bufferMinutes: number("BUFFER_MINUTES", 10),
    days: env("BOOKING_DAYS", "1,2,3,4,5,6").split(",").map(Number),
    lookahead: number("LOOKAHEAD_DAYS", 6),
    minLeadHours: number("MIN_LEAD_HOURS", 3),
    offerMinutes: number("OFFER_TTL_MINUTES", 30),
  },
  jobAttempts: number("JOB_MAX_ATTEMPTS", 5),
  pollMs: number("WORKER_POLL_MS", 500),
};
export const calendarEnabled =
  !cfg.dryRun &&
  Boolean(
    cfg.google.clientId && cfg.google.clientSecret && cfg.google.refreshToken,
  );
export const brainEnabled =
  !cfg.dryRun && Boolean(cfg.openrouter.key && cfg.openrouter.model);
export function validateConfig(c = cfg) {
  const errors = [];
  for (const [key, value, min, max] of [
    ["PORT", c.port, 1, 65535],
    ["SLOT_MINUTES", c.booking.minutes, 5, 480],
    ["BUFFER_MINUTES", c.booking.bufferMinutes, 0, 180],
    ["LOOKAHEAD_DAYS", c.booking.lookahead, 1, 60],
    ["OFFER_TTL_MINUTES", c.booking.offerMinutes, 1, 1440],
    ["JOB_MAX_ATTEMPTS", c.jobAttempts, 1, 20],
    ["WORKER_POLL_MS", c.pollMs, 100, 10000],
  ]) {
    if (!Number.isInteger(value) || value < min || value > max)
      errors.push(`${key} must be an integer from ${min} to ${max}`);
  }
  if (
    !Number.isFinite(c.booking.minLeadHours) ||
    c.booking.minLeadHours < 0 ||
    c.booking.minLeadHours > 720
  )
    errors.push("Invalid MIN_LEAD_HOURS");
  if (
    !Number.isFinite(c.openrouter.minConfidence) ||
    c.openrouter.minConfidence < 0 ||
    c.openrouter.minConfidence > 1
  )
    errors.push("Invalid LLM_MIN_CONFIDENCE");
  try {
    new Intl.DateTimeFormat("en", { timeZone: c.booking.tz });
  } catch {
    errors.push("Invalid TIMEZONE");
  }
  if (
    !c.booking.times.length ||
    c.booking.times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))
  )
    errors.push("SLOT_TIMES must contain valid HH:mm times");
  if (
    !c.booking.days.length ||
    c.booking.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
  )
    errors.push("BOOKING_DAYS must use 1 (Monday) through 7 (Sunday)");
  if (c.adminToken.length < 24 || /pick-|change-me|replace/i.test(c.adminToken))
    errors.push("ADMIN_TOKEN must be a random value of at least 24 characters");
  if (c.production && c.dryRun)
    errors.push("DRY_RUN is forbidden in production");
  if (!c.dryRun) {
    for (const key of ["token", "phoneNumberId", "verifyToken", "appSecret"])
      if (!c.wa[key])
        errors.push(`WhatsApp ${key} is required outside dry run`);
    if (
      c.wa.verifyToken.length < 24 ||
      /pick-|change-me/i.test(c.wa.verifyToken)
    )
      errors.push(
        "Use a random WhatsApp verification token of at least 24 characters",
      );
    const g = [c.google.clientId, c.google.clientSecret, c.google.refreshToken];
    if (g.some(Boolean) && !g.every(Boolean))
      errors.push("Provide all three Google OAuth credentials, or none");
    if (c.openrouter.key && !c.openrouter.model)
      errors.push("OPENROUTER_MODEL is required with an API key");
  }
  if (c.notifyWebhook) {
    try {
      const u = new URL(c.notifyWebhook);
      if (u.protocol !== "https:") errors.push("NOTIFY_WEBHOOK must use HTTPS");
    } catch {
      errors.push("Invalid NOTIFY_WEBHOOK");
    }
  }
  return errors;
}
export function assertReady() {
  const errors = validateConfig();
  if (errors.length) throw new Error(errors.join("\n"));
}

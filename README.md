# Ledger booking bot

When a shop owner scans the poster QR and messages **9610 9538**, this books the
20-minute onboarding visit without you touching your phone.

It speaks English, Mandarin and Malay, picks the language from the poster they
scanned, offers real slots from your Google Calendar, creates the event, and
hands the conversation to you the moment anyone says something off-script.

---

## What it actually does

```
Owner scans QR, message arrives ("Hi Ledger, I saw your poster...")
        │
        ├─ language detected from their first message
        │
        ▼
Bot replies with 3 slots as a tappable list  ← one tap, no web form
        │
        ├─ taps a slot ──▶ Calendar event created
        │                  "What's your shop name and unit number?"
        │                        │
        │                        ▼
        │                  Saved, event renamed, you get a ping. Bot stops.
        │
        ├─ taps "another time" ──▶ handed to you
        └─ types anything else ──▶ classified, then usually handed to you
```

**Two bot turns, maximum.** After that a human takes over and the bot never
speaks to that person again. An owner who wanted two students and got a
chatbot is an owner you lost.

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. WhatsApp Cloud API

At [developers.facebook.com](https://developers.facebook.com): create an app,
add the **WhatsApp** product, and from **API Setup** copy into `.env`:

- `WHATSAPP_TOKEN` (use a permanent System User token for production, not the 24h test one)
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_APP_SECRET` from **App Settings → Basic**

Invent any long random string for `WHATSAPP_VERIFY_TOKEN`.

> Business verification takes one to two weeks. Start it now. It is task **A04**
> on the launch plan and it gates everything.

### 3. Expose the webhook

Locally:

```bash
npx ngrok http 3000
```

Then in **WhatsApp → Configuration → Webhook**:

- Callback URL: `https://your-ngrok-url/webhook`
- Verify token: whatever you put in `.env`
- Subscribe to the **messages** field

### 4. Google Calendar (optional)

Skip this and the bot still works, it just offers slots without checking whether
you are actually free.

To wire it up: enable the Google Calendar API, create an OAuth client with
redirect `http://localhost:5555/callback`, put the id and secret in `.env`, then:

```bash
npm run auth:google
```

Paste the printed refresh token into `GOOGLE_REFRESH_TOKEN`.

### 5. OpenRouter (optional)

Classifies free text so the bot knows the difference between "how much ah" and
"not interested". Without a key, every free-text message goes straight to you,
which is safe but noisier.

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys) and put it in
`.env` as `OPENROUTER_API_KEY`. **Never paste a key into a chat, a commit, or a
screenshot.** If one leaks, revoke it on that page immediately.

### 6. Run

```bash
npm start
```

---

## Day to day

```bash
npm run leads        # the pipeline as a table
npm run simulate     # drive the whole conversation without touching WhatsApp
```

`GET /leads` returns the same data as JSON, with `x-admin-token: <ADMIN_TOKEN>`.

### Getting notified

Console always gets it. Two better options:

- `NOTIFY_WEBHOOK=<url>` posts JSON to Slack, Discord, Telegram or n8n. Most reliable.
- WhatsApp to your own number works only if you messaged the business number in
  the last 24 hours, so treat it as a bonus rather than the channel you rely on.

---

## Booking rules

Set in `.env`:

| Variable | Default | Why |
|---|---|---|
| `SLOT_TIMES` | `14:00,15:00,16:00` | 2 to 4pm is when owners are free. Not lunch. |
| `SLOT_MINUTES` | `20` | The onboarding visit length |
| `BOOKING_DAYS` | `1,2,3,4,5,6` | Mon to Sat. Shops open Saturday. |
| `LOOKAHEAD_DAYS` | `6` | How far ahead to offer |
| `MIN_LEAD_HOURS` | `3` | Never offer a slot in the next 3 hours |

Slots are spread across different days so the owner gets a real choice rather
than three times on one afternoon.

---

## Things worth knowing

**Cost.** Replies inside the 24-hour window after their message are free. This
whole flow lives inside that window, so it costs nothing. Only a day-before
reminder sent more than 24 hours later needs a paid utility template.

**Never use an unofficial library.** Baileys, whatsapp-web.js and similar
violate WhatsApp's Terms and get numbers banned. You would lose the number
printed on every poster and encoded in every QR.

**PDPA.** You are storing phone numbers, names and shop addresses. Appoint a
Data Protection Officer and publish the contact details, tell people what you
collect and why, and delete leads who declined. VIE gives you free legal
consultant hours under the grant; this is a good use of them.

**Security.** Webhook signatures are verified against `WHATSAPP_APP_SECRET`.
Do not run in production without it. `.env` must never be committed.

---

## Layout

```
src/
  config.js     env, feature flags, startup checks
  server.js     express, webhook verification and signature check
  whatsapp.js   Cloud API client, message parsing, WhatsApp's character limits
  flow.js       the state machine. Start here.
  slots.js      slot generation, timezone handling, localised labels
  calendar.js   Google free/busy and event creation, degrades gracefully
  copy.js       every string, in three languages
  brain.js      OpenRouter intent classification
  store.js      SQLite: leads, messages, offered slots
  notify.js     tells you when something happens
scripts/
  simulate.js     full conversation, no WhatsApp needed
  google-auth.js  one-time OAuth
  leads.js        pipeline table
```

State machine: `NEW → AWAITING_SLOT → AWAITING_DETAILS → BOOKED`, with
`HUMAN` and `DECLINED` as terminal states.

---

## Why building this is not a detour

It uses the same provider account, the same webhook, the same message store and
the same send path that **A03, A04, A05 and A11** need for ReStock itself. If
this works, your inbound pipe works, with a payload that cannot hurt anyone if
it breaks. That de-risks the part of the 23 October plan most likely to slip.

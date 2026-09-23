# Ledger Visit Desk

A multilingual WhatsApp appointment service for Ledger/ReStock, with a private operator dashboard. It schedules shop visits, records shop details, synchronizes Google Calendar, and hands conversations to a person when needed.

**Core booking works without an LLM.** OpenRouter is an optional interpreter for free text; it cannot bypass appointment rules, call arbitrary tools, or invent customer-facing answers.

## Try it safely

Use Node.js 22 (see `.nvmrc`).

```sh
npm ci
npm run demo
```

Open **http://127.0.0.1:3000**. Demo access token:

```text
ledger-demo-access-token-local-only
```

The demo binds only to your computer, uses synthetic contacts in `data/demo.db`, and disables **all** external services—even when a real `.env` is present. Set `DEMO_PORT=3185` if port 3000 is occupied. Demo contacts persist across restarts. For a fresh disposable run without writing a database, use `npm run simulate`.

## What is included

- English, Mandarin, and Malay conversation copy and appointment labels.
- Slot lists with expiring, contact-specific selection tokens.
- Atomic local reservations, overlap checks, and configurable travel buffers.
- Confirmed cancellations; rescheduling keeps the original reservation until its replacement succeeds.
- Separate appointment and conversation state: human takeover never releases a reservation.
- Persistent inbound and outbound queues, bounded exponential retries, failed-action recovery, and a single-worker lease.
- Calendar creation with deterministic event IDs and duplicate reconciliation after ambiguous network failures.
- An operator dashboard: searchable contacts, conversation history, delivery status, personal replies, takeover/resume, private notes, appointments, notifications, activity, and CSV export.
- Opt-out handling before booking, explicit re-entry through START/BOOK, and no operator override of opt-out.
- Strict webhook signatures, business-phone filtering, header-only admin authentication, security headers, request limits, and login throttling.
- Safe simulation, schema migration, online SQLite backups, tests, Docker configuration, and CI.

---

## Onboarding data: chat exports and supplier contacts

The slowest part of onboarding is writing down what a shop orders and who they
order it from. Both are already on the owner's phone.

**Chat export.** In the shop, open their thread with one supplier, use
**Export chat → Without media**, and share it to the Ledger number. Say
"without media" out loud or a year of delivery photos arrives instead of a
text file. The export is months of their own phrasing, quantities and timing,
which is what seeds their item list before the first order rather than after
twenty of them.

**Contact cards.** Forwarding a supplier's contact card captures the name and
number with no typing. Their own card and yours are ignored.

Both are captured even while a person has taken the conversation over, because
that is exactly when they happen.

### Consent comes first, and is recorded by a person

An export contains the supplier's messages too, so it is not ours to keep on a
whim. Record consent in the dashboard **before** the owner sends anything:
open the conversation, **Onboarding data → Record consent**. Say what you are
taking, why, how long you keep it, and that their supplier's prices never leave
their outlet.

An export that arrives with no consent on record is logged and discarded, and
you get a notification. That is the intended behaviour, not a bug: record
consent and ask them to send it again.

### What is kept, and for how long

`IMPORT_RETENTION_DAYS` (default 30) starts at capture. When it expires the
verbatim text is deleted and the derived counts remain. **Delete text now** in
the review panel does the same immediately. Withdrawing consent stops future
imports; it deliberately does not delete what is already stored, because that
should be a separate, considered decision.

Nothing from an export is written into prices or aliases automatically. The
review panel ranks the repeated phrases per author, you decide which author is
the shop, and the alias work happens in the order pipeline with a human
confirming. `leads.outlet_id` is the join between the two.

## Live setup

1. `cp .env.example .env` and fill in the WhatsApp Cloud API credentials.
2. Generate separate random values for `ADMIN_TOKEN` and `WHATSAPP_VERIFY_TOKEN`:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Supply `WHATSAPP_APP_SECRET`. Signatures are mandatory outside the isolated demo. Placeholder credentials are rejected for admin and verification tokens.
4. Run `npm start`. Default listener: `127.0.0.1:3000`.
5. Expose `/webhook` using HTTPS through a reverse proxy or a development tunnel. Configure Meta's callback to `https://your-host/webhook`, use your verification token, and subscribe to messages. Keep the operator dashboard behind your private network or additional identity-aware access where practical.
6. Open the dashboard and sign in with `ADMIN_TOKEN`. The token lives only in the tab's memory; a browser refresh signs you out.
7. Test one real inbound conversation, a slot selection, shop details, cancellation, handover, and delivery-status callbacks before launching.

`npm start` needs valid WhatsApp and admin configuration. `npm run demo` needs no credentials. Never put credentials into Git, browser URLs, screenshots, or public chat messages.

### Google Calendar

Without Google credentials, reservations are stored locally and external calendar availability is not known. With Google enabled, availability errors hand the conversation to a person; failed event creation remains pending and is visible in **Activity & recovery**. A customer receives confirmation only after the Calendar operation succeeds.

Enable the Calendar API and create an OAuth web client. Register this exact redirect URI:

```text
http://127.0.0.1:5555/callback
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, run `npm run auth:google`, and store the resulting refresh token in `GOOGLE_REFRESH_TOKEN`. Use an account authorized to read availability and manage events in `GOOGLE_CALENDAR_ID`. The helper requests event and free/busy scopes, validates OAuth state, binds to loopback, and expires after five minutes. Google consent-screen testing status can affect refresh-token lifetime; configure your Google project appropriately for continued operation.

### Add OpenRouter later

Set both values and restart:

```dotenv
OPENROUTER_API_KEY=your-secret-key
OPENROUTER_MODEL=your-selected-model-id
```

Choose an available model/provider supporting strict JSON-schema outputs. No stale model is hard-coded. Requests carry bounded recent conversation context, use a timeout, and validate language, intent, field types, and confidence. Low-confidence or unavailable AI falls back to deterministic commands or a person. The model never directly sends replies or modifies appointments. Review the messages sent to OpenRouter and its provider data policies before enabling it for customer conversations.

### Team notifications

Dashboard notifications always work. Optionally set `NOTIFY_WEBHOOK` to an HTTPS automation endpoint accepting `{ "text": "...", "wa_id": "..." }`. Failed requests are retried and eventually shown for review. Use an adapter such as your own n8n workflow for services with different payload formats.

`OWNER_WHATSAPP`, if set, identifies your personal number so its incoming messages bypass customer booking automation. This version does not rely on WhatsApp-to-owner notifications.

## Booking settings

| Setting             | Default             | Meaning                                   |
| ------------------- | ------------------- | ----------------------------------------- |
| `TIMEZONE`          | `Asia/Singapore`    | Scheduling and display timezone           |
| `SLOT_TIMES`        | `14:00,15:00,16:00` | Local start times                         |
| `SLOT_MINUTES`      | `20`                | Visit duration                            |
| `BUFFER_MINUTES`    | `10`                | Minimum gap around a visit                |
| `BOOKING_DAYS`      | `1,2,3,4,5,6`       | ISO weekdays, Monday = 1                  |
| `LOOKAHEAD_DAYS`    | `6`                 | Today through six days ahead              |
| `MIN_LEAD_HOURS`    | `3`                 | Minimum notice before a visit             |
| `OFFER_TTL_MINUTES` | `30`                | Slot-list validity                        |
| `JOB_MAX_ATTEMPTS`  | `5`                 | Automatic attempts before operator review |
| `WORKER_POLL_MS`    | `500`               | Background processing interval            |

Commands include BOOK/START, RESCHEDULE, CANCEL, HUMAN, and STOP, with common Mandarin and Malay equivalents. Customers can switch language with English, 中文, or Bahasa Melayu. Cancellation requires a confirmation button. Shop details require both a name and address; repeated unclear answers are handed to a person.

## How it works

```text
Meta webhook → signature + phone validation → durable inbox → immediate HTTP 200
                                                 ↓
                               single worker / conversation decisions
                                                 ↓
                          database transaction: state + reservation + outbox
                                                 ↓
                       Calendar jobs / WhatsApp jobs / notification jobs
                                                 ↓
                                delivery status + audit + operator desk
```

The database transaction commits conversation changes and outbound work together. A crash cannot commit a state change while losing its queued reply. Calendar jobs use stable event IDs so a retry can reconcile an already-created event. Overlap checks run inside an immediate SQLite transaction. Incoming message IDs are unique; webhook retries do not restart completed conversations.

Appointments use `pending → confirmed → cancel_pending → cancelled`, with reservations held during pending operations. Conversation states independently describe choosing a slot, waiting for details, booked, human takeover, opt-out, or cancellation.

### Source map

| Location                             | Purpose                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `src/server.js`, `src/app.js`        | Startup, shutdown, HTTP routes, security, operator API         |
| `src/store.js`                       | Schema, migration, transactions, reservations, jobs, audit     |
| `src/worker.js`                      | Single-worker lease, delivery, retries, recovery               |
| `src/flow.js`                        | Conversation and appointment transitions                       |
| `src/slots.js`, `src/copy.js`        | Scheduling, timezone labels, multilingual copy                 |
| `src/calendar.js`, `src/whatsapp.js` | Provider integrations                                          |
| `src/brain.js`                       | Deterministic rules and optional structured LLM classification |
| `src/messaging.js`, `src/notify.js`  | Queue replies and team notifications                           |
| `public/`                            | Operator dashboard, no external frontend dependencies          |
| `scripts/`                           | Demo, simulation, Google authorization, backup, syntax checks  |
| `test/`                              | Core, HTTP, provider-failure, migration, and backup tests      |

## API

Every `/api/*` route requires `x-admin-token: <ADMIN_TOKEN>`. Do not put the token in query strings. No browser cross-origin API access is enabled.

- `GET /health` — liveness.
- `GET /ready` — database access and worker readiness.
- `GET/POST /webhook` — Meta verification and delivery.
- `GET /api/overview`, `/api/leads`, `/api/leads/:id` — dashboard data.
- `POST /api/leads/:id/takeover`, `/resume`, `/reply`, `/notes` — operator actions.
- `POST /api/leads/:id/consent` — record or withdraw import consent.
- `POST /api/leads/:id/outlet` — link the conversation to an outlet in the order pipeline.
- `GET /api/imports/:id` — one chat export, with ranked phrases per author.
- `POST /api/imports/:id/accept`, `/reject`, `/label`, `/purge` — review an export.
- `POST /api/contacts/:id/accept`, `/reject` — review a captured supplier contact.
- `POST /api/bookings/:id/cancel` — request calendar-aware cancellation.
- `GET /api/jobs`; `POST /api/jobs/:id/retry` — review and retry failed actions.
- `GET /api/activity`, `/api/export` — activity and contacts export.
- `POST /api/notifications/:id/read` — acknowledge a team notification.
- `GET /leads` — legacy header-authenticated listing, capped at 1,000 rows.

## Deploy and operate

```sh
npm run check
npm test
npm run simulate
npm audit --omit=dev
# After configuring .env:
docker compose up --build -d
```

The container runs as a non-root user, persists SQLite on a named volume, and publishes port 3000 only to the host's loopback interface. Put an HTTPS reverse proxy in front of it. Configure real secrets, monitor `/ready`, and arrange off-host encrypted backups. Docker and GitHub Actions configurations are provided; real provider credentials and your hosting environment still need end-to-end validation.

**Run exactly one application instance per database on local persistent storage.** The worker lease prevents a second active worker and recovers interrupted jobs on restart. After an unclean shutdown, an unexpired lease can delay startup for up to 60 seconds. Do not put the database on a network filesystem or run independent replicas with separate databases. For multiple workers or locations, move reservations and queues to a shared transactional database first.

### Upgrade from version 1

Back up the old database before starting version 2. Startup adds tables/columns and migrates legacy appointment fields into independent reservations, including appointments on conversations already handed to a person. Existing leads, messages, and legacy offers are retained. Old offer buttons are deliberately no longer accepted; customers can request fresh times. Review migrated appointments and configure the new admin token requirements. Do not run version 1 and version 2 against the same live database.

### Backups and recovery

```sh
npm run backup
# Or choose a destination:
npm run backup -- ./data/backups/pre-upgrade.db
```

The backup uses SQLite's online backup API, so committed WAL data is included. Keep backups outside the application host. To restore: stop the service, preserve the current database and WAL/SHM files together as a rollback copy, place the chosen backup at `DB_FILE`, ensure no old WAL/SHM files remain at that path, then restart and verify `/ready` and appointments.

Review failed actions in the dashboard, fix the credential/provider problem, and retry. A pending Calendar reservation remains held deliberately: do not manually release it until you have reconciled whether the event exists. Cancelling a visit from the dashboard is an operator action and does not automatically message the customer; use the reply box when appropriate.

## Practical limits

- WhatsApp delivery is **at least once**, not exactly once. If a provider accepts a message but its response and status callback are lost, a retry may duplicate the reply. Delivery callbacks reduce this ambiguity; Calendar event creation has independent idempotency.
- Manual Calendar edits can race with availability checks. Use a dedicated booking calendar and review external changes; Google event insertion does not provide an atomic availability lock.
- One shared operator token; no individual accounts, roles, or attribution beyond “operator.” Add identity-aware access before sharing it with a larger team.
- No audio transcription, media download, supplier ordering, customer reminder templates, payments, or multi-location scheduling. Voice/image messages receive a typed-message prompt.
- Replies outside the 24-hour customer-service window are blocked and surfaced for review. Proactive/template messaging is not implemented.
- A reservation is not automatically released because a customer stopped replying or opted out. That could otherwise silently cancel a promised visit.
- Customer data, message text, queue payloads, and notifications persist in SQLite. There is no automatic deletion policy. Set retention/access rules and implement reviewed deletion procedures appropriate to your operation.
- Automated tests mock external providers; they do not prove your Meta, Google, or OpenRouter account configuration works.

Provider references: [Google event IDs](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [Meta webhook reference](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference).

import express from 'express';
import { cfg, assertReady } from './config.js';
import { verifySignature, parseInbound } from './whatsapp.js';
import { firstTimeSeeing } from './store.js';
import { handleMessage } from './flow.js';
import { allLeads } from './store.js';

assertReady();

const app = express();
// Raw body is needed to verify Meta's signature, so capture it during parsing.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

// --- Meta webhook verification handshake ------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === cfg.wa.verifyToken) {
    console.log('[webhook] verified by Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Inbound messages --------------------------------------------------------
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
    console.warn('[webhook] bad signature, rejected');
    return res.sendStatus(401);
  }

  // Acknowledge immediately. Meta retries anything slower than a few seconds,
  // which is why every message id is deduped below.
  res.sendStatus(200);

  try {
    for (const msg of parseInbound(req.body)) {
      if (!firstTimeSeeing(msg.id)) {
        console.log('[webhook] duplicate, skipped', msg.id);
        continue;
      }
      await handleMessage(msg).catch(err =>
        console.error('[flow] failed for', msg.from, err)
      );
    }
  } catch (err) {
    console.error('[webhook] handler error', err);
  }
});

// --- Pipeline view -----------------------------------------------------------
app.get('/leads', (req, res) => {
  const given = req.get('x-admin-token') || req.query.token;
  if (!cfg.adminToken || given !== cfg.adminToken) return res.sendStatus(401);
  res.json(allLeads());
});

app.listen(cfg.port, () => {
  console.log(`\nLedger booking bot listening on :${cfg.port}`);
  console.log(`Webhook URL to give Meta:  https://<your-public-host>/webhook`);
  console.log(`Verify token:              ${cfg.wa.verifyToken}\n`);
});

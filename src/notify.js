import { cfg } from './config.js';
import { sendText } from './whatsapp.js';

const HOOK = process.env.NOTIFY_WEBHOOK;

/**
 * Tells Samarth something happened.
 *
 * WhatsApp-to-owner only lands if the owner messaged the business number in the
 * last 24 hours, so a webhook (Slack, Discord, Telegram, n8n) is the reliable
 * channel. Console always gets it.
 */
export async function notifyOwner(text, meta = {}) {
  console.log('\n=== NOTIFY ===\n' + text + '\n==============\n');

  if (HOOK) {
    try {
      await fetch(HOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...meta }),
        signal: AbortSignal.timeout(6000),
      });
    } catch (e) {
      console.error('[notify] webhook failed:', e.message);
    }
  }

  if (cfg.owner.whatsapp) {
    try {
      await sendText(cfg.owner.whatsapp, text);
    } catch {
      // Expected when the 24h window with your own number has closed. Not an error.
    }
  }
}

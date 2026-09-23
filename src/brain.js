import { cfg, brainEnabled } from './config.js';

const SYSTEM = `You classify inbound WhatsApp messages sent to Ledger, a Singapore startup that
helps small shops and hawker stalls place restocking orders by voice note instead of typing
into several supplier chats.

A shop owner has messaged in, usually after scanning a poster. A bot has offered them time
slots for a free 20-minute onboarding visit.

Classify the message into exactly one intent:

- "book"           they want to book, or are asking about a time, or naming a time themselves
- "reschedule"     they already booked and want to change or cancel it
- "details"        they are answering with a shop name, address, or unit number
- "question"       any question about the service, price, suppliers, how it works, trust
- "not_interested" they are declining, not keen, or asking to stop
- "other"          anything else, including greetings, unclear text, wrong number

Also return:
- "lang": "en", "zh" or "ms" for the language they wrote in
- "time_hint": any specific day or time they named, verbatim, else null
- "shop": a shop name if they gave one, else null

Reply with JSON only. No prose, no code fences.`;

/** Returns null when OpenRouter is not configured or fails: caller hands to a human. */
export async function classify(text, { lang = 'en' } = {}) {
  if (!brainEnabled || !text?.trim()) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.openrouter.key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Ledger Booking Bot',
      },
      body: JSON.stringify({
        model: cfg.openrouter.model,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Language guess: ${lang}\nMessage: ${text}` },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });

    const j = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(j).slice(0, 300));

    const raw = j?.choices?.[0]?.message?.content ?? '';
    const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    const allowed = ['book', 'reschedule', 'details', 'question', 'not_interested', 'other'];
    if (!allowed.includes(parsed.intent)) parsed.intent = 'other';
    return parsed;
  } catch (e) {
    console.error('[brain] classify failed:', e.message);
    return null;
  }
}

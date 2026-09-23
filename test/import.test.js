import test from "node:test";
import assert from "node:assert/strict";
import {
  parseExport,
  detectDateOrder,
  looksLikeExport,
  activityProfile,
} from "../src/import.js";

/**
 * Fixtures are real export shapes, not idealised ones. Every one of these
 * variants exists on a phone in Singapore: iOS and Android, 12- and 24-hour,
 * day-first and month-first, English and Chinese. A parser written against a
 * single sample breaks on the second shop.
 */

const IOS = `‎[23/09/2026, 8:14:12 am] Ah Seng: onion 2 bag
‎[23/09/2026, 8:14:40 am] Ah Seng: chicken 10 kg
‎[23/09/2026, 8:15:02 am] Hock Lee Trading: ok boss
‎[24/09/2026, 7:58:01 am] Ah Seng: onion 2 bag
oil 4 tin
‎[24/09/2026, 8:02:11 am] Hock Lee Trading: ‎image omitted
‎[25/09/2026, 9:10:00 pm] Ah Seng: rice 2 sack`;

const ANDROID = `23/09/2026, 8:14 am - Ah Seng: onion 2 bag
23/09/2026, 8:15 am - Hock Lee Trading: ok
24/09/2026, 20:05 - Ah Seng: chicken 10 kg
25/09/2026, 07:40 - Ah Seng: <Media omitted>`;

const CHINESE = `[2026/9/23 上午8:14:12] 陈叔: 洋葱 2 包
[2026/9/23 下午8:15:30] 发记: 收到
[2026/9/24 上午7:58:00] 陈叔: 鸡肉 10 公斤`;

const US = `9/23/26, 8:14 PM - Ah Seng: onion 2 bag
10/23/26, 8:15 PM - Hock Lee Trading: ok
11/23/26, 8:16 PM - Ah Seng: rice 2 sack`;

test("TC-IM-01 parses an iOS export, folding continuation lines", () => {
  const { messages, meta } = parseExport(IOS);
  assert.equal(meta.format, "ios");
  assert.equal(meta.messageCount, 6);
  assert.equal(messages[3].body, "onion 2 bag\noil 4 tin");
  assert.equal(messages[0].author, "Ah Seng");
  assert.equal(meta.authors[0].name, "Ah Seng");
  assert.equal(meta.authors[0].count, 4);
  assert.equal(meta.distinctDays, 3);
});

test("TC-IM-02 parses an Android export in both 12- and 24-hour form", () => {
  const { messages, meta } = parseExport(ANDROID);
  assert.equal(meta.format, "android");
  assert.equal(meta.messageCount, 4);
  assert.equal(new Date(messages[0].at).getUTCHours(), 8);
  assert.equal(new Date(messages[2].at).getUTCHours(), 20);
});

test("TC-IM-03 reads Chinese locale markers as morning and evening", () => {
  const { messages, meta } = parseExport(CHINESE);
  assert.equal(meta.messageCount, 3);
  assert.equal(new Date(messages[0].at).getUTCHours(), 8);
  assert.equal(new Date(messages[1].at).getUTCHours(), 20);
  assert.equal(messages[0].author, "陈叔");
});

test("TC-IM-04 detects month-first dates instead of assuming Singapore order", () => {
  const { messages, meta } = parseExport(US);
  assert.equal(meta.dayFirst, false);
  assert.equal(meta.dateOrderAmbiguous, false);
  assert.equal(new Date(messages[0].at).getUTCMonth(), 8); // September
  assert.equal(new Date(messages[2].at).getUTCMonth(), 10); // November
});

test("TC-IM-05 flags an export whose date order cannot be determined", () => {
  const { meta } = parseExport(`1/2/2026, 8:14 am - Ah Seng: onion 2 bag
3/4/2026, 8:15 am - Ah Seng: rice 2 sack`);
  assert.equal(meta.dateOrderAmbiguous, true);
  assert.equal(meta.dayFirst, true); // Singapore default, but declared
});

test("TC-IM-06 treats lines without an author as system notices", () => {
  const { messages } = parseExport(
    `‎[23/09/2026, 8:00:00 am] Messages and calls are end-to-end encrypted.
‎[23/09/2026, 8:14:12 am] Ah Seng: onion 2 bag`,
  );
  assert.equal(messages[0].system, true);
  assert.equal(messages[0].author, null);
  assert.equal(messages[1].system, false);
});

test("TC-IM-07 counts omitted media without treating it as an order line", () => {
  assert.equal(parseExport(IOS).meta.mediaCount, 1);
  assert.equal(parseExport(ANDROID).meta.mediaCount, 1);
});

test("TC-IM-08 rejects a document that is not a chat export", () => {
  assert.equal(
    looksLikeExport("INVOICE 4471\nTotal: S$182.50\nThank you"),
    false,
  );
  assert.equal(looksLikeExport(""), false);
  assert.equal(looksLikeExport(IOS), true);
});

test("TC-IM-09 date order helper prefers evidence over the default", () => {
  assert.deepEqual(detectDateOrder([[13, 2]]), {
    dayFirst: true,
    ambiguous: false,
  });
  assert.deepEqual(detectDateOrder([[2, 13]]), {
    dayFirst: false,
    ambiguous: false,
  });
  assert.deepEqual(detectDateOrder([[2, 3]]), {
    dayFirst: true,
    ambiguous: true,
  });
});

test("TC-IM-10 activity profile counts one author's weekdays and hours", () => {
  const { messages } = parseExport(IOS);
  const all = activityProfile(messages);
  const seng = activityProfile(messages, "Ah Seng");
  assert.equal(
    seng.hour.reduce((a, b) => a + b, 0),
    4,
  );
  assert.ok(
    all.hour.reduce((a, b) => a + b, 0) > seng.hour.reduce((a, b) => a + b, 0),
  );
  assert.equal(seng.hour[8], 2); // two 8am orders
});

test("TC-IM-11 survives a truncated or corrupted file without throwing", () => {
  for (const bad of [
    "",
    "\u0000\u0000",
    "[[[[",
    "23/09/2026",
    "a".repeat(5000),
  ]) {
    const { meta } = parseExport(bad);
    assert.equal(typeof meta.messageCount, "number");
  }
});

test("TC-IM-12 caps the work done on a very large file", () => {
  const huge = Array.from(
    { length: 5000 },
    (_, i) => `23/09/2026, 8:14 am - Ah Seng: line ${i}`,
  ).join("\n");
  const { meta } = parseExport(huge, { maxLines: 100 });
  assert.equal(meta.messageCount, 100);
});

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
process.env.DB_FILE = ":memory:";
process.env.DRY_RUN = "1";
process.env.ADMIN_TOKEN = "media-test-operator-token-32-chars!!";
process.env.WHATSAPP_TOKEN = "media-test-graph-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-fixture";
const { fetchMediaText } = await import("../src/whatsapp.js");

/**
 * The media download is the one piece that cannot be exercised against the real
 * Cloud API from here, so it is stubbed at the fetch boundary. The behaviour
 * worth pinning is the two-step shape: a lookup that returns a short-lived URL,
 * then a download that must happen immediately after it.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonRes = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function stub({ meta, body, downloadStatus = 200 }) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), auth: options?.headers?.Authorization });
    if (String(url).includes("graph.facebook.com")) return jsonRes(meta);
    return new Response(body, { status: downloadStatus });
  };
  return calls;
}

test("TC-MED-01 resolves the media id then downloads, both with the token", async () => {
  const calls = stub({
    meta: { url: "https://lookaside.example/abc", mime_type: "text/plain" },
    body: "23/09/2026, 8:14 am - Ah Seng: onion 2 bag",
  });
  const file = await fetchMediaText("media-1");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /graph\.facebook\.com\/v\d+\.\d+\/media-1$/);
  assert.equal(calls[1].url, "https://lookaside.example/abc");
  for (const call of calls)
    assert.equal(call.auth, "Bearer media-test-graph-token");
  assert.equal(file.text, "23/09/2026, 8:14 am - Ah Seng: onion 2 bag");
  assert.equal(file.bytes, Buffer.byteLength(file.text));
  assert.match(file.sha256, /^[0-9a-f]{64}$/);
});

test("TC-MED-02 refuses a file that declares itself too large, before downloading", async () => {
  const calls = stub({
    meta: { url: "https://lookaside.example/big", file_size: 99_000_000 },
    body: "x",
  });
  await assert.rejects(() => fetchMediaText("media-2", { maxBytes: 1024 }), {
    permanent: true,
  });
  assert.equal(calls.length, 1, "the download is never started");
});

test("TC-MED-03 refuses a file that understates its size while streaming", async () => {
  stub({
    meta: { url: "https://lookaside.example/liar", file_size: 10 },
    body: "x".repeat(5000),
  });
  await assert.rejects(() => fetchMediaText("media-3", { maxBytes: 1024 }), {
    permanent: true,
  });
});

test("TC-MED-04 a lookup with no URL is permanent, not retried forever", async () => {
  stub({ meta: { id: "media-4" }, body: "" });
  await assert.rejects(() => fetchMediaText("media-4"), { permanent: true });
});

test("TC-MED-05 an expired download URL is retryable, not permanent", async () => {
  stub({
    meta: { url: "https://lookaside.example/gone" },
    body: "",
    downloadStatus: 410,
  });
  // 410 is a client error, but the media id outlives the URL, so a later
  // attempt re-resolves it and succeeds. Treating it as permanent, which the
  // default rule does, would throw away an export we could still fetch.
  await assert.rejects(
    () => fetchMediaText("media-5"),
    (error) => {
      assert.equal(error.permanent, false);
      return true;
    },
  );
});

test("TC-MED-07 a rejected token is permanent, because retrying cannot fix it", async () => {
  stub({
    meta: { url: "https://lookaside.example/nope" },
    body: "",
    downloadStatus: 401,
  });
  await assert.rejects(
    () => fetchMediaText("media-7"),
    (error) => {
      assert.equal(error.permanent, true);
      return true;
    },
  );
});

test("TC-MED-06 a server error is retryable", async () => {
  stub({
    meta: { url: "https://lookaside.example/oops" },
    body: "",
    downloadStatus: 503,
  });
  await assert.rejects(
    () => fetchMediaText("media-6"),
    (error) => {
      assert.equal(error.permanent, false);
      return true;
    },
  );
});

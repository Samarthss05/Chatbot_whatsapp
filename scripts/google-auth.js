import "dotenv/config";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID,
  CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT = "http://127.0.0.1:5555/callback";
if (!CLIENT_ID || !CLIENT_SECRET)
  throw new Error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.",
  );
const state = randomBytes(32).toString("hex");
const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope:
      "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy",
    access_type: "offline",
    prompt: "consent",
    state,
  });
console.log("\nOpen this URL to authorize Google Calendar:\n" + url + "\n");
let consumed = false;
const server = http.createServer(async (req, res) => {
  const callback = new URL(req.url, REDIRECT),
    received = callback.searchParams.get("state") || "";
  if (
    callback.pathname !== "/callback" ||
    received.length !== state.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(received)) ||
    consumed
  ) {
    res.writeHead(400).end("Invalid authorization callback.");
    return;
  }
  const code = callback.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Authorization was not completed.");
    return;
  }
  consumed = true;
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.refresh_token)
      throw new Error(
        "No refresh token returned. Revoke this app’s access in your Google account and authorize again.",
      );
    res.end(
      "Authorization complete. Copy the refresh token from your local terminal into .env.",
    );
    console.log(
      "\nStore this only in .env:\nGOOGLE_REFRESH_TOKEN=" +
        result.refresh_token +
        "\n",
    );
  } catch (error) {
    res.writeHead(500).end("Authorization failed. See your local terminal.");
    console.error(error.message);
  } finally {
    clearTimeout(expiry);
    server.close();
  }
});
const expiry = setTimeout(() => {
  console.error("Authorization timed out. Run the command again.");
  server.close();
}, 300000);
expiry.unref();
server.listen(5555, "127.0.0.1", () =>
  console.log("Waiting for the local authorization callback (5 minutes)."),
);

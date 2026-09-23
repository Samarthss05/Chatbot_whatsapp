/**
 * One-time Google Calendar authorisation.
 *
 *   1. console.cloud.google.com -> new project -> enable "Google Calendar API"
 *   2. APIs & Services -> OAuth consent screen -> External -> add yourself as a test user
 *   3. Credentials -> Create OAuth client ID -> Web application
 *      Authorised redirect URI:  http://localhost:5555/callback
 *   4. Put the client id and secret in .env
 *   5. npm run auth:google, open the printed URL, approve
 *   6. Paste the printed refresh token into GOOGLE_REFRESH_TOKEN in .env
 */
import 'dotenv/config';
import http from 'node:http';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT = 'http://localhost:5555/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const url =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
  });

console.log('\nOpen this in your browser:\n\n' + url + '\n');

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No code');
    return;
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const j = await r.json();

  if (j.refresh_token) {
    res.end('Done. Copy the refresh token from your terminal, then close this tab.');
    console.log('\nPaste this into .env:\n');
    console.log('GOOGLE_REFRESH_TOKEN=' + j.refresh_token + '\n');
  } else {
    res.end('No refresh token returned. Revoke access at myaccount.google.com/permissions and retry.');
    console.error('\nNo refresh_token in response:', JSON.stringify(j, null, 2));
  }
  server.close();
});

server.listen(5555, () => console.log('Waiting on http://localhost:5555/callback ...'));

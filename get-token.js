/**
 * One-time helper: obtain a Gmail refresh token for this tool.
 *
 * Usage:
 *   1. export GMAIL_CLIENT_ID=...   (or set it in your shell)
 *      export GMAIL_CLIENT_SECRET=...
 *   2. node get-token.js
 *   3. Open the printed URL, approve access, and the refresh token is printed here.
 *   4. Save it as the GMAIL_REFRESH_TOKEN GitHub secret.
 *
 * Uses a temporary local web server on http://localhost:53682 to catch the OAuth
 * redirect, so make sure that port is free.
 */

require("./lib/load-env");

const http = require("http");
const { google } = require("googleapis");

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT = "http://localhost:53682";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/spreadsheets",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your environment first.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token even on repeat runs
  scope: SCOPES,
});

console.log("\n1) Open this URL in your browser and approve access:\n");
console.log(authUrl + "\n");
console.log("Waiting for the redirect on http://localhost:53682 ...\n");

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/?")) {
    res.end("Waiting for OAuth redirect...");
    return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get("code");
  res.end("Done! You can close this tab and return to the terminal.");
  server.close();

  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      console.error(
        "No refresh_token returned. Revoke the app's access in your Google " +
          "account and run this again (the consent prompt must reappear)."
      );
      process.exit(1);
    }
    console.log("\n2) Your refresh token (save as the GMAIL_REFRESH_TOKEN secret):\n");
    console.log(tokens.refresh_token + "\n");
    process.exit(0);
  } catch (err) {
    console.error("Failed to exchange code:", err.message || err);
    process.exit(1);
  }
});

server.listen(53682);

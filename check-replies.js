/**
 * check-replies.js — scans Gmail outreach threads for professor replies,
 * updates the Google Sheet status to "Replied", and marks the ledger entry
 * so follow-up stops automatically.
 *
 * Run: node check-replies.js
 * GitHub Actions: check-replies.yml (runs every 4 hours on weekdays)
 */

require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { createSheetsClient, markCandidateReplied } = require("./lib/google-sheets");

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "outreach-config.json"), "utf8"));
const LEDGER_PATH = path.join(ROOT, "outreach-ledger.json");

async function main() {
  const ledger = fs.existsSync(LEDGER_PATH)
    ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
    : [];

  const toCheck = ledger.filter((e) => e.threadId && !e.replied);
  if (!toCheck.length) {
    console.log("No threads to check.");
    return;
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const sheets = createSheetsClient(oauth2);

  const profileRes = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profileRes.data.emailAddress.toLowerCase();

  console.log(`Checking ${toCheck.length} threads for replies (sent from ${myEmail})...\n`);

  let newReplies = 0;

  for (const entry of toCheck) {
    try {
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: entry.threadId,
        format: "metadata",
        metadataHeaders: ["From"],
      });

      const messages = thread.data.messages || [];
      const hasReply = messages.some((msg) => {
        const from = (
          msg.payload.headers.find((h) => h.name.toLowerCase() === "from") || {}
        ).value || "";
        return !from.toLowerCase().includes(myEmail);
      });

      if (hasReply) {
        console.log(`REPLIED: ${entry.name} <${entry.email}>`);
        entry.replied = true;
        entry.repliedAt = new Date().toISOString();
        newReplies++;

        if (config.spreadsheetId && config.sheetName) {
          const updated = await markCandidateReplied(
            sheets,
            config.spreadsheetId,
            config.sheetName,
            entry.email
          );
          console.log(`  Sheet: ${updated ? "updated to Replied" : "row not found"}`);
        }
      } else {
        console.log(`no reply: ${entry.name}`);
      }
    } catch (err) {
      console.log(`  error checking ${entry.name}: ${err.message}`);
    }
  }

  if (newReplies > 0) {
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
    console.log(`\n${newReplies} new ${newReplies === 1 ? "reply" : "replies"} recorded.`);
  } else {
    console.log("\nNo new replies.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

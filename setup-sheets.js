require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { parseCsv } = require("./lib/csv");
const { createSheetsClient, ensureCandidateSheet, forceRefreshCandidateSheet } = require("./lib/google-sheets");

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "outreach-config.json"), "utf8"));
const csvPath = path.join(ROOT, "candidates.csv");
const LEDGER_PATH = path.join(ROOT, "outreach-ledger.json");
const args = process.argv.slice(2);
const FORCE = args.includes("--force");

if (!config.spreadsheetId || !config.sheetName) {
  console.error("Set spreadsheetId and sheetName in outreach-config.json first.");
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error("candidates.csv not found.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET
);
oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

async function main() {
  let candidates = parseCsv(fs.readFileSync(csvPath, "utf8")).records;
  const sheets = createSheetsClient(oauth2);

  if (FORCE) {
    const ledger = fs.existsSync(LEDGER_PATH)
      ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
      : [];
    const contactedEmails = new Set(ledger.map((e) => e.email.toLowerCase()));
    const contactedPeople = new Set(ledger.map((e) => `${e.name}|${e.affiliation}`));

    const before = candidates.length;
    candidates = candidates.filter((c) => {
      if (c.email && contactedEmails.has(c.email.toLowerCase())) return false;
      if (contactedPeople.has(`${c.name}|${c.affiliation}`)) return false;
      return true;
    });
    console.log(`Filtered ${before - candidates.length} already-contacted; ${candidates.length} fresh candidates remain.`);

    const result = await forceRefreshCandidateSheet(sheets, config.spreadsheetId, config.sheetName, candidates);
    console.log(`Refreshed "${config.sheetName}" tab with ${result.count} fresh candidates.`);
  } else {
    const result = await ensureCandidateSheet(sheets, config.spreadsheetId, config.sheetName, candidates);
    console.log(
      result.imported
        ? `Imported ${candidates.length} candidates into the "${config.sheetName}" tab.`
        : `The "${config.sheetName}" tab already contains data; nothing was overwritten.`
    );
  }
}

main().catch((error) => {
  console.error("Google Sheets setup failed:", error.message || error);
  process.exit(1);
});

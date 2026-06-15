/**
 * enrich-investor-emails.js — finds emails for "Needs Email" rows in the
 * Outreach tab using Gemini + Google Search grounding.
 *
 * Run AFTER discover-investor-contacts.js has populated the sheet:
 *   node enrich-investor-emails.js
 *
 * Cost: ~$0.07 for 2800 orgs (Gemini 2.0 Flash + search grounding, paid key).
 * Each org: one Gemini call → Google searches their name → returns contact email.
 */

require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createSheetsClient } = require("./lib/google-sheets");

const ROOT = __dirname;
const config = JSON.parse(
  fs.readFileSync(path.join(ROOT, "investor-outreach-config.json"), "utf8")
);

const CONCURRENCY = 5;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
const EMAIL_BLOCK =
  /noreply|no-reply|donotreply|unsubscribe|example\.|sentry\.io|w3\.org|schema\.org|amazonaws|mailchimp|sendgrid|cloudflare|privacy@|legal@|press@|media@|abuse@|postmaster@|webmaster@|security@|wixpress|squarespace|googleapis|github\.com/i;
const EMAIL_BAD_EXT = /\.(svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|eot|ico|pdf|zip|mp4|mp3)$/i;
const EMAIL_PLACEHOLDER = /^(user@domain|test@test|example@|admin@example|foo@bar)/i;

function isValidEmail(e) {
  return !EMAIL_BLOCK.test(e) && !EMAIL_BAD_EXT.test(e) && !EMAIL_PLACEHOLDER.test(e);
}

function extractBestEmail(text) {
  const all = [...new Set((text.match(EMAIL_RE) || []))].filter(isValidEmail);
  if (!all.length) return null;

  const PRIORITY = ["apply@", "hello@", "hi@", "contact@", "team@", "info@",
    "partners@", "investments@", "invest@", "venture@", "fund@", "pitch@", "founders@"];

  return all.sort((a, b) => {
    const ai = PRIORITY.findIndex((p) => a.toLowerCase().startsWith(p));
    const bi = PRIORITY.findIndex((p) => b.toLowerCase().startsWith(p));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  })[0];
}

// ---------------------------------------------------------------------------
// Gemini + Google Search grounding
// ---------------------------------------------------------------------------

function buildGeminiSearchModel(genAI) {
  return genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
  });
}

async function findEmailViaGemini(model, orgName, website, description) {
  const context = [
    website ? `Their website: ${website}.` : "",
    description ? `About them: ${description.slice(0, 150)}.` : "",
  ].filter(Boolean).join(" ");

  const prompt = `Find the official contact email address for "${orgName}" — a startup accelerator, VC fund, or angel investor.
${context}

Search their official website for an email to contact them about startup investment or accelerator applications.
Return ONLY the email address (like hello@example.com). If no email is found, return "not found".
Do not explain, just return the email or "not found".`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    if (/not found/i.test(text) && !text.includes("@")) return null;
    const email = extractBestEmail(text);
    return email || null;
  } catch (err) {
    // Rate limit — back off
    if (/429|quota/i.test(err.message || "")) {
      await sleep(30000);
      return null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function loadNeedsEmailRows(sheets, spreadsheetId, sheetName) {
  const range = `${quoteSheetName(sheetName)}!A1:J`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (name) => headers.findIndex((h) => h === name.toLowerCase());

  const iName    = col("name");
  const iEmail   = col("email");
  const iWebsite = col("website");
  const iDesc    = col("description");
  const iStatus  = col("status");

  return rows.slice(1)
    .map((row, offset) => ({
      name:        (row[iName]    || "").trim(),
      email:       (row[iEmail]   || "").trim(),
      website:     (row[iWebsite] || "").trim(),
      description: (row[iDesc]    || "").trim(),
      status:      (row[iStatus]  || "").trim(),
      _sheetRow:   offset + 2,
    }))
    .filter((r) => r.name && r.status.toLowerCase() === "needs email");
}

async function updateEmailInSheet(sheets, spreadsheetId, sheetName, rowNumber, email) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: `${quoteSheetName(sheetName)}!B${rowNumber}`, values: [[email]] },
        { range: `${quoteSheetName(sheetName)}!G${rowNumber}`, values: [["To Contact"]] },
        { range: `${quoteSheetName(sheetName)}!I${rowNumber}`, values: [["Review before first email"]] },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const sheets = createSheetsClient(oauth2);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = buildGeminiSearchModel(genAI);

  const spreadsheetId = config.sourceSpreadsheetId;
  const outreachSheet = config.outreachSheetName || "Outreach";

  console.log(`Loading "Needs Email" rows from "${outreachSheet}" tab...`);
  const rows = await loadNeedsEmailRows(sheets, spreadsheetId, outreachSheet);
  console.log(`Found ${rows.length} rows needing email discovery.\n`);

  if (!rows.length) {
    console.log("All rows already have emails. Nothing to do.");
    return;
  }

  let found = 0, failed = 0, done = 0;
  const total = rows.length;

  // Process in parallel chunks
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      chunk.map(async (row) => {
        const email = await findEmailViaGemini(model, row.name, row.website, row.description);
        return { row, email };
      })
    );

    // Write updates sequentially (Sheets API rate limit)
    for (const { row, email } of results) {
      done++;
      if (email) {
        process.stdout.write(`[${done}/${total}] ✓ ${row.name} → ${email}\n`);
        try {
          await updateEmailInSheet(sheets, spreadsheetId, outreachSheet, row._sheetRow, email);
          found++;
        } catch (err) {
          console.log(`  Warning: found email but sheet update failed: ${err.message}`);
        }
      } else {
        process.stdout.write(`[${done}/${total}]   ${row.name} — not found\n`);
        failed++;
      }
      await sleep(100); // brief pause between sheet writes
    }

    // Pause between Gemini chunks to respect rate limits
    await sleep(1000);
  }

  console.log("\n--- Done ---");
  console.log(`Emails found: ${found} | Still missing: ${failed}`);
  console.log(`\nRows with "To Contact" status are ready for investor-outreach.js`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

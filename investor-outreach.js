/**
 * investor-outreach.js — reads org emails from the "Outreach" tab, uses one
 * Gemini call per org to (a) identify the best partner/GP by name and their
 * portfolio parallel to PluginAny, then (b) write a personalized YC-quality
 * pitch email to that specific person.
 *
 * Total Gemini calls per day: dailyCap (default 10) — well within free tier.
 *
 * Secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GEMINI_API_KEY
 * Settings: investor-outreach-config.json
 */

require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const Groq = require("groq-sdk");
const { createSheetsClient } = require("./lib/google-sheets");

const ROOT = __dirname;
const config = JSON.parse(
  fs.readFileSync(path.join(ROOT, "investor-outreach-config.json"), "utf8")
);

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const YOUR_NAME     = "Aditya Srivastava";

const DRY_RUN =
  process.env.DRY_RUN != null && process.env.DRY_RUN !== ""
    ? /^(1|true|yes)$/i.test(process.env.DRY_RUN)
    : config.dryRun !== false;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Missing Gmail credentials.");
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function loadProfile() {
  const p = path.join(ROOT, "investor-profile.md");
  if (!fs.existsSync(p)) { console.error("investor-profile.md not found."); process.exit(1); }
  return fs.readFileSync(p, "utf8");
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER_PATH = path.join(ROOT, "investor-ledger.json");
function loadLedger() {
  return fs.existsSync(LEDGER_PATH) ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) : [];
}
function saveLedger(l) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Google Sheet helpers
// ---------------------------------------------------------------------------

function quoteSheetName(n) { return `'${String(n).replace(/'/g, "''")}'`; }

async function loadOutreachCandidates(sheets, spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!A1:J`,
  });
  const rows = res.data.values || [];
  if (!rows.length) throw new Error(`"${sheetName}" tab is empty. Run npm run investor:discover first.`);

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (kw) => headers.findIndex((h) => h.includes(kw));

  const iName    = col("name");
  const iEmail   = col("email");
  const iWebsite = col("website");
  const iDesc    = col("description");
  const iType    = col("type");
  const iStatus  = col("status");

  return rows.slice(1).map((row, offset) => ({
    name:        (row[iName]    || "").trim(),
    email:       (row[iEmail]   || "").trim(),
    website:     (row[iWebsite] || "").trim(),
    description: (row[iDesc]    || "").trim(),
    type:        (row[iType]    || "Accelerator").trim(),
    status:      (row[iStatus]  || "").trim(),
    _sheetRow:   offset + 2,
  }));
}

async function markSent(sheets, spreadsheetId, sheetName, rowNumber, partnerName) {
  const followUp = new Date();
  followUp.setUTCDate(followUp.getUTCDate() + 7);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!G${rowNumber}:I${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        "First Email Sent",
        followUp.toISOString().slice(0, 10),
        partnerName ? `Sent to ${partnerName}` : "Awaiting reply",
      ]],
    },
  });
}

// ---------------------------------------------------------------------------
// Gemini: combined research + email in one call
// ---------------------------------------------------------------------------

const JSON_SCHEMA = `{
  "partner_name": "Full name of the specific partner/GP/MD at this org",
  "partner_role": "Their role e.g. General Partner, Managing Director, Partner",
  "portfolio_reference": "One company they backed adjacent to PluginAny + why e.g. 'Rappi — on-demand aggregation, same routing thesis'. Empty string if none.",
  "subject": "Email subject line 4-7 words",
  "body": "Plain-text email body 80-100 words with \\n\\n between paragraphs",
  "linkedin_note": "LinkedIn note max 280 chars, no greeting, end with — Aditya",
  "skip": false
}`;

const SYSTEM_PROMPT = `You are writing investor outreach for Aditya Srivastava (CTO, PluginAny). For each org, you will:
1. Identify the single most relevant partner/GP at the org — the one whose personal investment history best overlaps with aggregation, marketplace infrastructure, API layers, routing, or developer platforms.
2. Recall one specific portfolio company they personally backed that is conceptually adjacent to PluginAny.
3. Write a YC-quality cold email using that portfolio parallel as the hook.

PluginAny context: discovery + aggregation + marketplace + real-time routing platform. Think "Stripe for plugin/service discovery" — one intelligent layer over every fragmented provider. 350k+ organic followers. Routing engine live. CTO: top 0.4% JEE nationally (1 in 1.2M).

EMAIL RULES:
- Subject: "re: [PortfolioCompany] — [sharp PluginAny phrase]" OR "350k followers, routing platform — [org]"
- Hook (line 1): Draw the SPECIFIC thesis parallel between their portfolio company and PluginAny. Not just "you backed X" — say WHY the thesis is the same.
  Example: "Twilio turned telecom into a developer API — PluginAny does that for the plugin and service discovery layer."
  Example: "You backed Rappi before on-demand aggregation was obvious — PluginAny is the same intelligent routing layer for the plugin ecosystem."
- Para 2: What PluginAny does (plain English, 1 sentence). Proof: routing engine live. Team: "CTO: top 0.4% JEE nationally — 1 in 1.2 million." (write exactly this)
- Para 3 ask: Confident, peer-to-peer. Accelerators: "We'd love to be in your next cohort — happy to send a deck or jump on a call." VCs/angels: "Would love 15 minutes to show you what we've built."
- Sign-off: "Best,\nAditya\nCTO, PluginAny\nhttps://pluginany.com"
- 80–100 words total body. Plain text only. Paragraphs separated by \\n\\n.

FORBIDDEN: "I hope this finds you well", "passionate/excited/thrilled", "disrupting/game-changing/revolutionary", "I wanted to reach out", dollar amounts in the ask, invented metrics.

If the org is clearly irrelevant (arts, biotech-only, non-tech nonprofit), set skip=true and leave email fields empty.`;

function buildClient() {
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isTransient(err) {
  return /429|500|503|overloaded|quota|resource exhausted|ECONNRESET|ETIMEDOUT/i.test(String(err?.message || err));
}

async function researchAndWrite(client, profile, org) {
  const userPrompt = `COMPANY PROFILE (sender):
${profile}

TARGET ORG:
Name: ${org.name}
Type: ${org.type}
Website: ${org.website || "unknown"}
Description: ${(org.description || "").slice(0, 300)}

Research the most relevant partner at this org and write the personalized email now.
Respond with ONLY a JSON object matching this shape:
${JSON_SCHEMA}`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
      });

      const data = JSON.parse(completion.choices[0].message.content);
      if (data.body) {
        data.body = data.body.replace(/\r\n/g, "\n").trim();
        if (!data.body.includes("\n")) throw new Error("body missing paragraph breaks");
      }
      if (data.linkedin_note && data.linkedin_note.length > 300)
        data.linkedin_note = data.linkedin_note.slice(0, 297) + "...";

      return data;
    } catch (err) {
      if (attempt === 4) throw err;
      const wait = isTransient(err) ? attempt * 10000 : 3000;
      console.log(`  Groq attempt ${attempt}/4 failed (${err.message}) — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

function buildRaw({ to, from, subject, body }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "",
    Buffer.from(body, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ensureLabel(gmail, name) {
  const res = await gmail.users.labels.list({ userId: "me" });
  const ex = (res.data.labels || []).find((l) => l.name === name);
  if (ex) return ex.id;
  const cr = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return cr.data.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (config.weekdaysOnly !== false) {
    const day = new Date().getUTCDay();
    if (day === 0 || day === 6) { console.log("Weekend — skipping."); return; }
  }

  const profile = loadProfile();
  const ledger = loadLedger();

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const sheets = createSheetsClient(oauth2);

  const outreachTab = config.outreachSheetName || "Outreach";
  const candidates = await loadOutreachCandidates(sheets, config.sourceSpreadsheetId, outreachTab);

  const contactedEmails = new Set(ledger.map((e) => e.email.toLowerCase()));
  const skip = new Set((config.skipAddresses || []).map((a) => a.toLowerCase()));

  const batch = candidates
    .filter((c) => c.email && c.email.includes("@"))
    .filter((c) => c.status.toLowerCase() === "to contact")
    .filter((c) => !contactedEmails.has(c.email.toLowerCase()))
    .filter((c) => !skip.has(c.email.toLowerCase()))
    .slice(0, config.dailyCap || 10);

  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE — emails WILL be sent"}`);
  console.log(`Batch: ${batch.length} orgs (cap ${config.dailyCap})\n`);

  if (!batch.length) {
    console.log("Nothing to send. Run: npm run investor:discover");
    return;
  }

  const profileRes = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profileRes.data.emailAddress;
  console.log(`Signed in as ${myEmail}\n`);

  const groq = buildClient();
  const model = groq;
  const labelId = DRY_RUN ? null : await ensureLabel(gmail, config.gmailLabel || "investor-outreach");

  let sent = 0, skipped = 0, failed = 0;

  for (const org of batch) {
    console.log(`→ ${org.name} <${org.email}>`);

    let result;
    try {
      result = await researchAndWrite(model, profile, org);
    } catch (err) {
      console.log(`  ✗ Gemini failed: ${err.message}\n`);
      failed++;
      continue;
    }

    if (result.skip) {
      console.log(`  SKIP — irrelevant org\n`);
      skipped++;
      continue;
    }

    console.log(`  Partner: ${result.partner_name || "unknown"} (${result.partner_role || ""})`);
    if (result.portfolio_reference) console.log(`  Backed: ${result.portfolio_reference}`);
    console.log(`  Subject: ${result.subject}`);
    console.log("  " + (result.body || "").split("\n").join("\n  "));
    if (result.linkedin_note) {
      console.log(`\n  LinkedIn (${result.linkedin_note.length} chars):\n  "${result.linkedin_note}"`);
    }

    if (DRY_RUN) {
      console.log("  (dry run — not sent)\n");
      sent++;
      continue;
    }

    try {
      const toHeader = result.partner_name
        ? `"${result.partner_name}" <${org.email}>`
        : org.email;

      const raw = buildRaw({ to: toHeader, from: myEmail, subject: result.subject, body: result.body });
      const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      await gmail.users.messages.modify({
        userId: "me", id: res.data.id,
        requestBody: { addLabelIds: [labelId] },
      });

      ledger.push({
        orgName: org.name,
        partnerName: result.partner_name || "",
        partnerRole: result.partner_role || "",
        portfolioReference: result.portfolio_reference || "",
        email: org.email,
        subject: result.subject,
        body: result.body,
        linkedinNote: result.linkedin_note || "",
        sentAt: new Date().toISOString(),
        messageId: res.data.id,
        threadId: res.data.threadId,
        replied: false,
      });
      saveLedger(ledger);

      if (org._sheetRow) {
        try {
          await markSent(sheets, config.sourceSpreadsheetId, outreachTab, org._sheetRow, result.partner_name);
        } catch (e) {
          console.log(`  Warning: sent but sheet update failed: ${e.message}`);
        }
      }

      sent++;
      console.log(`  ✓ sent to ${result.partner_name || org.name}\n`);
    } catch (err) {
      console.log(`  ✗ send failed: ${err.message}\n`);
      failed++;
    }

    const delay = (config.delaySecondsBetweenEmails || 60) * 1000 * (0.8 + Math.random() * 0.4);
    await sleep(delay);
  }

  console.log("--- Summary ---");
  console.log(`${DRY_RUN ? "Would send" : "Sent"}: ${sent} | skipped irrelevant: ${skipped} | failed: ${failed} | total in ledger: ${ledger.length}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

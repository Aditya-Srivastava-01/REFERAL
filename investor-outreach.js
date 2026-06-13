/**
 * investor-outreach.js — daily first-contact sender for investor / accelerator outreach.
 *
 * Reads "To Contact" rows from the "Outreach" tab of the investors spreadsheet,
 * has Gemini write a personalized PluginAny pitch email, sends it from Gmail,
 * labels it "investor-outreach", and records everything in investor-ledger.json.
 *
 * Secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 *          GEMINI_API_KEY, YOUR_NAME
 * Settings: investor-outreach-config.json
 */

require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { createSheetsClient } = require("./lib/google-sheets");

const ROOT = __dirname;
const config = JSON.parse(
  fs.readFileSync(path.join(ROOT, "investor-outreach-config.json"), "utf8")
);

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const YOUR_NAME     = process.env.YOUR_NAME || "";

const DRY_RUN =
  process.env.DRY_RUN != null && process.env.DRY_RUN !== ""
    ? /^(1|true|yes)$/i.test(process.env.DRY_RUN)
    : config.dryRun !== false;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Missing Gmail credentials.");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY.");
  process.exit(1);
}
if (!YOUR_NAME) {
  console.error("Missing YOUR_NAME env var.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function loadProfile() {
  const p = path.join(ROOT, "investor-profile.md");
  if (!fs.existsSync(p)) {
    console.error("investor-profile.md not found.");
    process.exit(1);
  }
  const text = fs.readFileSync(p, "utf8");
  if (/FILL IN/i.test(text)) {
    console.warn("Warning: investor-profile.md has unfilled placeholders. Fill them before sending live emails.");
  }
  return text;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const LEDGER_PATH = path.join(ROOT, "investor-ledger.json");
function loadLedger() {
  return fs.existsSync(LEDGER_PATH)
    ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
    : [];
}
function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Google Sheet: read Outreach tab
// ---------------------------------------------------------------------------

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function loadInvestorCandidates(sheets, spreadsheetId, sheetName) {
  const range = `${quoteSheetName(sheetName)}!A1:J`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (!rows.length) throw new Error(`"${sheetName}" tab is empty. Run npm run investor:discover first.`);

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (name) => headers.findIndex((h) => h.includes(name.toLowerCase()));

  const iName     = col("name");
  const iEmail    = col("email");
  const iWebsite  = col("website");
  const iDesc     = col("description");
  const iLocation = col("location");
  const iType     = col("type");
  const iStatus   = col("status");

  return rows.slice(1).map((row, offset) => ({
    name:        (row[iName]     || "").trim(),
    email:       (row[iEmail]    || "").trim(),
    website:     (row[iWebsite]  || "").trim(),
    description: (row[iDesc]     || "").trim(),
    location:    (row[iLocation] || "").trim(),
    type:        (row[iType]     || "Accelerator").trim(),
    status:      (row[iStatus]   || "").trim(),
    _sheetRow:   offset + 2,
  }));
}

async function markInvestorSent(sheets, spreadsheetId, sheetName, rowNumber) {
  const followUp = new Date();
  followUp.setUTCDate(followUp.getUTCDate() + 7);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteSheetName(sheetName)}!G${rowNumber}:I${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["First Email Sent", followUp.toISOString().slice(0, 10), "Awaiting reply"]],
    },
  });
}

// ---------------------------------------------------------------------------
// Gemini: write the pitch email
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You write cold outreach emails from a startup CTO to an investor or accelerator partner.

GOAL: Get a reply within 48 hours. The reader sees 100+ cold pitches a day. The email must signal: real traction, clear product, strong team, right stage — in 5 seconds of scanning.

━━━ EXACT STRUCTURE (three paragraphs) ━━━

1. HOOK (one sentence, first line after greeting):
   Lead with the strongest concrete signal from the profile. Traction number OR a specific product milestone. Never "I hope this finds you well." Never "I wanted to reach out."

2. PRODUCT + TEAM (two to three sentences):
   - What PluginAny does in plain English (no buzzwords, one sentence).
   - What makes it defensible or why the timing is right (one sentence, optional).
   - Team signal: CTO is DTU engineering student, 99.59 percentile JEE Main — top 0.4% nationally out of 1.2M candidates. Shows technical depth.

3. ASK (one to two sentences):
   Adapt based on the org type field:
   - If type contains "Accelerator" → "We'd love to be considered for [Program Name / your next cohort]. Happy to jump on a call."
   - If type contains "VC" or "Venture" or "Fund" or "Angel" → "Would love a 15-minute intro call to show you what we've built."
   Never "I know you're busy." Never "at your earliest convenience."

Sign-off: "Best,\n[Name]\nCTO, PluginAny\n[website if available]"

━━━ HARD RULES ━━━

Forbidden (any of these is a failure):
- "I hope this email finds you well"
- "I am passionate / excited / thrilled / honored"
- "disrupting", "game-changing", "revolutionary", "transformative"
- "I wanted to reach out"
- "We're a startup that..."
- "I know you're busy"
- "at your earliest convenience"
- Invented metrics or claims not in the profile

Content rules:
- Use ONLY facts from COMPANY PROFILE. Never invent numbers.
- Body: 80–120 words. Tight. Investors do not read long cold pitches.
- Plain text only. No bullet points, no markdown, no links in body (except sign-off website).
- Paragraphs separated by blank lines (\\n\\n). Body MUST contain newline characters.

Subject line:
- 4–7 words. Specific. Put a number or outcome in it.
- Examples: "350k followers, pre-seed open — PluginAny", "PluginAny routing layer — $250k raise"

━━━ LINKEDIN NOTE ━━━

Also write a LinkedIn connection request note:
- STRICT 280-character limit (count every character including spaces).
- No greeting (LinkedIn adds "Hi [Name]," automatically).
- Structure: traction hook → what PluginAny does in one clause → team signal → CTA → name.
- Direct, not sycophantic. No "your impressive portfolio."
- Example: "350k followers across socials, building PluginAny — real-time routing for plugin discovery. CTO: top 0.4% JEE (1.2M candidates), DTU. Raising $300k pre-seed. — Aditya"`;

const EMAIL_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    subject: {
      type: SchemaType.STRING,
      description: "Email subject line, 4-7 words, concrete with a number or outcome.",
    },
    body: {
      type: SchemaType.STRING,
      description:
        "Plain-text email body, 80-120 words. Greeting on its own line, paragraphs separated by blank lines (\\n\\n), sign-off on its own line. Must contain newline characters — never a single collapsed paragraph.",
    },
    linkedin_note: {
      type: SchemaType.STRING,
      description:
        "LinkedIn connection request note. Strict 280-character max. No greeting. Traction hook, what PluginAny does, team signal, CTA, name. Direct and specific.",
    },
  },
  required: ["subject", "body", "linkedin_note"],
};

function buildGeminiModel(genAI) {
  return genAI.getGenerativeModel({
    model: config.model || "gemini-2.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: EMAIL_SCHEMA,
    },
  });
}

function isTransientLlmError(err) {
  const msg = String((err && err.message) || err);
  return /\b(429|500|503)\b|overloaded|high demand|temporarily|resource exhausted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const LLM_ATTEMPTS = 4;

async function generateEmail(model, profile, candidate) {
  const userMessage = `COMPANY PROFILE (the sender — sign as "${YOUR_NAME}", CTO of PluginAny):
${profile}

TARGET ORGANIZATION (the recipient):
Name: ${candidate.name}
Type: ${candidate.type}
Location: ${candidate.location}
Website: ${candidate.website || "unknown"}
Description: ${candidate.description || "No description available."}

Write the outreach email now. Adapt the ask for their type: "${candidate.type}".`;

  let lastErr;
  for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt++) {
    try {
      const result = await model.generateContent(userMessage);
      const text = result.response.text();
      if (!text) throw new Error("empty response");
      const email = JSON.parse(text);
      if (!email.subject || !email.body) throw new Error("incomplete email JSON");

      email.subject = email.subject.trim();
      email.body = email.body.replace(/\r\n/g, "\n").trim();
      email.linkedin_note = (email.linkedin_note || "").trim();

      if (!email.body.includes("\n")) throw new Error("body has no paragraph breaks");
      if (email.linkedin_note.length > 300)
        email.linkedin_note = email.linkedin_note.slice(0, 297) + "...";

      return email;
    } catch (err) {
      lastErr = err;
      if (attempt === LLM_ATTEMPTS) break;
      const waitMs = isTransientLlmError(err) ? attempt * 10000 : 2000;
      console.log(
        `  Gemini attempt ${attempt}/${LLM_ATTEMPTS} failed (${err.message}) — retrying in ${Math.round(waitMs / 1000)}s...`
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

function buildRawMessage({ to, from, subject, body }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function ensureLabel(gmail, name) {
  const res = await gmail.users.labels.list({ userId: "me" });
  const existing = (res.data.labels || []).find((l) => l.name === name);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (config.weekdaysOnly !== false) {
    const day = new Date().getUTCDay();
    if (day === 0 || day === 6) {
      console.log("Weekend — skipping.");
      return;
    }
  }

  const profile = loadProfile();
  const ledger = loadLedger();

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const sheets = createSheetsClient(oauth2);

  const candidates = await loadInvestorCandidates(
    sheets,
    config.sourceSpreadsheetId,
    config.outreachSheetName
  );

  const contactedEmails = new Set(ledger.map((e) => e.email.toLowerCase()));
  const skip = new Set((config.skipAddresses || []).map((a) => a.toLowerCase()));

  const batch = candidates
    .filter((c) => c.email && c.email.includes("@"))
    .filter((c) => c.status.trim().toLowerCase() === "to contact")
    .filter((c) => !contactedEmails.has(c.email.toLowerCase()))
    .filter((c) => !skip.has(c.email.toLowerCase()))
    .slice(0, config.dailyCap || 10);

  console.log(`Mode: ${DRY_RUN ? "DRY RUN (nothing will be sent)" : "LIVE (emails WILL be sent)"}`);
  console.log(`Candidates with email: ${candidates.filter((c) => c.email).length} | batch: ${batch.length} (cap ${config.dailyCap})\n`);

  if (!batch.length) {
    console.log("Nothing to send — run investor:discover to find more contacts.");
    return;
  }

  const profileRes = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profileRes.data.emailAddress;
  console.log(`Signed in as ${myEmail}\n`);

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const llm = buildGeminiModel(genAI);
  const labelId = DRY_RUN ? null : await ensureLabel(gmail, config.gmailLabel || "investor-outreach");

  let sent = 0, failed = 0;

  for (const candidate of batch) {
    console.log(`→ ${candidate.name} <${candidate.email}> [${candidate.type}]`);

    let email;
    try {
      email = await generateEmail(llm, profile, candidate);
    } catch (err) {
      console.log(`  ✗ email generation failed: ${err.message} — skipping.\n`);
      failed++;
      continue;
    }

    console.log(`  Subject: ${email.subject}`);
    console.log("  " + email.body.split("\n").join("\n  "));
    if (email.linkedin_note) {
      console.log(`\n  LinkedIn note (${email.linkedin_note.length} chars):`);
      console.log(`  "${email.linkedin_note}"`);
    }

    if (DRY_RUN) {
      console.log("  (dry run — not sent)\n");
      sent++;
      continue;
    }

    try {
      const raw = buildRawMessage({
        to: candidate.name ? `"${candidate.name}" <${candidate.email}>` : candidate.email,
        from: myEmail,
        subject: email.subject,
        body: email.body,
      });
      const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      await gmail.users.messages.modify({
        userId: "me",
        id: res.data.id,
        requestBody: { addLabelIds: [labelId] },
      });

      ledger.push({
        name: candidate.name,
        email: candidate.email,
        type: candidate.type,
        subject: email.subject,
        body: email.body,
        linkedinNote: email.linkedin_note || "",
        sentAt: new Date().toISOString(),
        messageId: res.data.id,
        threadId: res.data.threadId,
        replied: false,
      });
      saveLedger(ledger);

      if (candidate._sheetRow) {
        try {
          await markInvestorSent(
            sheets, config.sourceSpreadsheetId, config.outreachSheetName, candidate._sheetRow
          );
        } catch (e) {
          console.log(`  Warning: email sent but sheet update failed: ${e.message}`);
        }
      }

      sent++;
      console.log("  ✓ sent and labeled\n");
    } catch (err) {
      console.log(`  ✗ send failed: ${err.message}\n`);
      failed++;
    }

    const delay = (config.delaySecondsBetweenEmails || 60) * 1000 * (0.8 + Math.random() * 0.5);
    await sleep(delay);
  }

  console.log("--- Summary ---");
  console.log(`${DRY_RUN ? "Would send" : "Sent"}: ${sent} | failed: ${failed} | total ever: ${ledger.length}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

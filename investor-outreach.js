/**
 * investor-outreach.js — daily sender for person-centric investor outreach.
 *
 * Reads "To Contact" rows from the "People" tab (created by discover-investor-people.js),
 * has Gemini write a personalized pitch that references the partner's specific portfolio
 * company adjacent to PluginAny, sends via Gmail, and records everything in investor-ledger.json.
 *
 * Columns in "People" tab:
 *   A: Partner Name | B: Email | C: Organization | D: Role
 *   E: Portfolio Reference | F: Investment Thesis
 *   G: Status | H: Follow-up Date | I: Next Steps | J: LinkedIn
 *
 * Secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 *          GEMINI_API_KEY, YOUR_NAME
 * Settings: investor-outreach-config.json (set dryRun: false when ready)
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
const YOUR_NAME     = process.env.YOUR_NAME || "Aditya Srivastava";

const DRY_RUN =
  process.env.DRY_RUN != null && process.env.DRY_RUN !== ""
    ? /^(1|true|yes)$/i.test(process.env.DRY_RUN)
    : config.dryRun !== false;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Missing Gmail credentials. Check GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY.");
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
function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Google Sheet: read People tab
// ---------------------------------------------------------------------------

function quoteSheetName(name) { return `'${String(name).replace(/'/g, "''")}'`; }

async function loadPeopleCandidates(sheets, spreadsheetId, sheetName) {
  const range = `${quoteSheetName(sheetName)}!A1:J`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (!rows.length) throw new Error(`"${sheetName}" tab is empty. Run npm run investor:people first.`);

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (kw) => headers.findIndex((h) => h.includes(kw.toLowerCase()));

  const iPartner    = col("partner");
  const iEmail      = col("email");
  const iOrg        = col("organization");
  const iRole       = col("role");
  const iPortfolio  = col("portfolio");
  const iThesis     = col("investment thesis");
  const iStatus     = col("status");
  const iLinkedIn   = col("linkedin");

  return rows.slice(1).map((row, offset) => ({
    partnerName:         (row[iPartner]   || "").trim(),
    email:               (row[iEmail]     || "").trim(),
    organization:        (row[iOrg]       || "").trim(),
    role:                (row[iRole]      || "").trim(),
    portfolioReference:  (row[iPortfolio] || "").trim(),
    investmentThesis:    (row[iThesis]    || "").trim(),
    status:              (row[iStatus]    || "").trim(),
    linkedin:            (row[iLinkedIn]  || "").trim(),
    _sheetRow:           offset + 2,
  }));
}

async function markPersonSent(sheets, spreadsheetId, sheetName, rowNumber) {
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
// Gemini: write the personalized pitch email
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are writing a cold email from Aditya Srivastava (CTO, PluginAny) to a specific investor partner or GP. This email must be good enough that a YC partner would forward it to a colleague. Not "good for a cold email" — actually good.

━━━ MENTAL MODEL ━━━

The partner reads 200 cold pitches a week. 190 are filtered out in the subject line. Of the 10 they open, 9 die in the first sentence. The one they reply to did three things:
  (a) Showed it was written for THEM specifically — referenced something they personally backed.
  (b) Made the product instantly clear — one sentence, zero jargon.
  (c) Gave them one concrete reason to believe — a real number or a sharp analogy.

Write THAT email.

━━━ STRUCTURE (follow exactly) ━━━

SUBJECT LINE:
  If portfolio company is known → "re: [PortfolioCompany] — [one sharp phrase about PluginAny]"
  If no portfolio company → "[Traction number] + [what we are] — [org name]"
  Examples of good subjects:
    "re: Rappi — PluginAny is the routing layer for service discovery"
    "re: Twilio — same API-layer thesis, plugin ecosystem"
    "350k followers, live routing engine — PluginAny"
  Examples of bad subjects (never write these):
    "Exciting opportunity at PluginAny"
    "Pre-seed startup looking for investment"
    "PluginAny — $250k raise"

PARAGRAPH 1 — THE HOOK (2 sentences max):
  If portfolio company known:
    Sentence 1: Name their portfolio company and draw the SPECIFIC analogy to PluginAny.
    Do NOT just say "you backed X." Say WHY it's relevant: what thesis X and PluginAny share.
    Example: "You backed Rappi before on-demand aggregation was obvious — PluginAny is building the same intelligent routing layer, but for the fragmented plugin and service ecosystem."
    Example: "Twilio turned telecom infrastructure into a developer API. PluginAny does that for the plugin and service discovery layer — one integration, every provider."
  If no portfolio company:
    Lead with the sharpest traction signal: "350,000 people found PluginAny before we ran a single ad."

PARAGRAPH 2 — PROOF + TEAM (2–3 sentences):
  - What PluginAny does: one sentence, plain English. "We aggregate fragmented plugin/service providers into a single discovery, comparison, and real-time routing layer."
  - One proof point: routing engine is live and serving real traffic.
  - Team signal — write this EXACTLY, word for word, no paraphrasing:
    "CTO: top 0.4% JEE nationally — 1 in 1.2 million."

PARAGRAPH 3 — THE ASK (1–2 sentences):
  Confident, not desperate. Peer-to-peer, not supplicant.
  For accelerators: "We'd love to be in your next cohort — happy to send a deck or jump on a call."
  For VCs/GPs/angels: "Would love 15 minutes to show you what we've built."
  Never mention dollar amounts. Never "I know you're busy." Never "at your convenience."

SIGN-OFF:
  Best,
  Aditya
  CTO, PluginAny
  https://pluginany.com

━━━ HARD RULES — ANY VIOLATION IS A FAILURE ━━━

Never write:
  - "I hope this email finds you well" / "I hope you're doing well"
  - "I am passionate / excited / thrilled / honored / delighted"
  - "disrupting" / "game-changing" / "revolutionary" / "transformative" / "next-generation"
  - "I wanted to reach out" / "I am writing to"
  - "We're a startup that..." / "We're a pre-seed company..."
  - "I know you're busy" / "at your earliest convenience" / "whenever you get a chance"
  - Any invented metric not in the profile
  - Dollar amounts in the ask
  - CEO name or other team member names — only Aditya

Quality bar: if you could imagine this in a YC application or a Sequoia cold deck, you're on track. If it sounds like a LinkedIn InMail template, start over.

Total body length: 80–100 words. Every word must earn its place. Investors do not read long cold pitches.
Plain text only. No markdown, no bullet points, no links in the body (only in sign-off).
Paragraphs separated by blank lines (\\n\\n). Body MUST contain actual newline characters.

━━━ LINKEDIN NOTE ━━━

Also write a LinkedIn connection request note:
- STRICT 280-character hard limit (count every character including spaces and punctuation).
- No greeting — LinkedIn adds "Hi [Name]," automatically.
- If portfolio company known: open with the parallel — "You backed [X] — PluginAny is the [Y] layer for [Z]."
- Otherwise: traction number → what we do → team signal → ask.
- End with "— Aditya"
- Zero sycophancy. No "your impressive portfolio" or "I've followed your work."
- Should feel like a smart peer reaching out, not a cold pitch.`;

const EMAIL_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    subject: {
      type: SchemaType.STRING,
      description: "Email subject line, 4-7 words, concrete with a number, portfolio name, or outcome.",
    },
    body: {
      type: SchemaType.STRING,
      description:
        "Plain-text email body, 80-120 words. Greeting on its own line, paragraphs separated by blank lines (\\n\\n), sign-off on its own line. Must contain newline characters.",
    },
    linkedin_note: {
      type: SchemaType.STRING,
      description:
        "LinkedIn connection request note. Strict 280-character max. No greeting. Portfolio reference hook if available, then what PluginAny does, team signal, CTA, sender name.",
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function generateEmail(model, profile, candidate) {
  const portfolioLine = candidate.portfolioReference
    ? `Portfolio company they personally backed (USE THIS IN THE HOOK): ${candidate.portfolioReference}`
    : "No portfolio reference found — open with the traction signal: 350k organic followers before a single ad.";

  const thesisLine = candidate.investmentThesis
    ? `Their investment thesis (use to calibrate angle): ${candidate.investmentThesis}`
    : "";

  const orgType = candidate.role
    ? (/(accelerator|program|director|manager)/i.test(candidate.role) ? "Accelerator" : "VC/Angel")
    : "VC/Angel";

  const userMessage = `COMPANY PROFILE:
${profile}

RECIPIENT:
Name: ${candidate.partnerName || "Partner"}
Role: ${candidate.role || "Partner"} at ${candidate.organization}
${portfolioLine}
${thesisLine}
Org type for ask: ${orgType}

Write the email now. Follow the structure and quality bar exactly. The hook must draw a SPECIFIC analogy between their portfolio company and PluginAny — not just name-drop it, but explain WHY the thesis is the same.`;

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
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
      if (email.linkedin_note.length > 300) email.linkedin_note = email.linkedin_note.slice(0, 297) + "...";

      return email;
    } catch (err) {
      lastErr = err;
      if (attempt === 4) break;
      const waitMs = isTransientLlmError(err) ? attempt * 10000 : 2000;
      console.log(`  Gemini attempt ${attempt}/4 failed (${err.message}) — retrying in ${Math.round(waitMs / 1000)}s...`);
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
    if (day === 0 || day === 6) { console.log("Weekend — skipping."); return; }
  }

  const profile = loadProfile();
  const ledger = loadLedger();

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const sheets = createSheetsClient(oauth2);

  const peopleTab = "People";
  const candidates = await loadPeopleCandidates(sheets, config.sourceSpreadsheetId, peopleTab);

  const contactedEmails = new Set(ledger.map((e) => e.email.toLowerCase()));
  const skip = new Set((config.skipAddresses || []).map((a) => a.toLowerCase()));

  const batch = candidates
    .filter((c) => c.email && c.email.includes("@"))
    .filter((c) => c.status.toLowerCase() === "to contact")
    .filter((c) => !contactedEmails.has(c.email.toLowerCase()))
    .filter((c) => !skip.has(c.email.toLowerCase()))
    .slice(0, config.dailyCap || 10);

  console.log(`Mode: ${DRY_RUN ? "DRY RUN (nothing will be sent)" : "LIVE — emails WILL be sent"}`);
  console.log(`Ready to contact: ${batch.length} people (cap ${config.dailyCap})\n`);

  if (!batch.length) {
    console.log("Nothing to send — run: npm run investor:people");
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
    const displayName = candidate.partnerName || "Partner";
    console.log(`→ ${displayName} <${candidate.email}> @ ${candidate.organization}`);
    if (candidate.portfolioReference) console.log(`  backed: ${candidate.portfolioReference}`);

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
      console.log(`\n  LinkedIn note (${email.linkedin_note.length} chars):\n  "${email.linkedin_note}"`);
    }

    if (DRY_RUN) {
      console.log("  (dry run — not sent)\n");
      sent++;
      continue;
    }

    try {
      const toHeader = candidate.partnerName
        ? `"${candidate.partnerName}" <${candidate.email}>`
        : candidate.email;

      const raw = buildRawMessage({ to: toHeader, from: myEmail, subject: email.subject, body: email.body });
      const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      await gmail.users.messages.modify({
        userId: "me",
        id: res.data.id,
        requestBody: { addLabelIds: [labelId] },
      });

      ledger.push({
        partnerName: candidate.partnerName,
        email: candidate.email,
        organization: candidate.organization,
        role: candidate.role,
        portfolioReference: candidate.portfolioReference,
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
          await markPersonSent(sheets, config.sourceSpreadsheetId, peopleTab, candidate._sheetRow);
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
  console.log(`${DRY_RUN ? "Would have sent" : "Sent"}: ${sent} | failed: ${failed} | total in ledger: ${ledger.length}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

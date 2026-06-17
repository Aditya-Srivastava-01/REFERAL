/**
 * outreach.js — daily first-contact sender.
 *
 * Takes the next N un-contacted professors from the Candidates Google Sheet
 * (or candidates.csv — see candidateSource in outreach-config.json), pulls
 * their most recent papers from OpenAlex, has Gemini write a short
 * personalized email grounded in profile.md, sends it from your Gmail with
 * your CV attached, applies the "outreach" label (so professor-followup
 * chases non-repliers), and records everything in outreach-ledger.json so
 * nobody is ever emailed twice.
 *
 * Secrets (env vars): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 * GMAIL_REFRESH_TOKEN, GEMINI_API_KEY, YOUR_NAME.
 * Settings: outreach-config.json. DRY_RUN env var overrides config.dryRun.
 */

require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const Groq = require("groq-sdk");
const { parseCsv } = require("./lib/csv");
const { fetchJson, sleep, normalizeAscii } = require("./lib/web");
const {
  createSheetsClient,
  loadSheetCandidates,
  markCandidateSent,
} = require("./lib/google-sheets");

const ROOT = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "outreach-config.json"), "utf8"));

// Load resume PDF for attachment (optional — set resumePath in outreach-config.json)
let resumeAttachment = null;
if (config.resumePath) {
  const rp = path.resolve(ROOT, config.resumePath);
  if (!fs.existsSync(rp)) {
    console.error(`resumePath in config points to a missing file: ${rp}`);
    process.exit(1);
  }
  resumeAttachment = { data: fs.readFileSync(rp), filename: path.basename(rp) };
}

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const YOUR_NAME = process.env.YOUR_NAME || "";

const DRY_RUN =
  process.env.DRY_RUN != null && process.env.DRY_RUN !== ""
    ? /^(1|true|yes)$/i.test(process.env.DRY_RUN)
    : config.dryRun !== false;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error("Missing Gmail credentials (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN).");
  process.exit(1);
}
if (!process.env.GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY. Get a free key at https://console.groq.com");
  process.exit(1);
}
if (!YOUR_NAME) {
  console.error("Missing YOUR_NAME (used to sign the emails).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function loadProfile() {
  const p = path.join(ROOT, "profile.md");
  if (!fs.existsSync(p)) {
    console.error("profile.md not found. Create it (see README) — it is the source of truth about you.");
    process.exit(1);
  }
  const text = fs.readFileSync(p, "utf8");
  if (/FILL ME/.test(text)) {
    console.error("profile.md still contains 'FILL ME' placeholders. Fill every section before sending.");
    process.exit(1);
  }
  return text;
}

function loadCsvCandidates() {
  const p = path.join(ROOT, "candidates.csv");
  if (!fs.existsSync(p)) {
    console.error("candidates.csv not found. Run `npm run discover` first.");
    process.exit(1);
  }
  return parseCsv(fs.readFileSync(p, "utf8")).records;
}

const LEDGER_PATH = path.join(ROOT, "outreach-ledger.json");
function loadLedger() {
  return fs.existsSync(LEDGER_PATH) ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) : [];
}
function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// OpenAlex: recent papers for a professor (free API, no key)
// ---------------------------------------------------------------------------

const INST_STOPWORDS = new Set([
  "university", "institute", "college", "school", "of", "the", "and", "for",
  "technology", "national", "state", "research", "center", "centre", "at",
]);

function significantTokens(s) {
  return normalizeAscii(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !INST_STOPWORDS.has(t));
}

// OpenAlex "field" id 17 = Computer Science. Filtering works to this field
// drops papers wrongly merged into a profile by name-collision (e.g. a
// different "J. Smith" in economics), which would otherwise make Claude cite
// an irrelevant paper.
const CS_FIELD_FILTER = "primary_topic.field.id:fields/17";

function strippedName(name) {
  // CSRankings disambiguates with a trailing number ("Yi Yang 0001").
  return name.replace(/\s+\d{4}$/, "").trim();
}

async function fetchRecentPapers(candidate, mailto) {
  const sinceYear = new Date().getFullYear() - 2;
  const search = await fetchJson(
    `https://api.openalex.org/authors?search=${encodeURIComponent(strippedName(candidate.name))}` +
      `&per-page=15&mailto=${encodeURIComponent(mailto)}`
  );

  const affTokens = new Set(significantTokens(candidate.affiliation));
  // Among authors at the right institution, prefer the most-cited — the real
  // professor dwarfs any same-named author in citations.
  const matches = (search.results || []).filter((r) => {
    const insts = [
      ...(r.last_known_institutions || []),
      ...((r.affiliations || []).map((a) => a.institution).filter(Boolean)),
    ];
    return insts.some((inst) =>
      significantTokens(inst.display_name || "").some((t) => affTokens.has(t))
    );
  });
  matches.sort((a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0));
  const author = matches[0];
  if (!author) return [];

  const authorId = author.id.split("/").pop();
  const works = await fetchJson(
    `https://api.openalex.org/works?filter=authorships.author.id:${authorId},` +
      `from_publication_date:${sinceYear}-01-01,${CS_FIELD_FILTER}&sort=publication_date:desc&per-page=8` +
      `&select=title,publication_year,abstract_inverted_index&mailto=${encodeURIComponent(mailto)}`
  );

  const seen = new Set();
  const papers = [];
  for (const w of works.results || []) {
    if (!w.title) continue;
    const key = w.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue; // OpenAlex sometimes lists a paper twice
    seen.add(key);
    papers.push({
      title: w.title,
      year: w.publication_year,
      abstract: reconstructAbstract(w.abstract_inverted_index).slice(0, 900),
    });
    if (papers.length >= 4) break;
  }
  return papers;
}

function reconstructAbstract(inverted) {
  if (!inverted) return "";
  const words = [];
  for (const [word, positions] of Object.entries(inverted)) {
    for (const p of positions) words[p] = word;
  }
  return words.join(" ");
}

// ---------------------------------------------------------------------------
// Claude: write the email
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You write cold outreach emails from a student to an AI/ML professor. Goal: make the professor think "this student engaged with my actual research problem — worth replying."

━━━ PROFESSOR'S 5-SECOND SCAN ━━━
1. Subject — does it reference my specific paper or finding, not a generic "inquiry"?
2. First real sentence — did this person engage with what my work ACTUALLY ARGUES, not just what it's "about"?
3. One credential that separates this from 50 other emails today.
Fail any one → delete.

━━━ STRUCTURE ━━━

GREETING: "Dear Professor [LastName],"

P1 — IDENTITY (1 sentence only):
"I am [Name], a second-year B.Tech [field] student at [university] — top 0.4% JEE Main, 1 in 1.2 million candidates."

P2 — HOOK + BRIDGE (2 sentences — the most important paragraph):
Sentence 1 — THE FINDING: What the paper SHOWED, PROVED, or DEMONSTRATED. Not what it's "about." Use their terminology. Cite a specific finding, method, or result.
  ✓ "Your 2024 paper showed that spectral-spatial masked pretraining achieves competitive land-cover accuracy with as few as 50 labeled samples — far fewer than supervised baselines."
  ✗ "I read your paper on hyperspectral representation learning and found it very interesting."
Sentence 2 — THE BRIDGE: Show you hit the SAME intellectual problem. Mirror their vocabulary. One quantified result from the student's own work.
  ✓ "Building a hyperspectral MAE on AVIRIS cubes myself, I saw the same sample-efficiency effect — downstream separability improved 20% with few labels — but couldn't explain why the transfer held, which is exactly what your work addresses."
  ✗ "This connects to my experience in computer vision."

DOMAIN PIVOT — pick whichever student project shares the most technical vocabulary with the professor's paper:
  Vision / remote sensing / spectral / self-supervised / foundation models → Hyperspectral MAE: masked autoencoder on AVIRIS cubes, 20% land-cover separability lift, 25% pre-training latency reduction
  Security / OOD / anomaly detection / systems → Android malware: CIC-AndMal2017, 1,418-dim APK feature space via Apktool, 90.8% malicious recall, 20+ models benchmarked
  NLP / LLM / RAG / agents / multimodal → RAG pipeline at ArchiGen AI: 30% accuracy improvement, 25% training convergence speedup
  Robotics / mobility / graph / routing / optimization → PluginAny EV routing: live multi-network charging aggregation and route planning
  General ML / broad → closest vocabulary match from above + JEE signal as problem-solving proof

P3 — ASK (1 sentence):
"I was wondering whether there might be an opportunity to contribute to your ongoing research" — add "on [specific thread from their latest paper]" only if it fits naturally.
NEVER: "internship," "position," "paid/unpaid," "available immediately," desperation.

P4 — CLOSE (1 sentence):
"My CV is attached, and further work is at https://github.com/Aditya-Srivastava-01"

SIGN-OFF: "Best,\n[Name]"

━━━ SUBJECT LINE ━━━

Frame as genuine intellectual curiosity, not a job application. Three proven formulas:
  A) "Question about your [year] paper on [specific topic or finding]"
  B) "[Your concrete result] — connects to your work on [their specific area]"
  C) "[Their specific technique] + [your result]"
Examples:
  ✓ "Question about your 2024 masked pretraining on hyperspectral data"
  ✓ "90.8% malicious recall — connects to your OOD detection work"
  ✓ "Spectral-spatial transfer + 20% separability lift — research question"
  ✗ "Research Inquiry" / "Collaboration Opportunity" / "Contribution Opportunity"
5–8 words. Name the paper topic or your specific result — never a generic label.

━━━ HARD RULES ━━━

FORBIDDEN (any = failure):
  "passionate / excited / thrilled / honored / humbled"
  "I hope this email finds you well"
  "esteemed / renowned / prestigious / groundbreaking / impressive"
  "I came across your work / profile / research"
  "Your research aligns with my interests" — replace with the specific bridge
  "internship / position / paid or unpaid / available immediately"
  CGPA — dilutes the JEE signal; never mention
  Invented paper titles — use only titles from the provided list
  Invented metrics or qualifications

Content:
  Use ONLY facts from the STUDENT PROFILE. Never invent.
  If no papers provided: name their research subfield with a precise technical term, not just "your work."
  If no clean bridge: use the closest vocabulary match from the profile.
  Body: 80–110 words. Every sentence earns its place; professors parse in under 90 seconds.
  Plain text only — no markdown, no bullets, no links except GitHub in P4.
  \\n\\n between every paragraph. Greeting on own line. Never a wall of text.
  Tone: confident, intellectually curious, peer-to-peer — not an applicant filling out a form.

━━━ LINKEDIN NOTE ━━━

Strict 280-character limit — count every character including spaces.
No greeting (LinkedIn auto-adds "Hi [Name],").
Structure: "Emailed you re: your [specific paper/finding]. [1-sentence result bridge.] Top 0.4% JEE Main (1.2M candidates). — Aditya"
No sycophancy. Under 280 chars total.
Example: "Emailed you about your masked pretraining paper. Built a hyperspectral MAE — 20% separability lift on AVIRIS, same sample-efficiency effect you showed. Top 0.4% JEE (1.2M). — Aditya"`;



function buildGroqClient() {
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

function isTransientLlmError(err) {
  const msg = String((err && err.message) || err);
  return /\b(429|500|503)\b|overloaded|high demand|temporarily|resource exhausted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

const LLM_ATTEMPTS = 4;

async function generateEmail(model, profile, candidate, papers) {
  const paperBlock = papers.length
    ? papers
        .map((p, i) => `${i + 1}. "${p.title}" (${p.year})${p.abstract ? `\n   Abstract: ${p.abstract}` : ""}`)
        .join("\n")
    : "(none found — refer to their research area in general terms)";

  const userMessage = `STUDENT PROFILE (the sender — sign as "${YOUR_NAME}"):
${profile}

PROFESSOR (the recipient):
Name: ${candidate.name}
Institution: ${candidate.affiliation}
Recent papers:
${paperBlock}

Write the outreach email now.`;

  let lastErr;
  for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt++) {
    try {
      const completion = await model.chat.completions.create({
        model: "llama-3.1-8b-instant",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage + "\n\nRespond with JSON: {\"subject\": \"...\", \"body\": \"...\", \"linkedin_note\": \"...\"}" },
        ],
        temperature: 0.7,
      });
      const text = completion.choices[0].message.content;
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
      if (attempt === LLM_ATTEMPTS) break;
      const waitMs = isTransientLlmError(err) ? attempt * 10000 : 2000;
      console.log(
        `  Groq attempt ${attempt}/${LLM_ATTEMPTS} failed (${err.message}) — retrying in ${Math.round(waitMs / 1000)}s...`
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

function buildRawMessage({ to, from, subject, body, attachment }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;

  if (!attachment) {
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

  // Multipart/mixed: plain-text body + PDF attachment
  const boundary = "----OutreachBot_" + Math.random().toString(36).slice(2, 14);
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    "",
    attachment.data.toString("base64"),
    "",
    `--${boundary}--`,
  ];
  return Buffer.from(parts.join("\r\n"))
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
      console.log("Weekend — skipping (weekdaysOnly is on). Professors read email on weekdays.");
      return;
    }
  }

  const profile = loadProfile();
  const ledger = loadLedger();

  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const sheets = createSheetsClient(oauth2);
  const candidates =
    config.candidateSource === "googleSheets"
      ? await loadSheetCandidates(sheets, config.spreadsheetId, config.sheetName)
      : loadCsvCandidates();

  const contactedEmails = new Set(ledger.map((e) => e.email.toLowerCase()));
  const contactedPeople = new Set(ledger.map((e) => `${e.name}|${e.affiliation}`));
  const skip = new Set((config.skipAddresses || []).map((a) => a.toLowerCase()));

  const batch = candidates
    .filter((c) => c.email && c.email.includes("@"))
    .filter(
      (c) =>
        config.candidateSource !== "googleSheets" ||
        c.status.trim().toLowerCase() === "to contact"
    )
    .filter((c) => !contactedEmails.has(c.email.toLowerCase()))
    .filter((c) => !contactedPeople.has(`${c.name}|${c.affiliation}`))
    .filter((c) => !skip.has(c.email.toLowerCase()))
    .slice(0, config.dailyCap || 5);

  console.log(`Mode: ${DRY_RUN ? "DRY RUN (nothing will be sent)" : "LIVE (emails WILL be sent)"}`);
  console.log(`Already contacted: ${ledger.length} | today's batch: ${batch.length} (cap ${config.dailyCap || 5})\n`);

  if (batch.length === 0) {
    console.log("Nothing to send — every candidate with an email has been contacted. Run `npm run discover` for more.");
    return;
  }

  const profileRes = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profileRes.data.emailAddress.toLowerCase();
  console.log(`Signed in as ${myEmail}\n`);

  const llm = buildGroqClient();
  const labelId = DRY_RUN ? null : await ensureLabel(gmail, config.gmailLabel || "outreach");

  let sent = 0;
  let failed = 0;

  for (const candidate of batch) {
    console.log(`→ ${candidate.name} <${candidate.email}> (${candidate.affiliation})`);

    let papers = [];
    try {
      papers = await fetchRecentPapers(candidate, myEmail);
      console.log(`  papers found: ${papers.length}${papers[0] ? ` (latest: "${papers[0].title.slice(0, 70)}")` : ""}`);
    } catch (err) {
      console.log(`  OpenAlex lookup failed (${err.message}) — writing without paper references.`);
    }

    let email;
    try {
      email = await generateEmail(llm, profile, candidate, papers);
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
        to: `"${candidate.name}" <${candidate.email}>`,
        from: myEmail,
        subject: email.subject,
        body: email.body,
        attachment: resumeAttachment,
      });
      const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      await gmail.users.messages.modify({
        userId: "me",
        id: res.data.id,
        requestBody: { addLabelIds: [labelId] },
      });

      ledger.push({
        name: candidate.name,
        affiliation: candidate.affiliation,
        email: candidate.email,
        subject: email.subject,
        body: email.body,
        papersReferenced: papers.map((p) => p.title),
        linkedinNote: email.linkedin_note || "",
        sentAt: new Date().toISOString(),
        messageId: res.data.id,
        threadId: res.data.threadId,
      });
      saveLedger(ledger); // save after every send — crash-safe
      if (config.candidateSource === "googleSheets" && candidate._sheetRow) {
        try {
          await markCandidateSent(
            sheets,
            config.spreadsheetId,
            config.sheetName,
            candidate._sheetRow,
            7
          );
        } catch (sheetError) {
          console.log(`  Warning: email sent, but sheet update failed: ${sheetError.message}`);
        }
      }
      sent++;
      console.log("  ✓ sent and labeled\n");
    } catch (err) {
      console.log(`  ✗ send failed: ${err.message}\n`);
      failed++;
      continue;
    }

    // Space the sends out — bursts look like spam to mail filters.
    const delay = (config.delaySecondsBetweenEmails || 45) * 1000 * (0.8 + Math.random() * 0.6);
    await sleep(delay);
  }

  console.log("--- Summary ---");
  console.log(`${DRY_RUN ? "Would send" : "Sent"}: ${sent} | failed: ${failed} | total contacted ever: ${ledger.length}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

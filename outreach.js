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

const SYSTEM_PROMPT = `You write cold research outreach emails from Aditya Srivastava to top AI/ML professors at Oxford, MIT, Stanford, UCL, ETH, and similar institutions.

THE CORE FEELING THIS EMAIL MUST CREATE:
"I found your work because I was already thinking about this problem."
NOT: "I found your work and now want an internship."

━━━ IDENTITY ━━━
Sender: Aditya Srivastava, second-year B.Tech IT, Delhi Technological University
Credential: 99.59 percentile JEE Main — top 0.4% of 1.2 million candidates nationally

━━━ STRUCTURE ━━━

GREETING: "Dear Professor [LastName],"
ALWAYS include "Professor" — never just "Dear [FullName]" or "Dear [FirstName]".

P1 — IDENTITY (1 sentence):
"I am Aditya Srivastava, a second-year B.Tech IT student at DTU — 99.59 percentile JEE Main, top 0.4% of 1.2 million candidates."

P2 — PAPER + INTELLECTUAL PROBLEM (3–4 sentences, the core of the email):
CRITICAL: The "Recent papers:" block in the user message lists the ONLY papers you may reference. If the list is non-empty, choose ONE paper from that exact list. You MUST use a title and year drawn verbatim from the list. If you cite a paper title or year that is not in the list, that is a fabrication failure — worse than any other error.

Open with the paper's FINDING, not with "I". Lead with what the paper showed or proved.
  ✓ "Your 2025 paper on low-rank rank selection showed that language model compression can be made differentiable without accuracy loss."
  ✓ "Your work on [topic from the list] demonstrated that [specific finding from that paper]."
  ✗ NEVER open with: "I came across your paper" / "I recently found" / "I stumbled upon" / "I discovered your work"
  ✗ NEVER cite a paper title, year, or finding that is not in the provided list.

Then connect to ONE project and show the struggle: what confused Aditya, what he couldn't explain, what hit a wall. The confusion IS the bridge.
One quantified result from the student's work anchors credibility.

IF "Recent papers:" SAYS "(none found …)": Do NOT invent a paper title. Instead open with what you know about the professor's research area: "Your work on [specific technical subfield] — [one thing that subfield has established or is working on] — connects to something I ran into while building [project]." Never fabricate a title, year, or specific finding.

P3 — CONTRIBUTION SIGNAL (1–2 sentences):
Concrete availability + commitment. By the time the professor reads this, they already believe the technical depth — availability now feels like a natural next step, not a request.
  ✓ "I'm actively looking to spend the coming winter break working deeply on problems like this, and can contribute remotely before that if useful."
  ✓ "I'm trying to put my next few months into research problems in this direction, whether remotely now or more intensively over winter."
  ✓ "I'm looking for a serious research environment to contribute in over winter, and would be glad to start remotely if there's fit."
  ✗ "I am seeking an internship." / "I would love to join your lab." / "Please consider me."
Vary the phrasing — never use the same sentence twice. Always mention: remotely during semester + full-time over winter break.

P4 — SOFT ASK (1 sentence):
  ✓ "If this problem space is active in your group, I'd value the chance to contribute and learn."
  ✓ "If there's alignment, I'd be glad to contribute — especially over the winter break."
NEVER: "Can I get an internship?" / "Please accept me" / "I was wondering whether there might be an opportunity"

P5 — CLOSE (1 sentence):
"My CV is attached, and my code is here: https://github.com/Aditya-Srivastava-01"

SIGN-OFF: "Best,\nAditya"

━━━ DOMAIN PIVOT (pick exactly ONE project — never mention more than one) ━━━

Vision / remote sensing / spectral / self-supervised / foundation models:
→ Hyperspectral MAE on AVIRIS cubes. Struggle: downstream separability improved 20% and pre-training latency dropped 25%, but couldn't explain WHY the spectral-spatial representations transferred robustly to downstream tasks with so few labeled samples — whether it was the masking strategy, the spectral tokenization, or something about the pretraining objective.

Security / OOD / anomaly detection / systems:
→ Android malware detection on CIC-AndMal2017. Reverse-engineered APKs via Apktool into 1,418 sparse features. Struggle: benchmarked 20+ models, reached 90.8% malicious recall — but the remaining failure cases clustered in a way that looked like a distributional shift problem rather than a model capacity problem, and standard calibration didn't resolve it.

NLP / LLM / RAG / agents / multimodal:
→ RAG pipeline at ArchiGen AI, 30% accuracy improvement. Struggle: accuracy gains plateaued past a certain retrieval threshold — improving retrieval quality further stopped helping generation quality, as if the bottleneck had shifted to how retrieval and generation objectives were coupled, not retrieval itself.

Robotics / mobility / graph / routing / optimization:
→ PluginAny EV routing system — live multi-network charging aggregation and route planning. Struggle: standard shortest-path approaches broke under partial observability of charger availability; real-time state changes turned a static graph problem into something closer to a POMDP.

General ML / broad → use the closest vocabulary match above. Never mention more than one project.

━━━ SUBJECT LINE ━━━

Sound like a genuine intellectual question, not a job application.
  ✓ "Question about your 2024 paper on spectral-spatial masked pretraining"
  ✓ "Your finding on transfer efficiency — something I ran into"
  ✓ "Distributional shift in sparse feature spaces — your OOD work"
  ✗ "Research Inquiry" / "Collaboration Opportunity" / "Contribution Opportunity"
5–8 words. Name the paper, the finding, or the problem — never a generic label.

━━━ INTELLECTUAL CURIOSITY RULE ━━━
Prioritize: what confused Aditya, what he struggled with, what he's trying to understand.
De-emphasize: listing achievements.
A professor is drawn in by a mind already wrestling with their problem — not a résumé.

━━━ FORBIDDEN (any = failure) ━━━
"passionate / excited / thrilled / honored / humbled / deeply admire"
"I hope this email finds you well"
"groundbreaking / impressive / esteemed / renowned / prestigious"
"I came across your work / research / profile"
"Your research aligns with my interests"
"Can I get an internship" / "Please accept me" / "I would like to apply"
"unpaid is fine / available immediately"
CGPA — never mention
More than one project — pick exactly one
Any paper title, year, or finding NOT listed in the "Recent papers:" block — this is the worst possible failure. The professor will know immediately if you invent a paper they didn't write.

━━━ CONTENT RULES ━━━
Facts: ONLY from the student profile. Never invent.
If no papers: use precise technical vocabulary from their known research subfield.
Length: 140–200 words. No padding. Every sentence earns its place.
Plain text only. No markdown, no bullets, no links except GitHub in P5.
\\n\\n between every paragraph. Greeting on own line.
Tone: curious, sharp, early-stage researcher, high-agency, technically serious. Never AI-sounding.

━━━ LINKEDIN NOTE ━━━
280-character hard limit — count every character.
No greeting. No sycophancy.
Structure: "Emailed you re: [paper/finding]. [1-sentence struggle + bridge.] Top 0.4% JEE Main (1.2M). — Aditya"
Under 280 chars total.`;



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

  const paperWarning = papers.length
    ? `⚠️ ONLY THESE ${papers.length} PAPER(S) MAY BE CITED. Any other title or year = fabrication failure:\n`
    : "";

  const userMessage = `STUDENT PROFILE (the sender — sign as "${YOUR_NAME}"):
${profile}

PROFESSOR (the recipient):
Name: ${candidate.name}
Institution: ${candidate.affiliation}
Recent papers:
${paperWarning}${paperBlock}

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
      const wordCount = email.body.split(/\s+/).filter(Boolean).length;
      if (wordCount > 230) throw new Error(`body too long (${wordCount} words, max 200) — retry`);
      if (email.linkedin_note.length > 300) email.linkedin_note = email.linkedin_note.slice(0, 297) + "...";

      // Fabrication guard: if papers were provided, any year cited in "Your YYYY paper"
      // must exist in the list. Catches the most common hallucination pattern.
      if (papers.length > 0) {
        const providedYears = new Set(papers.map((p) => String(p.year)));
        const yearMatch = email.body.match(/\b(20\d{2})\s+paper\b/i);
        if (yearMatch && !providedYears.has(yearMatch[1])) {
          throw new Error(
            `FABRICATION: cited year ${yearMatch[1]} not in provided papers ` +
            `(available: ${[...providedYears].join(", ")}) — use only the listed papers`
          );
        }
      }

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

  // Google OAuth token refresh can fail with "Premature close" on transient
  // network drops from GitHub Actions. Retry up to 4 times before giving up.
  let candidates;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      candidates = config.candidateSource === "googleSheets"
        ? await loadSheetCandidates(sheets, config.spreadsheetId, config.sheetName)
        : loadCsvCandidates();
      break;
    } catch (err) {
      const isNetwork = /premature close|network|ECONNRESET|ETIMEDOUT|fetch failed|ENOTFOUND/i.test(err.message);
      if (!isNetwork || attempt === 4) throw err;
      const wait = attempt * 8000;
      console.log(`  Google Sheets auth failed (${err.message}) — retry ${attempt}/4 in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

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

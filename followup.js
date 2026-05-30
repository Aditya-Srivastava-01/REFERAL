/**
 * professor-followup
 *
 * Scans your Gmail Sent mail, finds threads where a professor has NOT replied,
 * and sends a polite follow-up (as a reply in the same thread) after a configurable
 * waiting period. State is tracked implicitly via the thread itself — no database.
 *
 * Secrets come from env vars: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 * Settings come from config.json. DRY_RUN env var overrides config.dryRun.
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ---------------------------------------------------------------------------
// Config & secrets
// ---------------------------------------------------------------------------

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf8")
);

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const YOUR_NAME = process.env.YOUR_NAME || "";

const DRY_RUN =
  process.env.DRY_RUN != null
    ? /^(1|true|yes)$/i.test(process.env.DRY_RUN)
    : config.dryRun !== false;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error(
    "Missing Gmail credentials. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and " +
      "GMAIL_REFRESH_TOKEN (run `npm run token` once to obtain the refresh token)."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeader(headers, name) {
  const h = (headers || []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : "";
}

/** Parse a "Display Name <email@host>" header into { name, email }. */
function parseAddress(value) {
  if (!value) return { name: "", email: "" };
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: "", email: value.trim().toLowerCase() };
}

function firstNonMeRecipient(toValue, myEmail) {
  // "To" can contain several comma-separated addresses.
  const parts = toValue.split(",");
  for (const p of parts) {
    const a = parseAddress(p);
    if (a.email && a.email !== myEmail) return a;
  }
  return { name: "", email: "" };
}

function domainAllowed(email) {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();

  if (config.skipDomains && config.skipDomains.includes(domain)) return false;
  if (config.skipAddresses && config.skipAddresses.includes(email)) return false;

  const allow = config.allowedDomains || [];
  if (allow.length === 0) return true; // empty = allow all (after skip filters)
  return allow.some((frag) => domain.includes(frag.toLowerCase()));
}

/** Build a greeting like "Professor Smith" from a display name, else a fallback. */
function buildGreeting(displayName) {
  if (!displayName) return "Professor";
  // Strip common titles, keep the last word as surname.
  const cleaned = displayName.replace(/\b(dr|prof|professor|mr|ms|mrs)\.?\b/gi, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Professor";
  return `Professor ${parts[parts.length - 1]}`;
}

function stripRe(subject) {
  return (subject || "").replace(/^(\s*re:\s*)+/i, "").trim();
}

/** Apply subjectMustInclude / subjectMustExclude keyword rules. */
function subjectQualifies(subject) {
  const s = (subject || "").toLowerCase();
  const include = config.subjectMustInclude || [];
  const exclude = config.subjectMustExclude || [];
  if (exclude.some((w) => s.includes(w.toLowerCase()))) return false;
  if (include.length > 0 && !include.some((w) => s.includes(w.toLowerCase()))) return false;
  return true;
}

function renderTemplate(displayName) {
  const tpl = fs.readFileSync(path.join(__dirname, "template.txt"), "utf8");
  return tpl
    .replace(/\{\{greeting\}\}/g, buildGreeting(displayName))
    .replace(/\{\{display_name\}\}/g, displayName || "Professor")
    .replace(/\{\{your_name\}\}/g, YOUR_NAME || "");
}

/** RFC 2822 message -> base64url for the Gmail API raw field. */
function buildRawMessage({ to, from, subject, inReplyTo, references, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("", body);

  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const myEmail = profile.data.emailAddress.toLowerCase();

  console.log(`Signed in as ${myEmail}`);
  console.log(
    `Mode: ${DRY_RUN ? "DRY RUN (no emails will be sent)" : "LIVE (emails WILL be sent)"}`
  );
  console.log(
    `Settings: wait>=${config.followupIntervalDays}d, maxFollowups=${config.maxFollowups}, lookback=${config.lookbackDays}d\n`
  );

  // 1) Collect candidate thread IDs.
  // Without a label we scan Sent mail directly. With a label we search by label
  // only (NOT "in:sent"), because the label may sit on a different message in the
  // thread (e.g. a self-BCC copy in the inbox); the per-thread checks below still
  // require that you initiated the thread and that nobody has replied.
  let q;
  if (config.gmailLabel) {
    q = `label:${JSON.stringify(config.gmailLabel)} newer_than:${config.lookbackDays}d`;
    console.log(`Restricting to threads labelled "${config.gmailLabel}".`);
  } else {
    q = `in:sent newer_than:${config.lookbackDays}d`;
  }
  const threadIds = new Set();
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 500,
      pageToken,
    });
    (res.data.messages || []).forEach((m) => threadIds.add(m.threadId));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`Found ${threadIds.size} sent thread(s) in the last ${config.lookbackDays} days.\n`);

  const summary = { sent: 0, replied: 0, waiting: 0, capped: 0, filtered: 0, subjectFiltered: 0, notMine: 0 };

  for (const threadId of threadIds) {
    const thr = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From", "To", "Subject", "Message-ID", "Date"],
    });

    const messages = thr.data.messages || [];
    if (messages.length === 0) continue;

    // Chronological order (Gmail returns oldest-first, but be safe).
    messages.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));

    const firstFrom = parseAddress(getHeader(messages[0].payload.headers, "From"));
    const initiatedByMe = firstFrom.email === myEmail;

    if (config.onlyThreadsIInitiated && !initiatedByMe) {
      summary.notMine++;
      continue;
    }

    // Did the professor ever reply? (any message NOT from me)
    const repliedByThem = messages.some(
      (m) => parseAddress(getHeader(m.payload.headers, "From")).email !== myEmail
    );
    if (repliedByThem) {
      summary.replied++;
      continue;
    }

    // Recipient = first non-me address on the first message I sent.
    const myFirst = messages.find(
      (m) => parseAddress(getHeader(m.payload.headers, "From")).email === myEmail
    ) || messages[0];
    const recipient = firstNonMeRecipient(getHeader(myFirst.payload.headers, "To"), myEmail);

    if (!recipient.email) continue;

    if (!domainAllowed(recipient.email)) {
      summary.filtered++;
      continue;
    }

    const origSubject = stripRe(getHeader(myFirst.payload.headers, "Subject"));
    if (!subjectQualifies(origSubject)) {
      summary.subjectFiltered++;
      continue;
    }

    // Count only messages that actually went OUT (carry the SENT label). This
    // ignores any self-BCC copies that land in the inbox (used by the auto-label
    // trick), so the follow-up counter and timing stay accurate.
    const myMessages = messages.filter(
      (m) =>
        parseAddress(getHeader(m.payload.headers, "From")).email === myEmail &&
        (m.labelIds || []).includes("SENT")
    );
    if (myMessages.length === 0) continue;

    const followupsAlreadySent = myMessages.length - 1; // original is not a follow-up
    if (followupsAlreadySent >= config.maxFollowups) {
      summary.capped++;
      continue;
    }

    const lastMine = myMessages[myMessages.length - 1];
    const daysSinceLast = (Date.now() - Number(lastMine.internalDate)) / DAY_MS;
    if (daysSinceLast < config.followupIntervalDays) {
      summary.waiting++;
      continue;
    }

    // --- This thread qualifies for a follow-up. ---
    const subject = config.subjectPrefix + origSubject;
    const lastMsgId = getHeader(lastMine.payload.headers, "Message-ID");
    const references = messages
      .map((m) => getHeader(m.payload.headers, "Message-ID"))
      .filter(Boolean)
      .join(" ");
    const body = renderTemplate(recipient.name);

    console.log(
      `→ ${recipient.email}  | "${stripRe(subject)}"  | ${Math.floor(daysSinceLast)}d since last, follow-up #${followupsAlreadySent + 1}`
    );

    if (DRY_RUN) {
      summary.sent++;
      continue;
    }

    const raw = buildRawMessage({
      to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
      from: myEmail,
      subject,
      inReplyTo: lastMsgId,
      references,
      body,
    });

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId },
    });
    summary.sent++;
  }

  console.log("\n--- Summary ---");
  console.log(`${DRY_RUN ? "Would send" : "Sent"}:        ${summary.sent}`);
  console.log(`Already replied:  ${summary.replied}`);
  console.log(`Still waiting:    ${summary.waiting}  (< ${config.followupIntervalDays} days)`);
  console.log(`Max follow-ups:   ${summary.capped}`);
  console.log(`Domain filtered:  ${summary.filtered}`);
  console.log(`Subject filtered: ${summary.subjectFiltered}`);
  console.log(`Not initiated:    ${summary.notMine}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

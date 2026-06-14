/**
 * discover-investor-contacts.js — reads the raw investors sheet, finds a
 * contact email for each org via DuckDuckGo + website crawl, then writes
 * enriched rows into the "Outreach" tab ready for investor-outreach.js.
 *
 * Run locally:  node discover-investor-contacts.js
 *
 * Strategy per org:
 *  1. DuckDuckGo Instant Answer API → extract website URL from response.
 *  2. Crawl that website's /contact /about /team /apply pages for emails.
 *  3. Fallback: guess domain from org name, verify with HEAD request, crawl.
 *  4. Ranks emails: apply@ > hello@ > contact@ > info@ > other.
 *  5. Writes to "Outreach" tab. Already-present rows are skipped.
 *     Rows with no email found get Status "Needs Email".
 */

require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { createSheetsClient } = require("./lib/google-sheets");

const ROOT = __dirname;
const config = JSON.parse(
  fs.readFileSync(path.join(ROOT, "investor-outreach-config.json"), "utf8")
);

const OUTREACH_HEADERS = [
  "Name", "Email", "Website", "Description", "Location", "Type",
  "Status", "Follow-up Date", "Next Steps", "Crunchbase URL",
];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function headOk(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    return res.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Email extraction + ranking
// ---------------------------------------------------------------------------

const EMAIL_RE = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
const EMAIL_BLOCK =
  /noreply|no-reply|donotreply|unsubscribe|example\.|sentry\.io|w3\.org|schema\.org|amazonaws|mailchimp|sendgrid|cloudflare|privacy@|legal@|press@|media@|abuse@|postmaster@|webmaster@|security@|support@|wixpress|squarespace|googleapis|github\.com/i;

const EMAIL_BAD_DOMAIN = /\.(svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|eot|ico|pdf|zip|mp4|mp3)$/i;
const EMAIL_PLACEHOLDER = /^(user@domain|test@test|example@|admin@example|foo@bar|email@email|johnsmith@|jane\.doe@|john\.doe@|name@|yourname@)/i;
const EMAIL_GENERIC_DOMAIN = /@(email\.com|domain\.com|test\.com|yoursite\.com|website\.com|company\.com|yourcompany\.com|acme\.com)$/i;

const EMAIL_PRIORITY = [
  "apply@", "hello@", "hi@", "contact@", "team@", "info@",
  "partners@", "investments@", "invest@", "venture@", "fund@",
  "startup@", "founders@", "accelerate@", "pitch@",
];

function extractEmails(html) {
  return [...new Set((html.match(EMAIL_RE) || []))].filter(
    (e) => !EMAIL_BLOCK.test(e) && !EMAIL_BAD_DOMAIN.test(e) && !EMAIL_PLACEHOLDER.test(e) && !EMAIL_GENERIC_DOMAIN.test(e)
  );
}

function rankEmails(emails, orgDomain) {
  return [...emails].sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    // Prefer emails on the org's own domain
    const aOwn = orgDomain && la.endsWith("@" + orgDomain) ? -1 : 0;
    const bOwn = orgDomain && lb.endsWith("@" + orgDomain) ? -1 : 0;
    if (aOwn !== bOwn) return aOwn - bOwn;
    const ai = EMAIL_PRIORITY.findIndex((p) => la.startsWith(p));
    const bi = EMAIL_PRIORITY.findIndex((p) => lb.startsWith(p));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

// ---------------------------------------------------------------------------
// Website discovery via DuckDuckGo Instant Answer API
// ---------------------------------------------------------------------------

async function findWebsiteViaDDG(orgName) {
  try {
    const q = encodeURIComponent(orgName);
    const data = await fetchJson(
      `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`,
      6000
    );
    // AbstractURL is often wikipedia; we want the org's actual site
    // Look in RelatedTopics for an "official site" URL
    const candidates = [];
    if (data.AbstractURL && !data.AbstractURL.includes("wikipedia") && !data.AbstractURL.includes("crunchbase")) {
      candidates.push(data.AbstractURL);
    }
    if (data.Redirect && data.Redirect.startsWith("http")) candidates.push(data.Redirect);
    for (const t of (data.RelatedTopics || [])) {
      if (t.FirstURL && t.FirstURL.startsWith("http") && !t.FirstURL.includes("duckduckgo")) {
        candidates.push(t.FirstURL);
      }
    }
    // Filter out non-org sites
    const blocklist = /wikipedia|crunchbase|linkedin|twitter|facebook|instagram|youtube|ycombinator\.com\/companies|techcrunch|bloomberg|forbes/i;
    return candidates.find((u) => !blocklist.test(u)) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Domain guessing from org name
// ---------------------------------------------------------------------------

const STRIP_WORDS = /\b(accelerator|ventures|capital|fund|labs|lab|studio|studios|network|innovation|center|centre|initiative|program|institute|inc|llc|corp|foundation|group|partners|global|solutions|technologies|technology|tech|digital|health|fintech|biotech|new|the|and|for|of)\b/gi;

function guessDomains(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(STRIP_WORDS, " ")
    .trim()
    .replace(/\s+/g, "");

  const full = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "");

  const suffixes = [".com", ".org", ".co", ".io", ".vc", ".fund"];
  const candidates = [];
  for (const s of suffixes) {
    if (base) candidates.push(base + s);
    if (full && full !== base) candidates.push(full + s);
  }
  return [...new Set(candidates)];
}

// ---------------------------------------------------------------------------
// Email crawl from a website
// ---------------------------------------------------------------------------

async function crawlForEmail(websiteUrl) {
  let origin;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return null;
  }

  const orgDomain = new URL(websiteUrl).hostname.replace(/^www\./, "");
  const paths = ["/", "/contact", "/about", "/team", "/apply"];

  for (const p of paths) {
    try {
      const html = await fetchText(origin + p, 7000);
      const emails = rankEmails(extractEmails(html), orgDomain);
      // Prefer emails on the org's own domain
      const ownDomainEmail = emails.find((e) => e.toLowerCase().includes("@" + orgDomain));
      if (ownDomainEmail) return { email: ownDomainEmail, website: origin };
      if (emails.length > 0) return { email: emails[0], website: origin };
    } catch {}
    await sleep(300);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main discovery per org
// ---------------------------------------------------------------------------

async function discoverContact(orgName) {
  // 1. Try DuckDuckGo
  const ddgSite = await findWebsiteViaDDG(orgName);
  if (ddgSite) {
    const result = await crawlForEmail(ddgSite);
    if (result) return result;
    // Got website but no email — still return the website
    if (!result) return { email: null, website: ddgSite };
  }

  await sleep(200);

  // 2. Try domain guessing
  const guesses = guessDomains(orgName);
  for (const domain of guesses.slice(0, 3)) {
    const url = "https://" + domain;
    if (await headOk(url, 4000)) {
      const result = await crawlForEmail(url);
      if (result?.email) return result;
      if (result?.website) return { email: null, website: result.website };
    }
    await sleep(200);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function readSourceSheet(sheets, spreadsheetId, sheetName) {
  const range = `${quoteSheetName(sheetName)}!A1:J`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = res.data.values || [];
  if (!rows.length) throw new Error(`Source sheet "${sheetName}" is empty.`);

  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (keyword) => headers.findIndex((h) => h.includes(keyword.toLowerCase()));

  const iName       = col("name");
  const iTags       = col("tags");
  const iDesc       = col("description");
  const iLocation   = col("location");
  const iCrunchbase = col("organization");
  const iProgram    = col("program");

  return rows.slice(1)
    .map((row) => ({
      name:          (row[iName]       || "").trim(),
      tags:          (row[iTags]       || "").trim(),
      description:   (row[iDesc]       || "").trim(),
      location:      (row[iLocation]   || "").trim(),
      crunchbaseUrl: (row[iCrunchbase] || "").trim(),
      programType:   (row[iProgram]    || "").trim(),
    }))
    .filter((r) => r.name);
}

async function ensureOutreachTab(sheets, spreadsheetId, outreachSheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
  const exists = (meta.data.sheets || []).some((s) => s.properties.title === outreachSheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: outreachSheetName } } }] },
    });
    console.log(`Created "${outreachSheetName}" tab.`);
  }
}

async function readExistingOutreachNames(sheets, spreadsheetId, outreachSheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheetName(outreachSheetName)}!A:A`,
    });
    const rows = res.data.values || [];
    return new Set(rows.slice(1).map((r) => (r[0] || "").toLowerCase().trim()));
  } catch {
    return new Set();
  }
}

async function hasHeader(sheets, spreadsheetId, outreachSheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheetName(outreachSheetName)}!A1`,
    });
    return (res.data.values || []).length > 0;
  } catch {
    return false;
  }
}

async function appendRows(sheets, spreadsheetId, outreachSheetName, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteSheetName(outreachSheetName)}!A:J`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
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

  const spreadsheetId = config.sourceSpreadsheetId;
  const sourceSheets  = config.sourceSheetNames || [config.sourceSheetName || "Sheet1"];
  const outreachSheet = config.outreachSheetName || "Outreach";

  // Read all source orgs
  const orgs = [];
  for (const tab of sourceSheets) {
    console.log(`Reading "${tab}"...`);
    const rows = await readSourceSheet(sheets, spreadsheetId, tab);
    rows.forEach((r) => { r.sourceTab = tab.trim(); });
    orgs.push(...rows);
    console.log(`  ${rows.length} orgs`);
  }
  console.log(`Total: ${orgs.length} orgs\n`);

  await ensureOutreachTab(sheets, spreadsheetId, outreachSheet);

  // Write header if needed
  if (!(await hasHeader(sheets, spreadsheetId, outreachSheet))) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetName(outreachSheet)}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [OUTREACH_HEADERS] },
    });
  }

  const existing = await readExistingOutreachNames(sheets, spreadsheetId, outreachSheet);
  console.log(`Already in Outreach tab: ${existing.size}`);

  const toProcess = orgs.filter((o) => !existing.has(o.name.toLowerCase().trim()));
  console.log(`To process: ${toProcess.length}\n`);

  let found = 0, missing = 0, done = 0;
  const CONCURRENCY = 8;
  const pendingRows = [];

  async function flushIfReady() {
    if (pendingRows.length >= 20) {
      const toWrite = pendingRows.splice(0, 20);
      await appendRows(sheets, spreadsheetId, outreachSheet, toWrite);
      console.log(`  (saved batch, total done: ${done})`);
    }
  }

  // Process in parallel chunks of CONCURRENCY
  for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
    const chunk = toProcess.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (org) => {
        const result = await discoverContact(org.name);
        return { org, result };
      })
    );

    for (const { org, result } of results) {
      done++;
      const email   = result?.email   || "";
      const website = result?.website || "";

      if (email) {
        console.log(`[${done}/${toProcess.length}] ✓ ${org.name} → ${email}`);
        found++;
      } else {
        console.log(`[${done}/${toProcess.length}]   ${org.name} — ${website ? "website only" : "not found"}`);
        missing++;
      }

      pendingRows.push([
        org.name,
        email,
        website,
        org.description.slice(0, 500),
        org.location,
        org.tags || org.programType || "Accelerator",
        email ? "To Contact" : "Needs Email",
        "",
        email ? "Review before first email" : "Add a verified email address",
        org.crunchbaseUrl,
      ]);
    }

    await flushIfReady();
    await sleep(300); // brief pause between chunks
  }

  if (pendingRows.length > 0) {
    await appendRows(sheets, spreadsheetId, outreachSheet, pendingRows);
  }

  console.log("\n--- Done ---");
  console.log(`Emails found: ${found} | Needs manual entry: ${missing}`);
  console.log(`\nOpen the sheet, fill in missing emails, then: npm run investor:outreach`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

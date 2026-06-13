/**
 * discover-investor-contacts.js — reads the raw investors sheet, tries to
 * find a contact email for each org via Crunchbase + website crawl, then
 * writes enriched rows into the "Outreach" tab ready for investor-outreach.js.
 *
 * Run locally (not in CI — Crunchbase blocks datacenter IPs):
 *   node discover-investor-contacts.js
 *
 * What it does per row:
 *  1. Fetches the Crunchbase page HTML (with browser headers) to extract website URL.
 *  2. Crawls /contact, /about, /team, /apply pages on that website for email addresses.
 *  3. Ranks found emails (apply@ > hello@ > contact@ > info@ > other).
 *  4. Falls back to common patterns: info@{guessed-domain} for well-known orgs.
 *  5. Writes results to the "Outreach" tab. Rows with no email get status "Needs Email".
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

async function fetchPage(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Email extraction
// ---------------------------------------------------------------------------

const EMAIL_RE = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
const EMAIL_BLOCKLIST =
  /noreply|no-reply|donotreply|unsubscribe|example\.|sentry\.io|w3\.org|schema\.org|amazonaws|mailchimp|sendgrid|cloudflare|privacy@|legal@|press@|media@|abuse@|postmaster@|webmaster@|security@/i;

// Prefixes ranked by how likely they are to be a real human inbox
const EMAIL_PRIORITY = [
  "apply@", "hello@", "hi@", "contact@", "team@", "info@",
  "partners@", "investments@", "invest@", "venture@", "fund@",
  "startup@", "founders@", "accelerate@",
];

function extractEmails(html) {
  const raw = [...new Set((html.match(EMAIL_RE) || []))];
  return raw.filter((e) => !EMAIL_BLOCKLIST.test(e));
}

function rankEmails(emails) {
  return [...emails].sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    const ai = EMAIL_PRIORITY.findIndex((p) => la.startsWith(p));
    const bi = EMAIL_PRIORITY.findIndex((p) => lb.startsWith(p));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

// ---------------------------------------------------------------------------
// Website extraction from Crunchbase HTML
// ---------------------------------------------------------------------------

function findDeep(obj, key, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== "object") return null;
  if (key in obj && typeof obj[key] === "string" && obj[key].startsWith("http"))
    return obj[key];
  for (const v of Object.values(obj)) {
    const r = findDeep(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

function extractWebsiteFromCrunchbaseHtml(html) {
  // Strategy 1: __NEXT_DATA__ embedded JSON (Next.js SSR)
  const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (ndMatch) {
    try {
      const data = JSON.parse(ndMatch[1]);
      const site =
        findDeep(data, "website_url") ||
        findDeep(data, "homepage_url") ||
        findDeep(data, "short_url");
      if (site && !site.includes("crunchbase")) return site;
    } catch {}
  }

  // Strategy 2: JSON-LD
  for (const match of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const ld = JSON.parse(match[1]);
      const candidates = [ld.url, ...(Array.isArray(ld.sameAs) ? ld.sameAs : [ld.sameAs || ""])];
      const site = candidates.find(
        (u) => u && u.startsWith("http") && !u.includes("crunchbase") &&
          !u.includes("twitter") && !u.includes("facebook") && !u.includes("linkedin")
      );
      if (site) return site;
    } catch {}
  }

  // Strategy 3: explicit "Homepage" link text on the page
  const hpMatch = html.match(/href="(https?:\/\/(?!(?:www\.)?crunchbase\.com)[^"]+)"[^>]*>\s*(?:Homepage|Website|Visit site)/i);
  if (hpMatch) return hpMatch[1];

  return null;
}

// ---------------------------------------------------------------------------
// Email discovery pipeline
// ---------------------------------------------------------------------------

async function findEmailFromWebsite(websiteUrl) {
  let origin;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return null;
  }

  const paths = ["/", "/contact", "/contact-us", "/about", "/team", "/apply", "/partners", "/invest"];
  for (const p of paths) {
    try {
      const html = await fetchPage(origin + p);
      const emails = rankEmails(extractEmails(html));
      if (emails.length > 0) {
        // Skip emails that look like they belong to a vendor/tool domain
        const orgDomain = origin.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
        const orgEmail = emails.find((e) => e.includes("@" + orgDomain));
        return orgEmail || emails[0];
      }
    } catch {}
    await sleep(600);
  }
  return null;
}

async function discoverEmail(name, crunchbaseUrl) {
  if (!crunchbaseUrl || !crunchbaseUrl.includes("crunchbase.com")) return null;

  let website = null;
  try {
    console.log(`  Fetching Crunchbase page...`);
    const html = await fetchPage(crunchbaseUrl);
    website = extractWebsiteFromCrunchbaseHtml(html);
    if (website) console.log(`  Website: ${website}`);
    else console.log(`  Website not found in Crunchbase HTML.`);
    await sleep(2000 + Math.random() * 1500); // be polite
  } catch (err) {
    console.log(`  Crunchbase fetch failed (${err.message})`);
  }

  if (website) {
    const email = await findEmailFromWebsite(website);
    if (email) return { email, website };
  }

  return website ? { email: null, website } : null;
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
  const col = (name) => headers.findIndex((h) => h.includes(name.toLowerCase()));

  const iName        = col("name");
  const iTags        = col("tags");
  const iDesc        = col("description");
  const iLocation    = col("location");
  const iCrunchbase  = col("organization");
  const iProgram     = col("program");

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
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties.title === outreachSheetName
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: outreachSheetName } } }] },
    });
    console.log(`Created "${outreachSheetName}" tab.`);
  }
}

async function readExistingOutreachRows(sheets, spreadsheetId, outreachSheetName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheetName(outreachSheetName)}!A1:J`,
    });
    const rows = res.data.values || [];
    if (rows.length < 2) return new Set();
    const headers = rows[0].map((h) => String(h).toLowerCase());
    const nameCol = headers.indexOf("name");
    return new Set(rows.slice(1).map((r) => (r[nameCol] || "").toLowerCase().trim()));
  } catch {
    return new Set();
  }
}

async function appendToOutreachSheet(sheets, spreadsheetId, outreachSheetName, newRows) {
  const range = `${quoteSheetName(outreachSheetName)}!A1`;

  // Write header if sheet is empty
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quoteSheetName(outreachSheetName)}!A1:J1` });
  const hasHeader = (current.data.values || []).length > 0;

  const toWrite = hasHeader ? newRows : [OUTREACH_HEADERS, ...newRows];
  const appendRange = `${quoteSheetName(outreachSheetName)}!A1`;

  if (toWrite.length === 0) return;

  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: appendRange,
      valueInputOption: "RAW",
      requestBody: { values: toWrite },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${quoteSheetName(outreachSheetName)}!A:J`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: newRows },
    });
  }
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
  const sourceSheet   = config.sourceSheetName   || "Sheet1";
  const outreachSheet = config.outreachSheetName || "Outreach";

  console.log(`Reading source: "${sourceSheet}" tab...`);
  const orgs = await readSourceSheet(sheets, spreadsheetId, sourceSheet);
  console.log(`Found ${orgs.length} orgs.\n`);

  await ensureOutreachTab(sheets, spreadsheetId, outreachSheet);
  const existing = await readExistingOutreachRows(sheets, spreadsheetId, outreachSheet);
  console.log(`Already in Outreach tab: ${existing.size}\n`);

  const toProcess = orgs.filter((o) => !existing.has(o.name.toLowerCase().trim()));
  console.log(`To process: ${toProcess.length}\n`);

  const newRows = [];
  let found = 0, missing = 0;

  for (const org of toProcess) {
    console.log(`→ ${org.name}`);
    const result = await discoverEmail(org.name, org.crunchbaseUrl);
    const email   = result?.email   || "";
    const website = result?.website || "";

    if (email) {
      console.log(`  ✓ email: ${email}\n`);
      found++;
    } else {
      console.log(`  ✗ no email found — mark as Needs Email\n`);
      missing++;
    }

    newRows.push([
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

    // Write in batches of 10 so progress is saved even if interrupted
    if (newRows.length >= 10) {
      await appendToOutreachSheet(sheets, spreadsheetId, outreachSheet, newRows.splice(0));
      console.log("  (batch written to sheet)");
    }

    await sleep(1500 + Math.random() * 1000);
  }

  if (newRows.length > 0) {
    await appendToOutreachSheet(sheets, spreadsheetId, outreachSheet, newRows);
  }

  console.log("\n--- Done ---");
  console.log(`Emails found: ${found} | Needs manual entry: ${missing}`);
  console.log(`Open the sheet and fill in missing emails, then run: npm run investor:outreach`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

/**
 * discover-investor-people.js — for every org in the source investor sheet,
 * uses Gemini + Google Search to find the SPECIFIC partner/GP most relevant
 * to PluginAny, their individual email, and a portfolio company they backed
 * that is adjacent to PluginAny's space.
 *
 * Output: writes rows to the "People" tab (created if missing).
 * Columns: Partner Name | Email | Organization | Role | Portfolio Reference |
 *          Investment Thesis | Status | Follow-up Date | Next Steps | LinkedIn
 *
 * Run: node discover-investor-people.js
 * Safe to re-run — already-written names are skipped.
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

const PEOPLE_HEADERS = [
  "Partner Name", "Email", "Organization", "Role",
  "Portfolio Reference", "Investment Thesis",
  "Status", "Follow-up Date", "Next Steps", "LinkedIn",
];

const CONCURRENCY = 4;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function quoteSheetName(n) { return `'${String(n).replace(/'/g, "''")}'`; }

// ---------------------------------------------------------------------------
// Gemini discovery model (Google Search grounding)
// ---------------------------------------------------------------------------

const DISCOVERY_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    partner_name: { type: SchemaType.STRING, description: "Full name of the partner/GP/MD" },
    role: { type: SchemaType.STRING, description: "e.g. General Partner, Managing Director, Partner" },
    email: { type: SchemaType.STRING, description: "Individual email of the partner, e.g. garry@ycombinator.com. Empty string if not found." },
    portfolio_reference: { type: SchemaType.STRING, description: "Name of 1 specific company this partner backed that is adjacent to PluginAny (marketplace, platform, API infra, routing, aggregation, mobility, EV, SaaS). Empty if none found." },
    investment_thesis: { type: SchemaType.STRING, description: "One sentence on what this partner focuses on / looks for." },
    linkedin: { type: SchemaType.STRING, description: "LinkedIn URL of the partner. Empty if not found." },
    skip: { type: SchemaType.BOOLEAN, description: "true ONLY if this org is clearly not relevant: arts-only, biotech-only, non-profit with no tech focus, or already defunct." },
  },
  required: ["partner_name", "email", "portfolio_reference", "investment_thesis", "skip"],
};

function buildDiscoveryModel(genAI) {
  return genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    tools: [{ googleSearch: {} }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: DISCOVERY_SCHEMA,
    },
  });
}

function isTransient(err) {
  return /429|500|503|quota|overloaded|resource exhausted/i.test(String(err?.message || err));
}

async function discoverPerson(model, orgName, description, tags) {
  const prompt = `Research task for PluginAny investor outreach.

CONTEXT — PluginAny:
PluginAny is a discovery + aggregation + marketplace + intelligent routing platform. Think of it as the "Stripe for plugin/service discovery" — a single intelligent layer that routes users to the best provider across a fragmented ecosystem in real time. The routing brain is live. 350k+ organic social followers. CTO: Aditya Srivastava (DTU, top 0.4% JEE nationally out of 1.2M candidates). Pre-seed.

The MOST COMPELLING portfolio parallels for cold outreach are companies that:
- Built aggregation or marketplace layers over fragmented supply (Rappi, Instacart, Meituan, Zomato, Stripe, Twilio, Plaid, Segment, Zapier, RapidAPI, Kong, Vercel, Railway, Fly.io, Layer0)
- Built routing or orchestration infrastructure (Stripe Radar, Liftoff, Branch, AppsFlyer, Segment, mParticle)
- Built developer-facing API platforms or SDK layers (Twilio, Plaid, Sardine, Modern Treasury, Moov)
- Built marketplace/platform plays in fragmented verticals (Faire, Angi, Thumbtack, Slice, Treeline)
- Are EV/mobility aggregators or routing platforms (ChargePoint, Blink, Rivian, Tesla, Via, Checkout.com)

TARGET ORGANIZATION: "${orgName}"
Tags/Type: ${tags || ""}
Description: ${(description || "").slice(0, 200)}

Your job:
1. Find the SINGLE MOST RELEVANT partner, GP, managing director, or program manager at this org — the one whose personal investment history overlaps most with aggregation, marketplace, API infrastructure, routing, or developer platforms. Search their team page, LinkedIn, Crunchbase, AngelList.
2. Find their INDIVIDUAL direct email (e.g. garry@ycombinator.com, partner.name@sequoia.com). Check the firm's team page, their personal website, AngelList profile, Twitter bio. Do NOT return a generic info@ or contact@ address.
3. Find the SINGLE portfolio company they personally backed that is most adjacent to PluginAny — specifically something in: aggregation, marketplace infrastructure, API layer, routing/orchestration, or fragmented-supply platform. State WHY it's adjacent in the portfolio_reference field (e.g. "Rappi — on-demand aggregation layer, same multi-provider routing thesis as PluginAny").
4. Their investment thesis in one sharp sentence — what patterns do they fund?
5. Their LinkedIn URL.

If this org is clearly irrelevant (arts-only, biotech-only, non-tech nonprofit, completely unrelated industry), set skip=true.`;

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const data = JSON.parse(text);

      // Validate email looks real
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) data.email = "";
      if (data.email && /example|test|user@domain|noreply|placeholder/i.test(data.email)) data.email = "";

      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const wait = isTransient(err) ? 20000 : 3000;
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

async function readSourceOrgs(sheets, spreadsheetId, sheetNames) {
  const orgs = [];
  for (const tab of sheetNames) {
    const range = `${quoteSheetName(tab)}!A1:J`;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = res.data.values || [];
    if (!rows.length) continue;
    const headers = rows[0].map((h) => String(h).trim().toLowerCase());
    const col = (kw) => headers.findIndex((h) => h.includes(kw));
    const iName = col("name"), iTags = col("tags"), iDesc = col("description");
    rows.slice(1).forEach((row) => {
      const name = (row[iName] || "").trim();
      if (name) orgs.push({
        name,
        tags: (row[iTags] || "").trim(),
        description: (row[iDesc] || "").trim(),
        sourceTab: tab.trim(),
      });
    });
  }
  return orgs;
}

async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
  if (!(meta.data.sheets || []).some((s) => s.properties.title === tabName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  }
}

async function getExistingNames(sheets, spreadsheetId, tabName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${quoteSheetName(tabName)}!C:C`,
    });
    const rows = res.data.values || [];
    return new Set(rows.slice(1).map((r) => (r[0] || "").toLowerCase().trim()));
  } catch { return new Set(); }
}

async function hasHeader(sheets, spreadsheetId, tabName) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${quoteSheetName(tabName)}!A1`,
    });
    return (res.data.values || []).length > 0;
  } catch { return false; }
}

async function appendRows(sheets, spreadsheetId, tabName, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteSheetName(tabName)}!A:J`,
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
    process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const sheets = createSheetsClient(oauth2);
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = buildDiscoveryModel(genAI);

  const spreadsheetId = config.sourceSpreadsheetId;
  const sourceSheets  = config.sourceSheetNames || ["Sheet1"];
  const peopleTab     = "People";

  console.log("Reading source orgs...");
  const orgs = await readSourceOrgs(sheets, spreadsheetId, sourceSheets);
  console.log(`${orgs.length} orgs total across ${sourceSheets.length} tabs.\n`);

  await ensureTab(sheets, spreadsheetId, peopleTab);

  if (!(await hasHeader(sheets, spreadsheetId, peopleTab))) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetName(peopleTab)}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [PEOPLE_HEADERS] },
    });
    console.log("Created People tab with headers.");
  }

  const existing = await getExistingNames(sheets, spreadsheetId, peopleTab);
  console.log(`Already in People tab: ${existing.size} orgs`);

  const todo = orgs.filter((o) => !existing.has(o.name.toLowerCase().trim()));
  console.log(`To discover: ${todo.length}\n`);

  let found = 0, skipped = 0, noEmail = 0, done = 0;
  const buffer = [];

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      chunk.map(async (org) => {
        try {
          const person = await discoverPerson(model, org.name, org.description, org.tags);
          return { org, person, err: null };
        } catch (err) {
          return { org, person: null, err };
        }
      })
    );

    for (const { org, person, err } of results) {
      done++;
      if (err) {
        console.log(`[${done}/${todo.length}] ERROR ${org.name}: ${err.message}`);
        buffer.push([
          "", "", org.name, "", "", "",
          "Error", "", `Discovery failed: ${err.message}`, "",
        ]);
        continue;
      }
      if (person.skip) {
        console.log(`[${done}/${todo.length}] SKIP ${org.name}`);
        skipped++;
        // Don't write to sheet — just skip
        continue;
      }
      if (!person.email) {
        console.log(`[${done}/${todo.length}] no email — ${person.partner_name || "?"} @ ${org.name}${person.portfolio_reference ? ` (backed ${person.portfolio_reference})` : ""}`);
        noEmail++;
      } else {
        console.log(`[${done}/${todo.length}] ✓ ${person.partner_name} <${person.email}> @ ${org.name}${person.portfolio_reference ? ` — backed ${person.portfolio_reference}` : ""}`);
        found++;
      }

      buffer.push([
        person.partner_name || "",
        person.email || "",
        org.name,
        person.role || "",
        person.portfolio_reference || "",
        person.investment_thesis || "",
        person.email ? "To Contact" : "Needs Email",
        "",
        person.email ? "Review before first email" : "Find individual email manually",
        person.linkedin || "",
      ]);
    }

    // Flush every 16 rows
    if (buffer.length >= 16) {
      await appendRows(sheets, spreadsheetId, peopleTab, buffer.splice(0));
    }

    await sleep(800);
  }

  if (buffer.length) await appendRows(sheets, spreadsheetId, peopleTab, buffer);

  console.log("\n--- Done ---");
  console.log(`With email: ${found} | No email found: ${noEmail} | Skipped (irrelevant): ${skipped}`);
  console.log(`Open the "People" tab, then run: npm run investor:outreach`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

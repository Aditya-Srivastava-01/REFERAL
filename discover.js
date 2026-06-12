/**
 * discover.js — build candidates.csv: AI/ML faculty worldwide (configurable
 * areas/countries), ranked by recent publication activity, with emails
 * auto-extracted from their faculty homepages.
 *
 * Data source: CSRankings (https://csrankings.org) public CSV data — a
 * curated list of CS faculty with homepages, plus per-author publication
 * counts by research area. No LinkedIn, no scraping of private platforms.
 *
 * Usage:
 *   node discover.js               # uses outreach-config.json "discover" settings
 *   node discover.js --limit 100   # override candidate count
 *   node discover.js --refresh     # re-download CSRankings data
 *
 * Output: candidates.csv (name, affiliation, country, homepage, email,
 * email_guess, email_score, recent_score). Rows with an empty `email` need a
 * manual fill (e.g. via ContactOut) — just edit the CSV. Re-running discover
 * preserves manually filled emails.
 */

require("./lib/load-env");

const fs = require("fs");
const path = require("path");
const { parseCsv, toCsv } = require("./lib/csv");
const { fetchText, pool, extractEmail } = require("./lib/web");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const CANDIDATES_PATH = path.join(ROOT, "candidates.csv");
const LEDGER_PATH = path.join(ROOT, "outreach-ledger.json");
const CSRANKINGS_BASE =
  "https://raw.githubusercontent.com/emeryberger/CSrankings/gh-pages";

const config = JSON.parse(
  fs.readFileSync(path.join(ROOT, "outreach-config.json"), "utf8")
);
const D = config.discover || {};

// generated-author-info.csv tags publications by CONFERENCE code, so each
// friendly area name expands to its top venues (CSRankings' own grouping).
const AREA_CONFERENCES = {
  ai: ["aaai", "ijcai"],
  vision: ["cvpr", "eccv", "iccv"],
  mlmining: ["icml", "iclr", "nips", "kdd"],
  nlp: ["acl", "emnlp", "naacl"],
  inforet: ["sigir", "www"],
  robotics: ["icra", "iros", "rss"],
};
const AREAS = D.areas || ["ai", "vision", "mlmining", "nlp"];
const CONFERENCES = new Set(
  AREAS.flatMap((a) => AREA_CONFERENCES[a] || [a]) // unknown names pass through as raw conference codes
);
const EXCLUDE_COUNTRIES = (D.excludeCountries || ["in"]).map((c) => c.toLowerCase());
const SINCE_YEAR = D.sinceYear || new Date().getFullYear() - 2;

const args = process.argv.slice(2);
const REFRESH = args.includes("--refresh");
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : D.limit || 300;

// ---------------------------------------------------------------------------
// Step 1: download CSRankings data (cached in data/)
// ---------------------------------------------------------------------------

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const FILES = ["institutions.csv", "generated-author-info.csv"].concat(
  LETTERS.map((l) => `csrankings-${l}.csv`)
);

async function download() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of FILES) {
    const dest = path.join(DATA_DIR, file);
    if (!REFRESH && fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    process.stdout.write(`Downloading ${file} ... `);
    const text = await fetchText(`${CSRANKINGS_BASE}/${file}`, 120000);
    fs.writeFileSync(dest, text);
    console.log(`${(text.length / 1024).toFixed(0)} KB`);
  }
}

function loadCsvFile(name, requiredCols) {
  const { header, records } = parseCsv(
    fs.readFileSync(path.join(DATA_DIR, name), "utf8")
  );
  for (const col of requiredCols) {
    if (!header.includes(col)) {
      throw new Error(
        `${name}: expected column "${col}" not found (got: ${header.join(", ")}). ` +
          `CSRankings may have changed its format — check ${CSRANKINGS_BASE}/${name}`
      );
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `Areas: ${AREAS.join(", ")} | publications since: ${SINCE_YEAR} | ` +
      `excluding countries: ${EXCLUDE_COUNTRIES.join(", ") || "(none)"} | limit: ${LIMIT}\n`
  );

  await download();

  // Institution -> country code ("us" if not listed; CSRankings only lists non-US).
  const countryByInst = new Map();
  for (const r of loadCsvFile("institutions.csv", ["institution", "countryabbrv"])) {
    countryByInst.set(r.institution, r.countryabbrv.toLowerCase());
  }

  // Aggregate recent publication weight per (author, institution) in our areas.
  console.log("Scoring authors by recent publications in selected areas ...");
  const scores = new Map(); // "name|inst" -> number
  for (const r of loadCsvFile("generated-author-info.csv", ["name", "dept", "area", "adjustedcount", "year"])) {
    if (!CONFERENCES.has(r.area)) continue;
    if (parseInt(r.year, 10) < SINCE_YEAR) continue;
    const key = `${r.name}|${r.dept}`;
    scores.set(key, (scores.get(key) || 0) + parseFloat(r.adjustedcount || "0"));
  }
  console.log(`  ${scores.size} active authors found.`);

  // Homepages from the per-letter faculty files.
  const homepageByName = new Map();
  for (const letter of LETTERS) {
    for (const r of loadCsvFile(`csrankings-${letter}.csv`, ["name", "affiliation", "homepage"])) {
      homepageByName.set(r.name, { homepage: r.homepage, affiliation: r.affiliation });
    }
  }

  // People already contacted (ledger) are never re-listed.
  const ledger = fs.existsSync(LEDGER_PATH)
    ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
    : [];
  const contacted = new Set(ledger.map((e) => `${e.name}|${e.affiliation}`));

  // Rank, filter by country, take top N.
  const ranked = [...scores.entries()]
    .map(([key, score]) => {
      const [name, affiliation] = key.split("|");
      return { name, affiliation, score };
    })
    .filter((p) => {
      const country = countryByInst.get(p.affiliation) || "us";
      if (EXCLUDE_COUNTRIES.includes(country)) return false;
      p.country = country;
      return true;
    })
    .filter((p) => !contacted.has(`${p.name}|${p.affiliation}`))
    .filter((p) => {
      const hp = homepageByName.get(p.name) || homepageByName.get(p.name.replace(/\s+\d+$/, ""));
      if (!hp) return false;
      p.homepage = hp.homepage;
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);

  console.log(`  ${ranked.length} candidates after country/ledger filters.\n`);

  // Preserve emails that were filled manually in a previous candidates.csv.
  const previous = new Map();
  if (fs.existsSync(CANDIDATES_PATH)) {
    for (const r of parseCsv(fs.readFileSync(CANDIDATES_PATH, "utf8")).records) {
      previous.set(`${r.name}|${r.affiliation}`, r);
    }
  }

  // Fetch homepages and extract emails (8 at a time).
  console.log(`Fetching ${ranked.length} homepages to extract emails ...`);
  let done = 0;
  await pool(ranked, 8, async (p) => {
    // Only emails the user filled/edited by hand are preserved (auto-extracted
    // ones have email === email_guess and are simply re-extracted).
    const prev = previous.get(`${p.name}|${p.affiliation}`);
    const manuallyFilled =
      prev && prev.email && (prev.email_score === "manual" || prev.email !== (prev.email_guess || ""));
    if (manuallyFilled) {
      p.email = prev.email;
      p.email_guess = prev.email_guess || prev.email;
      p.email_score = "manual";
    } else {
      try {
        const html = await fetchText(p.homepage);
        const r = extractEmail(html, p);
        p.email = r.email;
        p.email_guess = r.guess;
        p.email_score = String(r.score);
      } catch (err) {
        p.email = "";
        p.email_guess = "";
        p.email_score = `fetch failed: ${err.message}`;
      }
    }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${ranked.length}`);
  });

  const header = ["name", "affiliation", "country", "homepage", "email", "email_guess", "email_score", "recent_score"];
  const records = ranked.map((p) => ({
    name: p.name,
    affiliation: p.affiliation,
    country: p.country,
    homepage: p.homepage,
    email: p.email || "",
    email_guess: p.email_guess || "",
    email_score: p.email_score || "",
    recent_score: p.score.toFixed(2),
  }));
  fs.writeFileSync(CANDIDATES_PATH, toCsv(header, records));

  const withEmail = records.filter((r) => r.email).length;
  console.log(`\nWrote ${records.length} candidates to candidates.csv`);
  console.log(`  with auto-extracted email: ${withEmail}`);
  console.log(`  needing manual fill:       ${records.length - withEmail}`);
  console.log(
    `\nReview candidates.csv now: delete rows you don't want, fill blank emails by hand\n` +
      `(the email_guess column shows low-confidence finds you can promote).`
  );
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});

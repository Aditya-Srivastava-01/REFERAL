/**
 * Web helpers: fetch with timeout, a small concurrency pool, and
 * email extraction from faculty homepages (handles common obfuscations
 * like "name [at] cs.uni.edu" and HTML entities).
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) professor-outreach/1.0 (personal academic outreach tool)";

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Run tasks (functions returning promises) with at most `limit` in flight. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err.message || String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Email extraction
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/g;

const BAD_DOMAIN_FRAGMENTS = [
  "example.com", "domain.com", "email.com", "yourdomain", "sentry",
  "wixpress", "godaddy", "cloudflare", "googlegroups", "w3.org",
];
const BAD_EXTENSION = /\.(png|jpe?g|gif|svg|webp|css|js|pdf|webm|mp4)$/i;
const BAD_LOCALPART = /^(webmaster|postmaster|info|office|admin|contact|support|help|noreply|no-reply|abuse|press|jobs|hr|sales)$/i;
const GENERIC_LOCAL_FRAGMENT = /(webmaster|postmaster|noreply|no-reply|master|admin|office|contact|support|enquir|recruit|secretar)/i;
const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|icloud|protonmail|qq|163|126)\./i;

function deobfuscate(html) {
  return html
    .replace(/&#0*64;|&commat;/gi, "@")
    .replace(/&#0*46;|&period;/gi, ".")
    .replace(/&nbsp;/gi, " ")
    // "name [at] domain", "name (AT) domain", "name {at} domain"
    .replace(/\s*[\[({<]\s*at\s*[\])}>]\s*/gi, "@")
    .replace(/\s*[\[({<]\s*dot\s*[\])}>]\s*/gi, ".")
    // "name at domain dot edu" (plain words, tight match only)
    .replace(
      /([A-Za-z0-9._%+-]{2,})\s+at\s+([A-Za-z0-9-]{2,})\s+dot\s+([A-Za-z0-9-]{2,})(\s+dot\s+([A-Za-z]{2,}))?/gi,
      (m, local, d1, d2, _g, d3) => `${local}@${d1}.${d2}${d3 ? "." + d3 : ""}`
    );
}

function normalizeAscii(s) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function rootDomain(host) {
  // crude eTLD+1: keep last 2 labels, or 3 when 2nd-level is a short ccTLD pattern (ac.uk, edu.sg, ...)
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const secondLevel = labels[labels.length - 2];
  const knownSecond = ["ac", "edu", "co", "com", "org", "gov", "net", "uni"];
  if (labels[labels.length - 1].length === 2 && knownSecond.includes(secondLevel)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

/**
 * Extract the most plausible email for `person` from an HTML page.
 * person: { name, homepage }
 * Returns { email, score, guess } — `email` is set only when confidence is
 * reasonable (score >= 3); `guess` always carries the top candidate.
 */
function extractEmail(html, person) {
  const text = deobfuscate(html);
  const found = new Set();

  for (const m of text.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const cleaned = decodeURIComponent(m[1]).match(EMAIL_RE);
    if (cleaned) cleaned.forEach((e) => found.add(e));
  }
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0]);

  if (found.size === 0) return { email: "", score: 0, guess: "" };

  const nameParts = normalizeAscii(person.name || "")
    .split(/\s+/)
    .filter((p) => p.length >= 2 && !/^\d+$/.test(p));
  const last = nameParts[nameParts.length - 1] || "";
  const first = nameParts[0] || "";

  let homepageRoot = "";
  try {
    homepageRoot = rootDomain(new URL(person.homepage).host);
  } catch {}

  let best = { email: "", score: -Infinity };
  for (const raw of found) {
    const email = raw.replace(/^[.\-_]+|[.\-_]+$/g, "").toLowerCase();
    const [local, domain] = email.split("@");
    if (!local || !domain) continue;
    if (BAD_EXTENSION.test(domain)) continue;
    if (BAD_DOMAIN_FRAGMENTS.some((b) => domain.includes(b))) continue;

    let score = 0;
    if (BAD_LOCALPART.test(local) || GENERIC_LOCAL_FRAGMENT.test(local)) score -= 5;
    if (last.length >= 3 && local.includes(last)) score += 4;
    else if (first.length >= 4 && local.includes(first)) score += 2;
    if (homepageRoot && rootDomain(domain) === homepageRoot) score += 3;
    if (/\.edu$|\.ac\.|\.edu\.|^uni-|\.uni-|\.ethz\.|\.epfl\./.test("." + domain)) score += 1;
    if (FREE_MAIL.test(domain)) score -= 1;

    if (score > best.score) best = { email, score };
  }

  if (best.score === -Infinity) return { email: "", score: 0, guess: "" };
  return {
    email: best.score >= 3 ? best.email : "",
    score: best.score,
    guess: best.email,
  };
}

module.exports = { fetchText, fetchJson, pool, sleep, extractEmail, normalizeAscii };

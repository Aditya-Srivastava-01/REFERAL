# Professor outreach — automated pipeline

This automates the loop you do by hand: **find AI professors abroad → get their
email → send a personalized email about yourself → chase the ones who don't reply.**

It replaces the manual LinkedIn-browsing + ContactOut steps with public academic
data, and it writes each email with Claude so every one is specific to that
professor's recent work — not a template blast.

## The three stages

| Stage | Script | What it does | How often |
| --- | --- | --- | --- |
| 1. Discover | `npm run discover` | Builds `candidates.csv`: top AI/ML faculty worldwide (ranked by recent publications), with emails auto-extracted from their homepages. | When you need more candidates |
| 2. Outreach | `npm run outreach` | Takes the next few un-contacted professors, pulls their recent papers, has Claude write a tailored email, sends it from your Gmail, labels it `outreach`, and records it so nobody is emailed twice. | Daily (auto via GitHub Actions) |
| 3. Follow-up | `npm run run` | The original tool: chases professors who haven't replied after 7 days. Targets only `outreach`-labeled threads. | Daily (auto) |

You stay in control at the one place it matters: **you review `candidates.csv`
before any email goes out**, and the first live run is gated behind a dry run.

---

## Why this data, not LinkedIn

- **CSRankings** (csrankings.org) — a public, curated list of CS faculty with
  homepages, plus per-author publication counts by area. This is how stage 1
  ranks "who is an active AI professor abroad" without scraping LinkedIn.
- **OpenAlex** (openalex.org) — a free scholarly database. Stage 2 uses it to
  pull each professor's 2-4 most recent papers so the email can reference real,
  current work. No API key needed.
- **Their own faculty homepage** — where the email address comes from. Stage 1
  fetches the homepage CSRankings already lists and extracts the address
  (handling `name [at] cs.uni.edu` style obfuscation). When it can't find one
  confidently, it leaves the cell blank for you to fill — it never guesses.

Nothing here touches LinkedIn or ContactOut. For the few blanks, you can still
use ContactOut by hand and paste the address into the CSV.

---

## One-time setup

### 1. Gmail OAuth (shared with the follow-up tool)

If you already set up `professor-followup`, you're done — same credentials.
Otherwise follow **steps 1-3 in [README.md](README.md)** to get
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN`.

### 2. Google Gemini API key (free — no credit card)

Get one at <https://aistudio.google.com/apikey>. Sign in with any Google
account, click **Create API key** → copy it. This is what writes the emails.

**Cost: free.** Gemini's free tier allows 1,500 requests/day on
`gemini-2.0-flash`; this tool sends 5/day by default, so you'll use ~0.3% of
your quota. No billing setup, no credit card.

(If you ever want higher-quality prose, swap `"model"` in `outreach-config.json`
to `"gemini-1.5-pro"` — also free, 50 requests/day, still well above 5.)

### 3. Install

```powershell
cd D:\professor-followup
npm install
```

### 4. Fill in your profile — THIS IS THE IMPORTANT ONE

Open **`profile.md`** and fill every section. This is the **only** thing Claude
knows about you — it will not invent qualifications, so vague input gives vague
emails and concrete input (real projects, real numbers, a real ask) gives
emails that get replies. The script refuses to run while any `FILL ME` remains.

Your PluginAny EV-routing project is exactly the kind of concrete, verifiable
thing to lead with.

---

## Running it

### Stage 1 — discover candidates

```powershell
npm run discover
```

Produces `candidates.csv`. Open it (Excel / VS Code) and:

- **Delete** any rows you don't want to contact.
- **Fill the blank `email` cells** you care about. The `email_guess` column
  shows low-confidence finds — if one looks right, copy it into `email`.
- Rows are sorted by `recent_score` (recent publication activity) — the people
  at the top are the most active right now.

Your manually-entered emails are preserved if you re-run discover later.

Tune what gets pulled in `outreach-config.json` under `"discover"` — research
areas, which countries to exclude (defaults to "anywhere except India"), and
how many candidates.

### Stage 2 — send (dry run first!)

`outreach-config.json` ships with `"dryRun": true`. Do a dry run — it writes the
actual emails and prints them, but sends nothing:

```powershell
npm run outreach
```

Read the printed emails. Check the tone, the paper references, the ask. When
you're happy, set `"dryRun": false` in `outreach-config.json` and run again to
send for real. It sends at most `dailyCap` (default 5) per run.

### Automate it

Push to a **private** GitHub repo and add these secrets
(**Settings → Secrets and variables → Actions**):

| Secret | |
| --- | --- |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | from Gmail setup |
| `GEMINI_API_KEY` | from aistudio.google.com/apikey |
| `YOUR_NAME` | e.g. `Aditya Srivastava` |

Two workflows then run on a weekday schedule:
- **professor-outreach** — sends the daily batch, commits the updated ledger.
- **professor-followup** — chases non-repliers (set its `dryRun` to false too).

Both have a **Run workflow** button in the Actions tab with a dry-run toggle, so
you can trigger a test send by hand first.

---

## Safety & etiquette

- **Daily cap + send spacing.** Default 5/day, spaced ~45s apart. A personalized
  trickle is both more effective and far safer for your Gmail reputation than a
  blast. Don't crank `dailyCap` to 50.
- **Never contacts anyone twice.** Every send is logged in
  `outreach-ledger.json` (keyed by email *and* name+institution). Discover also
  skips anyone already in the ledger.
- **You review before sending.** The CSV review step and the dry-run gate are
  deliberate — an AI-written email with a wrong fact going to a professor is the
  one thing worth preventing.
- **Facts are grounded.** Claude is instructed to use only what's in
  `profile.md` and to reference a paper only when there's a genuine connection
  (otherwise it speaks to the research area). The CS-field filter on OpenAlex
  guards against same-name professors getting their papers mixed in.
- **Use a private repo.** The ledger contains who you emailed and the email text.

---

## Files

| File | What it is |
| --- | --- |
| `profile.md` | **You fill this.** The only facts Claude may use about you. |
| `outreach-config.json` | Settings for discover + outreach. |
| `candidates.csv` | Generated list; you review/edit it. |
| `outreach-ledger.json` | Auto: who's been contacted (never re-emailed). |
| `discover.js` / `outreach.js` | Stage 1 / stage 2 scripts. |
| `lib/` | CSV, web-fetch, and email-extraction helpers. |
| `followup.js`, `config.json`, `template.txt` | The original follow-up tool (stage 3). |

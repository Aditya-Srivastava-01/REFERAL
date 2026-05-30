# professor-followup

Automatically sends a polite follow-up email to professors you've already contacted
**only if they haven't replied**, after a waiting period (default 7 days). Runs daily
on GitHub Actions. Free — it uses your own Gmail.

## How it works

1. Authenticates to **your Gmail** (one OAuth scope: `gmail.modify` — read + send).
2. Scans your **Sent mail** from the last `lookbackDays` days and groups it into threads.
3. For each thread **you started**:
   - If the professor ever replied → **skip** (you only want non-repliers).
   - If it's been ≥ `followupIntervalDays` since your last message and you haven't hit
     `maxFollowups` → **send a follow-up** as a reply in the same thread.
4. **State needs no database**: each follow-up is itself a "from me" message, which
   resets the clock and increments the follow-up count automatically.

A `dryRun` mode (default **on**) logs what *would* be sent without sending anything,
and an **academic-domain filter** (`.edu`, `.ac.uk`, …) keeps it from emailing
non-professors picked up from your Sent folder.

## One-time setup

### 1. Enable the Gmail API and create OAuth credentials
1. Go to <https://console.cloud.google.com/> → create a project (any name).
2. **APIs & Services → Library → Gmail API → Enable.**
3. **APIs & Services → OAuth consent screen** → choose **External**, fill the basics,
   and under **Test users** add your own Gmail address. (Staying in "Testing" mode is
   fine for personal use; tokens just need re-consent every ~6 months.)
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Application type: Desktop app.** Copy the **Client ID** and **Client secret**.

### 2. Get a refresh token (run locally once)
```bash
cd professor-followup
npm install

# PowerShell:
$env:GMAIL_CLIENT_ID="...";  $env:GMAIL_CLIENT_SECRET="..."
# macOS/Linux:
export GMAIL_CLIENT_ID=...;  export GMAIL_CLIENT_SECRET=...

npm run token
```
Open the printed URL, approve access, and copy the **refresh token** it prints.

### 3. Add GitHub repository secrets
**Repo → Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Value |
| --- | --- |
| `GMAIL_CLIENT_ID` | from step 1 |
| `GMAIL_CLIENT_SECRET` | from step 1 |
| `GMAIL_REFRESH_TOKEN` | from step 2 |
| `YOUR_NAME` | your name for the email signature (e.g. `Aditya Srivastava`) |

### 4. Customize
- **`template.txt`** — the follow-up body. Placeholders: `{{greeting}}` (e.g. "Professor Smith"),
  `{{display_name}}`, `{{your_name}}`.
- **`config.json`** — timing, caps, domain allow/skip lists, and the outreach filters. See the inline comments.

## Targeting ONLY your outreach emails (important)

Auto-detecting from Sent mail can't tell *why* you emailed a professor. Routine academic
mail — your current advisor, a TA, an admin office — is also academic-domain, also started
by you, and also "unreplied". To avoid follow-ups going to those, use one (or both) of:

- **`gmailLabel`** (most reliable): apply a Gmail label, e.g. `outreach`, to the threads you
  want chased — by hand, or with a Gmail filter that auto-labels. Set `"gmailLabel": "outreach"`
  in `config.json` and the tool ignores everything else.
- **`subjectMustInclude` / `subjectMustExclude`** (zero effort, heuristic): require the original
  subject to contain an outreach word and/or exclude coursework words. Ships with sensible
  excludes (`assignment`, `lecture`, `deadline`, `grade`, `class`, `course`, `meeting`).

The dry run's `Subject filtered` count tells you how many threads these rules removed.

See **[GMAIL-FILTERS.md](GMAIL-FILTERS.md)** for ready-to-paste Gmail filter recipes that
auto-apply the `outreach` label (including how to make it hands-off as you send).

## Test it safely first

`config.json` ships with `"dryRun": true`. Run a dry run before going live:

- **Locally:**
  ```bash
  $env:GMAIL_REFRESH_TOKEN="..."   # plus the other env vars
  npm run dry
  ```
- **On GitHub:** Actions tab → **professor-followup → Run workflow** (leave "Dry run" checked).

Review the log — every line `→ email | subject | 9d since last, follow-up #1` is something
it *would* send. When you're happy, set `"dryRun": false` in `config.json` and commit.
The daily schedule (08:00 UTC) then sends for real.

## Notes & safety
- **Use a private repo.** Secrets are encrypted either way, but your `template.txt` and run
  logs (recipient addresses) are visible to anyone who can read the repo.
- It never touches threads where the professor already replied, and never sends more than
  `maxFollowups` per professor.
- Want to exclude a specific person you've decided not to chase? Add their address to
  `skipAddresses` in `config.json`.
- The Gmail API daily send quota is far above anything this will use.

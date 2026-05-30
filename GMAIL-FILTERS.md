# Auto-labeling your outreach emails

The tool can restrict itself to a single Gmail label (set `"gmailLabel": "outreach"`
in `config.json`). The only question is how that label gets applied. Gmail filters
run on **incoming** mail, not on mail you send — so there's a trick involved.

Pick **one** of the three approaches below. Approach A is the only fully hands-off one.

---

## A. Auto-label as you send (BCC trigger) — recommended for hands-off

You BCC a "plus address" of your own on outreach emails; a filter catches that copy
and labels the conversation. Gmail plus-addresses (`you+anything@gmail.com`) all deliver
to your normal inbox, so nothing extra to set up on the mail side.

**One-time: create the filter**
1. Gmail → search bar → click the **filter icon** (sliders) on the right.
2. In **Has the words**, paste (replace with your real address):
   ```
   deliveredto:youraddress+outreach@gmail.com
   ```
   `deliveredto:` matches the BCC'd copy reliably. Click **Create filter**.
3. Tick these actions:
   - ✅ **Apply the label:** `outreach` (create it here if needed)
   - ✅ **Skip the Inbox (Archive it)**  ← keeps the BCC copies out of your face
   - ✅ **Mark as read**
4. Click **Create filter**.

**Then, when sending outreach:** add `youraddress+outreach@gmail.com` to **BCC**.
Save it as a contact named e.g. "Outreach tag" so it autocompletes in one keystroke.

That's it — every outreach email auto-labels its thread. The archived BCC copy doesn't
clutter your inbox, and the tool ignores it when counting follow-ups (it counts only
Sent messages), so timing and the follow-up cap stay correct.

Finally set in `config.json`:
```json
"gmailLabel": "outreach"
```

---

## B. Retroactively label outreach you've ALREADY sent

Filters can be applied to existing matching conversations, including sent ones.

1. Filter icon → in **From** put `me`, and in **To** list the universities you've
   emailed, separated by `OR` (Gmail can't wildcard `*.edu`, so name the domains):
   ```
   From:  me
   To:    harvard.edu OR mit.edu OR cam.ac.uk OR stanford.edu
   Doesn't have:  assignment lecture deadline grade class course meeting
   ```
2. **Create filter** → tick **Apply the label:** `outreach` **and**
   ✅ **Also apply filter to N matching conversations** (this is what labels the
   existing sent mail).

Or, even simpler for a one-off: search `from:me` in Sent, multi-select the outreach
threads by hand, and apply the `outreach` label.

---

## C. One-click manual label (most reliable, tiny effort)

If you'd rather not BCC anything:
1. Gmail → Settings → **See all settings → Advanced/General → Keyboard shortcuts: On**.
2. Open (or select) an outreach thread and press **`l`**, type `outreach`, Enter.

Reliable and side-effect-free; just a habit to build when you hit Send.

---

## No label at all (already built in)

If you skip labels entirely (`"gmailLabel": ""`), the tool still targets outreach via
the **subject keyword** rules in `config.json` (`subjectMustInclude` /
`subjectMustExclude`) plus the academic-domain filter. Tune `subjectMustInclude` to your
outreach vocabulary, e.g. `["PhD", "research", "prospective", "position", "opportunity"]`,
and it's hands-off without any Gmail setup — just less precise than a label.

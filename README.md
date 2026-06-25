# Gmail label → CSV exporter

A small Google Apps Script that exports **every email under a Gmail label** into a
Google Sheet (one row per message). Need a CSV? Use Google Sheets' built-in
**File → Download → Comma-separated values (.csv)** — it quotes commas and
newlines correctly, so message bodies stay intact.

> **Not comfortable with code?** Follow **[Getting-Started.md](Getting-Started.md)**
> instead — it walks you through the whole thing, one gentle step at a time.

*(This README is the technical overview. The step-by-step guide is the friendly one.)*

It's built for a **one-time historical backfill** of a large, already-tagged
mailbox — the case where Zapier/CloudHQ-style tools hit their row/zap limits.
Apps Script is free, but it has its *own* limits, so this script is built to work
around them:

- **Resumable** — each run stops just before Gmail's per-run time cap and
  continues where it left off (automatically, on a timer, if you want).
- **Safe to re-run** — it dedupes by thread, so re-running never doubles rows.
- **Survives the daily Gmail quota** — if it hits the daily read limit it saves
  progress and retries later.

## Setup (no code editing required)

1. Create or open a **Google Sheet**.
2. **Extensions → Apps Script.** Delete the placeholder code, paste in
   [`Code.gs`](Code.gs), and **Save**.
3. **Close and re-open the Google Sheet.** A **"Gmail Export"** menu appears.
   - *First-run quirk:* on a brand-new script the menu sometimes doesn't show
     until Google has authorized it once. If it's missing, **reload the sheet a
     second time.** You never need to open the Apps Script editor to use it.

You do **not** edit the code to set a label — you pick it from the menu (below).

## Running it

From the **Gmail Export** menu, in order:

1. **Choose Gmail label...**
   The **first** click triggers Google's one-time authorization — approve it in
   the popup (it needs to read Gmail and write this sheet). This authorization is
   unavoidable for any tool that reads your mail, but it happens **right inside the
   sheet** — no editor needed. A dialog then lists your **actual** Gmail labels;
   pick one. (Picking from the list avoids "label not found" errors from typos or
   nested-label paths.) The choice is saved for this sheet.
2. **Export / continue.**
   Fills the **Emails** tab.
   - If the mailbox is large, the run stops after ~5 minutes and (by default)
     **keeps going on its own every 5 minutes** until finished. You can close the
     tab and come back later.
   - Prefer to drive it yourself? Set `AUTO_RESUME: false` in the code and just
     click **Export / continue** again until it says *"Export complete."*

When you want a file, use **File → Download → Comma-separated values (.csv)** with
the **Emails** tab active. (Sheets exports the *current* tab, and its CSV quoting
handles the commas and newlines inside message bodies correctly.)

**Start over?** Menu → **Reset / start over** clears the tab and timers (your
chosen label is kept).

## Sharing this with someone else

Send them a **copy** of the finished sheet (File → Make a copy, or share and have
them copy it). The script travels with the sheet. When *they* run it, it
authorizes under *their* account and exports *their* Gmail — so whoever has the
tagged emails should be the one running it.

## Output columns

| column | notes |
|---|---|
| `messageId` | Stable Gmail message id — the unique key for each row |
| `threadId` | Gmail thread id |
| `date` | Message date, **UTC**, ISO-8601 (`2026-06-24T10:05:00Z`) |
| `from` | Raw `From` header |
| `fromEmail` / `fromName` | Parsed convenience fields |
| `to`, `cc` | Recipients |
| `subject` | Subject line |
| `labels` | All labels on the thread (comma-separated) |
| `permalink` | Direct Gmail link to the message |
| `body` | Full plain-text body (see truncation note) |
| `bodyTruncated` | `TRUE` if the body was clipped (see below) |

One row = one message. A thread with several messages produces several rows.

## What the CSV is good for

The export keeps a stable `messageId` key and a full `body` column, so the file
drops cleanly into spreadsheets, databases, or any tool that reads CSV. This
script only *extracts* the emails — any further analysis happens in whatever tool
you take the CSV into.

## Limits & caveats (so nothing surprises you)

- **Cell size / truncation.** Google Sheets caps a cell at 50,000 characters, so
  any body longer than `MAX_BODY_CHARS` (49,000) is clipped, flagged in
  `bodyTruncated`, and counted in the completion log. Most email bodies are
  nowhere near this long — but if yours are, say so and the script can be
  changed to stream rows straight to a CSV file instead of staging in the sheet
  (no cell-size cap).
- **Per-run time.** ~6 min on consumer `@gmail.com`, 30 min on Workspace. Handled
  by the resume logic; Workspace users can raise `MAX_RUNTIME_MS` to `25 * 60 * 1000`.
- **Daily Gmail read quota.** ~20k message reads/day (consumer), higher on
  Workspace. A very large mailbox may finish over more than one day — progress is
  preserved across days.
- **Dates are UTC** for consistent downstream parsing.
- **Dedup is per-thread:** each thread is exported once. For a static historical
  backfill that's exact. (If a thread later gets new replies, re-running won't add
  them — fine for a one-time historical export.)

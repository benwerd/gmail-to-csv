# Getting started: copying your tagged emails into a spreadsheet

This guide walks you through it one step at a time. You don't need to know
anything about code, and you can't break anything by trying. Take it slowly. The
whole thing usually takes about ten minutes, and most of that is clicking
**Allow** and waiting.

What this does: it finds every email you've given a particular label (tag) in
Gmail and copies each one into a row in a Google spreadsheet: the date, who it's
from, the subject, and the full message. From there you can download it as a file
or work with it like any other spreadsheet.

What you'll need:
- The Google account that has the emails in it.
- About ten minutes.
- The code file (`Code.gs`) that came with this guide, open and ready to copy.

> **Were you handed a ready-made spreadsheet?** If someone already set this up and
> shared a copy of the sheet with you, you can skip Steps 1–3 and start at Step 4.

---

## Step 1: Make a new spreadsheet

Go to [sheets.new](https://sheets.new) (or open Google Sheets and start a blank
one), and leave it empty. This is where your emails will land.

## Step 2: Open the place where the tool lives

In the spreadsheet's top menu, click **Extensions**, then **Apps Script**.

A new browser tab opens with a code area in it. This is the workshop where the
little helper program sits. It looks technical, but you only need to do one thing
here.

## Step 3: Paste in the tool

1. In that code area, select everything that's already there and delete it.
2. Copy everything from the `Code.gs` file you were given, and paste it in.
3. Click the **Save** icon (the floppy-disk picture) near the top.

You can now close this tab and go back to your spreadsheet.

## Step 4: Refresh, and find the new menu

Close your spreadsheet tab and re-open the sheet from Google Drive.

Look along the top menu bar, just to the right of **Help**. You should see a new
menu called **Gmail Export**.

> **Don't see it yet?** It's a little shy the very first time. Refresh the page
> once more, give it a few seconds, and it'll show up.

## Step 5: Choose your label

Click **Gmail Export → Choose Gmail label...**

The first time you do this, Google will ask for permission. That screen can look
alarming, so please read the short note just below before you click anything,
then come back here.

Once you've granted permission, a small box appears listing the labels in your
Gmail. Pick the one your emails are tagged with, and click **Save**. Choosing from
the list (rather than typing) means you'll never get the spelling wrong.

### A note about the permission screen

The first time, Google checks that you trust this tool to look at your account. It
shows a strong-looking warning for any small, personal program like this one,
because the program hasn't gone through the review process meant for big
commercial apps. This is expected, and it doesn't mean anything is wrong. Here's
the path:

1. **Choose an account.** Pick the Google account that has your emails.
2. **"Google hasn't verified this app."** Click the small **Advanced** link at the
   bottom-left, then **Go to … (unsafe)**. The word "unsafe" is Google's standard
   wording for a personal tool it hasn't reviewed. It's fine to continue here
   because you know who this tool came from.
3. **"… wants access to your Google Account."** Click **Allow**.

This tool only reads your messages and copies them into your spreadsheet. It never
sends, changes, or deletes any email. (The whole program is right there in the
editor if you, or someone you trust, ever wants to look.) As a good habit, only
click through a screen like this for a tool you got from someone you trust.

## Step 6: Run the export

Click **Gmail Export → Export / continue**.

Watch the rows start filling in on the **Emails** tab.

If you have a lot of email, the tool works in batches so it never times out: it
does a chunk, pauses, and keeps going on its own every few minutes until it's
finished. You can leave it running and even close the tab; come back later and
it'll have carried on. When everything's done, you'll see a little "Export
complete" message.

## Step 7: Get your file (optional)

If you want the data as a downloadable file, make sure the **Emails** tab is the
one showing, then click **File → Download → Comma-separated values (.csv)**.

That gives you a `.csv` file: a plain spreadsheet file you can open in Excel or
Numbers, or pass to whatever you're using it for.

---

## If something doesn't look right

- **No "Gmail Export" menu after refreshing.** Refresh the page one more time and
  wait a few seconds. The menu always appears once Google has approved the tool.
- **It says "label not found."** Use **Choose Gmail label...** and pick the label
  from the list instead of typing it.
- **It seemed to stop before finishing.** That's normal for a large mailbox: it
  pauses and resumes itself. If you're impatient, click **Export / continue**
  again to nudge it along.
- **You want to start over.** Use **Gmail Export → Reset / start over**. It clears
  the rows and lets you run a fresh export. (Your chosen label is kept.)

## That's it

Once the rows are in the sheet, you're done. The emails are now yours to sort,
filter, search, or download like any other spreadsheet.

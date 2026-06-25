/**
 * Gmail label → CSV exporter (Google Apps Script)
 * --------------------------------------------------
 * Exports every message under a Gmail label into a Google Sheet (one row per
 * message), then lets you download that sheet as a properly-quoted CSV.
 *
 * Designed for a HISTORICAL BACKFILL of a large, tagged mailbox:
 *   - Resumable: stops before Gmail's per-run time limit and picks up where it
 *     left off (optionally on an automatic timer).
 *   - Safe to re-run: dedupes by thread, so nothing is exported twice.
 *   - Survives the daily Gmail read quota: saves progress and retries later.
 *
 * SETUP
 *   1. Open (or create) a Google Sheet.
 *   2. Extensions → Apps Script. Delete the placeholder, paste this whole file.
 *   3. Set CONFIG.LABEL_NAME below to your exact label.
 *   4. Save, then reload the Sheet. Use the "Gmail Export" menu, or Run
 *      exportLabelToSheet from the editor (you'll be asked to authorize once).
 *
 * The output CSV is shaped for downstream ingestion (e.g. schema-mapping-cli):
 * it keeps a stable messageId key and a full `body` column. Parsing the survey
 * content / identifying the person inside each body is a SEPARATE, downstream
 * step — intentionally out of scope here.
 */

// ============================== CONFIG ==============================
const CONFIG = {
  // Exact Gmail label. For a nested label, use the full path: 'Parent/Child'.
  LABEL_NAME: 'YOUR_LABEL_HERE',

  // Tab used as the resumable staging area inside this spreadsheet.
  TAB_NAME: 'Emails',

  // How many threads to fetch per page while scanning.
  BATCH_SIZE: 25,

  // Stop this many ms into a run, leaving margin under Gmail's execution cap.
  // Consumer Gmail (@gmail.com) caps each run at 6 min  -> keep ~5 min here.
  // Google Workspace caps at 30 min                     -> you may use 25 * 60 * 1000.
  MAX_RUNTIME_MS: 5 * 60 * 1000,

  // If true, when a run runs out of time it installs a timer to finish on its
  // own. If false, you simply Run it again until it reports "complete".
  AUTO_RESUME: true,
  RESUME_EVERY_MINUTES: 5, // allowed: 1, 5, 10, 15, 30

  // Google Sheets caps a single cell at 50,000 characters. Longer bodies are
  // truncated to this length, flagged in the bodyTruncated column, and counted.
  MAX_BODY_CHARS: 49000,

  // Drive folder where the exported CSV is written.
  CSV_FOLDER_NAME: 'Gmail Exports'
};

const HEADERS = [
  'messageId', 'threadId', 'date', 'from', 'fromEmail', 'fromName',
  'to', 'cc', 'subject', 'labels', 'permalink', 'body', 'bodyTruncated'
];

const PROP_STATUS = 'EXPORT_STATUS';
const FLUSH_EVERY_ROWS = 200; // write to the sheet in chunks for speed

// ============================== MENU ==============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Gmail Export')
    .addItem('1. Export label → sheet (resumable)', 'exportLabelToSheet')
    .addItem('2. Download as CSV (to Drive)', 'exportSheetToCsv')
    .addSeparator()
    .addItem('Reset / start over', 'resetProgress')
    .addToUi();
}

// ============================== MAIN ==============================
/**
 * Export the label into the staging sheet. Resumable and safe to re-run.
 * This is the function the timer (if enabled) calls to continue the job.
 */
function exportLabelToSheet() {
  const deadline = new Date().getTime() + CONFIG.MAX_RUNTIME_MS;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('No active spreadsheet. Paste this into a Sheet via Extensions → Apps Script.');
  }
  const sheet = getOrCreateSheet_(ss, CONFIG.TAB_NAME);

  const label = GmailApp.getUserLabelByName(CONFIG.LABEL_NAME);
  if (!label) {
    throw new Error('Label not found: "' + CONFIG.LABEL_NAME +
      '". Check the spelling. For a nested label use the full path, e.g. "Parent/Child".');
  }

  const done = loadDoneThreadIds_(sheet); // { threadId: true } from prior runs
  const stats = { added: 0, truncated: 0 };
  let buffer = [];
  let offset = 0;
  let timeUp = false;

  function flush() {
    if (buffer.length) {
      appendRows_(sheet, buffer);
      stats.added += buffer.length;
      buffer = [];
    }
  }

  try {
    while (true) {
      if (new Date().getTime() > deadline) { timeUp = true; break; }

      const threads = label.getThreads(offset, CONFIG.BATCH_SIZE);
      if (threads.length === 0) break; // reached the end of the label

      for (let i = 0; i < threads.length; i++) {
        if (new Date().getTime() > deadline) { timeUp = true; break; }

        const thread = threads[i];
        const tId = thread.getId();
        if (done[tId]) continue; // already exported in a previous run

        try {
          const rows = buildRowsForThread_(thread, stats);
          for (let r = 0; r < rows.length; r++) buffer.push(rows[r]);
          done[tId] = true;
          if (buffer.length >= FLUSH_EVERY_ROWS) flush();
        } catch (threadErr) {
          // Don't let one bad thread abort the whole run.
          Logger.log('⚠️ Skipped thread ' + tId + ': ' + threadErr);
          done[tId] = true;
        }
      }

      if (timeUp) break;
      offset += threads.length;
    }
  } catch (err) {
    // Most likely the daily Gmail read quota. Persist progress and let the
    // timer retry later (the quota resets, and we continue from here).
    flush();
    Logger.log('⚠️ Stopped early: ' + err + '. Progress saved; will retry on the next scheduled run.');
    PropertiesService.getScriptProperties().setProperty(PROP_STATUS, 'IN_PROGRESS');
    if (CONFIG.AUTO_RESUME) ensureResumeTrigger_();
    return;
  }

  flush();

  if (timeUp) {
    PropertiesService.getScriptProperties().setProperty(PROP_STATUS, 'IN_PROGRESS');
    Logger.log('⏳ Time budget reached. Added ' + stats.added + ' row(s) this run. More remain.');
    if (CONFIG.AUTO_RESUME) {
      ensureResumeTrigger_();
    } else {
      toast_(ss, 'Batch done (' + stats.added + ' rows). Run again to continue.');
    }
  } else {
    // Scanned the whole label without running out of time → finished.
    removeResumeTriggers_();
    PropertiesService.getScriptProperties().setProperty(PROP_STATUS, 'DONE');
    let msg = '✅ Export complete. Added ' + stats.added + ' row(s) this run.';
    if (stats.truncated > 0) msg += ' (' + stats.truncated + ' body/bodies truncated at ' + CONFIG.MAX_BODY_CHARS + ' chars.)';
    Logger.log(msg);
    toast_(ss, 'Export complete. Now run "Download as CSV".');
  }
}

// ============================== CSV EXPORT ==============================
/**
 * Write the staging sheet to a correctly-quoted .csv file in Drive.
 * Returns the file URL (also logged and shown as a toast).
 */
function exportSheetToCsv() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.TAB_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error('Nothing to export yet — run "Export label → sheet" first.');
  }

  const data = sheet.getDataRange().getValues();
  const csv = data.map(function (row) {
    return row.map(function (cell) {
      const s = (cell === null || cell === undefined) ? '' : String(cell);
      return '"' + s.replace(/"/g, '""') + '"'; // RFC-4180 quoting
    }).join(',');
  }).join('\r\n');

  const folder = getOrCreateFolder_(CONFIG.CSV_FOLDER_NAME);
  const stamp = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMdd-HHmmss');
  const safeLabel = CONFIG.LABEL_NAME.replace(/[^a-zA-Z0-9-_]+/g, '_');
  const file = folder.createFile(safeLabel + '_emails_' + stamp + '.csv', csv, MimeType.CSV);

  Logger.log('✅ CSV created: ' + file.getUrl());
  toast_(ss, 'CSV created in Drive folder "' + CONFIG.CSV_FOLDER_NAME + '".');
  return file.getUrl();
}

// ============================== RESET ==============================
/** Clear staging data and timers so the next run starts completely fresh. */
function resetProgress() {
  removeResumeTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(PROP_STATUS);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.TAB_NAME);
  if (sheet) sheet.clearContents();
  Logger.log('🔄 Progress reset. Run "Export label → sheet" to start over.');
  toast_(ss, 'Reset complete. Run the export to start fresh.');
}

// ============================== HELPERS ==============================
function getOrCreateSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function loadDoneThreadIds_(sheet) {
  const done = {};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return done;
  const col = HEADERS.indexOf('threadId') + 1;
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const v = values[i][0];
    if (v) done[v] = true;
  }
  return done;
}

function buildRowsForThread_(thread, stats) {
  const threadId = thread.getId();
  const permalinkBase = 'https://mail.google.com/mail/u/0/#all/';
  const labels = thread.getLabels().map(function (l) { return l.getName(); }).join(', ');
  const messages = thread.getMessages();
  const rows = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const from = m.getFrom() || '';
    const parsed = parseAddress_(from);

    let body = m.getPlainBody() || '';
    let truncated = false;
    if (body.length > CONFIG.MAX_BODY_CHARS) {
      body = body.substring(0, CONFIG.MAX_BODY_CHARS) + '…[truncated]';
      truncated = true;
      if (stats) stats.truncated++;
    }

    const msgId = m.getId();
    rows.push([
      msgId,
      threadId,
      Utilities.formatDate(m.getDate(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"),
      from,
      parsed.email,
      parsed.name,
      m.getTo() || '',
      m.getCc() || '',
      m.getSubject() || '',
      labels,
      permalinkBase + msgId,
      body,
      truncated ? 'TRUE' : 'FALSE'
    ]);
  }
  return rows;
}

/** Parse '"Name" <email@x.com>' or 'email@x.com' into {name, email}. */
function parseAddress_(s) {
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  const justEmail = s.match(/[^\s<>]+@[^\s<>]+/);
  return { name: '', email: justEmail ? justEmail[0] : s.trim() };
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);
}

function ensureResumeTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'exportLabelToSheet') return; // already scheduled
  }
  ScriptApp.newTrigger('exportLabelToSheet')
    .timeBased()
    .everyMinutes(CONFIG.RESUME_EVERY_MINUTES)
    .create();
}

function removeResumeTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'exportLabelToSheet') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function getOrCreateFolder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function toast_(ss, message) {
  try { ss.toast(message, 'Gmail → CSV', 6); } catch (e) { /* no UI in trigger context */ }
}

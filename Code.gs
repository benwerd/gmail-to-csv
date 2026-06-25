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
 * SETUP (no code editing required)
 *   1. Open (or create) a Google Sheet.
 *   2. Extensions → Apps Script. Delete the placeholder, paste this whole file, Save.
 *   3. Reload the Google Sheet. A "Gmail Export" menu appears (see note below if not).
 *   4. Gmail Export → "Choose Gmail label..." → approve the one-time Google
 *      authorization in the popup → pick your label.
 *   5. Gmail Export → "Export / continue".  Then → "Download as CSV".
 *
 * FIRST-RUN NOTE: on a brand-new script the menu may not show until Google has
 * authorized it once. If you don't see "Gmail Export" after reloading, just
 * reload the sheet a second time. You never need to open the editor to use this.
 *
 * The output CSV keeps a stable messageId key and a full `body` column, shaped for
 * downstream ingestion (e.g. schema-mapping-cli). Parsing the survey content /
 * identifying the person inside each body is a SEPARATE, downstream step.
 */

// ============================== CONFIG ==============================
const CONFIG = {
  // OPTIONAL fallback label. Most users should ignore this and pick the label
  // from the "Gmail Export → Choose Gmail label..." menu instead (saved per-sheet).
  // This value is only used if no label has been chosen via the menu.
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
  // own. If false, you simply Export again until it reports "complete".
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
const PROP_LABEL = 'EXPORT_LABEL';     // chosen label, saved per-document
const FLUSH_EVERY_ROWS = 200;          // write to the sheet in chunks for speed

// ============================== MENU ==============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Gmail Export')
    .addItem('1. Choose Gmail label...', 'showLabelPicker')
    .addItem('2. Export / continue', 'runExport')
    .addItem('3. Download as CSV (to Drive)', 'exportSheetToCsv')
    .addSeparator()
    .addItem('Reset / start over', 'resetProgress')
    .addToUi();
}

// Runs if this is ever deployed/installed as an add-on; harmless otherwise.
function onInstall(e) {
  onOpen();
}

// ============================== LABEL PICKER (UI) ==============================
/** Show a dialog that lists the account's Gmail labels and saves the choice. */
function showLabelPicker() {
  const html = HtmlService.createHtmlOutput(LABEL_PICKER_HTML)
    .setWidth(420)
    .setHeight(240);
  SpreadsheetApp.getUi().showModalDialog(html, 'Gmail Export — choose a label');
}

/** Called from the dialog: list user labels + the currently chosen one. */
function getUserLabelNames() {
  const names = GmailApp.getUserLabels()
    .map(function (l) { return l.getName(); })
    .sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
  return { labels: names, current: resolveLabelName_() };
}

/** Called from the dialog: persist the chosen label for this sheet. */
function saveSelectedLabel(name) {
  if (!name) throw new Error('No label selected.');
  PropertiesService.getDocumentProperties().setProperty(PROP_LABEL, name);
  toast_(SpreadsheetApp.getActiveSpreadsheet(),
    'Label set to "' + name + '". Now choose "Export / continue".');
  return name;
}

/** Menu entry point for exporting: ensures a valid label, then runs the export. */
function runExport() {
  const ui = SpreadsheetApp.getUi();
  const labelName = resolveLabelName_();
  if (!labelName) {
    showLabelPicker();
    return;
  }
  if (!GmailApp.getUserLabelByName(labelName)) {
    ui.alert('The saved label ("' + labelName + '") was not found in this account. Please choose it again.');
    showLabelPicker();
    return;
  }
  exportLabelToSheet();
}

/** Saved (per-sheet) label wins; else the CONFIG fallback; else empty. */
function resolveLabelName_() {
  const saved = PropertiesService.getDocumentProperties().getProperty(PROP_LABEL);
  if (saved && saved.trim()) return saved.trim();
  if (CONFIG.LABEL_NAME && CONFIG.LABEL_NAME !== 'YOUR_LABEL_HERE') return CONFIG.LABEL_NAME.trim();
  return '';
}

// ============================== MAIN ==============================
/**
 * Export the chosen label into the staging sheet. Resumable and safe to re-run.
 * This is the function the timer (if enabled) calls to continue the job. It is
 * UI-safe: when run from a trigger it logs instead of showing dialogs.
 */
function exportLabelToSheet() {
  const deadline = new Date().getTime() + CONFIG.MAX_RUNTIME_MS;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('No active spreadsheet. Paste this into a Sheet via Extensions → Apps Script.');
  }
  const sheet = getOrCreateSheet_(ss, CONFIG.TAB_NAME);

  const labelName = resolveLabelName_();
  if (!labelName) {
    Logger.log('No label chosen yet. Use "Gmail Export → Choose Gmail label...".');
    return;
  }
  const label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    Logger.log('Label not found: "' + labelName + '". Re-choose it from the Gmail Export menu.');
    return;
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
      toast_(ss, 'Batch done (' + stats.added + ' rows). Run Export again to continue.');
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
    throw new Error('Nothing to export yet — run "Export / continue" first.');
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
  const safeLabel = (resolveLabelName_() || 'gmail').replace(/[^a-zA-Z0-9-_]+/g, '_');
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
  Logger.log('🔄 Progress reset. Run "Export / continue" to start over. (Chosen label kept.)');
  toast_(ss, 'Reset complete. Run Export to start fresh.');
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

// ============================== DIALOG HTML ==============================
const LABEL_PICKER_HTML =
'<!DOCTYPE html><html><head><base target="_top"><style>' +
'body{font-family:Arial,Helvetica,sans-serif;font-size:13px;margin:16px;color:#202124}' +
'h3{margin:0 0 12px}select{width:100%;padding:6px;font-size:13px}' +
'.row{margin:14px 0}button{padding:8px 14px;font-size:13px;border:0;border-radius:4px;cursor:pointer}' +
'.primary{background:#1a73e8;color:#fff}.primary:disabled{background:#9bb8e8;cursor:default}' +
'.muted{color:#5f6368;font-size:12px}#status{margin-top:10px}' +
'</style></head><body>' +
'<h3>Choose the Gmail label to export</h3>' +
'<div id="loading" class="muted">Loading your labels…</div>' +
'<div class="row" id="picker" style="display:none"><select id="label"></select></div>' +
'<div class="row" id="actions" style="display:none"><button class="primary" id="save" onclick="save()">Save label</button></div>' +
'<div id="status" class="muted"></div>' +
'<script>' +
'function load(){google.script.run.withSuccessHandler(show).withFailureHandler(fail).getUserLabelNames();}' +
'function show(d){document.getElementById("loading").style.display="none";' +
'var s=document.getElementById("label");' +
'd.labels.forEach(function(n){var o=document.createElement("option");o.value=n;o.text=n;if(n===d.current)o.selected=true;s.add(o);});' +
'if(d.labels.length===0){document.getElementById("status").innerText="No user labels found in this account.";return;}' +
'document.getElementById("picker").style.display="block";document.getElementById("actions").style.display="block";}' +
'function fail(e){document.getElementById("loading").innerText="Could not load labels: "+e.message;}' +
'function save(){var n=document.getElementById("label").value;var b=document.getElementById("save");' +
'b.disabled=true;document.getElementById("status").innerText="Saving…";' +
'google.script.run.withSuccessHandler(function(){google.script.host.close();})' +
'.withFailureHandler(function(e){b.disabled=false;document.getElementById("status").innerText="Error: "+e.message;})' +
'.saveSelectedLabel(n);}' +
'load();' +
'<\/script></body></html>';

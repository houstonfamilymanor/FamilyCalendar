/**
 * School inbox: copies school emails from the family account's Gmail into the
 * "Mail" tab of the data spreadsheet, so the page can sort them by teacher/kid
 * and suggest calendar events (suggestions are made in the browser; nothing is
 * added to the calendar without someone approving it).
 *
 * Which emails: see mailQueries_() below (override with the MAIL_QUERY Script Property).
 * It catches mail auto-forwarded by a Gmail filter (original sender kept) and
 * mail forwarded by hand (sender read from the "Forwarded message" block).
 *
 * Runs every 15 minutes via a trigger that checkSetup() installs, and on
 * demand from the page ("Check now").
 */

// What counts as "school mail" in the family inbox, unless the MAIL_QUERY Script Property
// overrides it: anything from Focus, plus anything your Gmail filters forwarded
// (deliveredto: your address) or the history copier sent (from: your address).
// The personal addresses come from ALLOWED_EMAILS, so none are written in this public file.
// newer_than counts from arrival in the family inbox, so history copies are still found.
var MAIL_WINDOW = 'newer_than:45d';
var MAIL_NOISE = '-from:(accounts.google.com OR google.com OR github.com)';

/** Gmail searches whose results together are the school mail (merged, de-duplicated). */
function mailQueries_() {
  var custom = PropertiesService.getScriptProperties().getProperty('MAIL_QUERY');
  if (custom) return [custom];
  var family = Session.getEffectiveUser().getEmail().toLowerCase();
  var people = allowedEmails_().filter(function (e) { return e !== family; });
  var parts = ['from:(focus-sis.com)', '"focus-sis.com"', '"Forwarded message"'];   // Focus mail, hand forwards, history copies
  if (people.length) {
    parts.push('deliveredto:(' + people.join(' OR ') + ')');
    parts.push('from:(' + people.join(' OR ') + ')');
  }
  return [
    MAIL_WINDOW + ' (' + parts.join(' OR ') + ') ' + MAIL_NOISE,
    // Filter-forwarded mail keeps its original To (your address), so it isn't addressed to us.
    MAIL_WINDOW + ' -to:(' + family + ') -from:(' + family + ') ' + MAIL_NOISE
  ];
}
var MAIL_BATCH = 50;          // threads per Gmail search page
var MAIL_MAX_PAGES = 10;      // up to 500 threads looked at per sync (history imports)
var MAIL_KEEP_DAYS = 365;     // shown on the page (the school year)
var MAIL_BODY_MAX = 20000;

/** Trigger entry point (triggers can't call names ending in "_"). */
function syncMail() {
  return syncMail_();
}

/** Import new matching messages. Returns how many were added. */
function syncMail_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var props = PropertiesService.getScriptProperties();
    var queries = mailQueries_();
    var known = {}, unchecked = [];
    readTable_('Mail').forEach(function (m) {
      known[m.id] = true;
      if (!m.attachments) unchecked.push(m);          // imported before attachments were tracked
    });
    var account = Session.getEffectiveUser().getEmail();

    // Page through results: Gmail returns newest first, so already-imported mail fills the
    // first page and a batch of older copies (history import) would otherwise never be reached.
    var threads = [], seenThread = {};
    queries.forEach(function (query) {
      for (var page = 0; page < MAIL_MAX_PAGES; page++) {
        var batch = GmailApp.search(query, page * MAIL_BATCH, MAIL_BATCH);
        batch.forEach(function (t) {
          if (!seenThread[t.getId()]) { seenThread[t.getId()] = true; threads.push(t); }
        });
        if (batch.length < MAIL_BATCH) break;
      }
    });

    var rows = [];
    GmailApp.getMessagesForThreads(threads).forEach(function (msgs) {
      msgs.forEach(function (msg) {
        var id = msg.getId();
        if (known[id]) return;
        known[id] = true;
        var m = describeMessage_(msg);
        rows.push(rowValues_('Mail', {
          id: id,
          threadId: msg.getThread().getId(),
          fromName: m.fromName,
          fromEmail: m.fromEmail,
          subject: m.subject,
          date: String(m.date.getTime()),
          body: m.body.slice(0, MAIL_BODY_MAX),
          read: 'false',
          dismissed: '',
          link: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(account) + '#all/' + id,
          importedAt: String(Date.now()),
          attachments: attachmentNames_(msg)
        }));
      });
    });

    var sh = sheet_('Mail');                          // also extends the header if a column was added
    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABLES.Mail.length).setNumberFormat('@').setValues(rows);
    }

    // Backfill attachment names for older rows, a batch per sync.
    unchecked.slice(0, 60).forEach(function (r) {
      try {
        var msg = GmailApp.getMessageById(r.id);
        r.attachments = msg ? attachmentNames_(msg) : NO_ATTACHMENTS;
      } catch (e) {
        r.attachments = NO_ATTACHMENTS;
      }
      writeRow_('Mail', r);
    });
    props.setProperty('MAIL_LAST_SYNC', String(Date.now()));
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

var NO_ATTACHMENTS = '(none)';

/** Real attachments (not inline logos/signature images), one file name per line. */
function attachmentNames_(msg) {
  try {
    var names = msg.getAttachments({ includeInlineImages: false })
      .map(function (a) { return a.getName(); })
      .filter(String);
    return names.length ? names.join('\n').slice(0, 2000) : NO_ATTACHMENTS;
  } catch (e) {
    return NO_ATTACHMENTS;
  }
}

/** Sender, subject, date and text, unwrapping a hand-forwarded message. */
function describeMessage_(msg) {
  var from = parseAddress_(msg.getFrom());
  var out = {
    fromName: from.name, fromEmail: from.email,
    subject: msg.getSubject() || '', date: msg.getDate(),
    body: String(msg.getPlainBody() || '')
  };
  var fwd = /-{5,}\s*Forwarded message\s*-{5,}\s*\n([\s\S]*?)\n\s*\n([\s\S]*)$/i.exec(out.body);
  if (fwd) {
    var head = fwd[1];
    var f = /^From:\s*(.+)$/im.exec(head);
    var d = /^Date:\s*(.+)$/im.exec(head);
    var s = /^Subject:\s*(.+)$/im.exec(head);
    if (f) { var a = parseAddress_(f[1]); out.fromName = a.name; out.fromEmail = a.email; }
    if (d) {
      var parsed = new Date(d[1].replace(/ at /, ' ').replace(/ /g, ' '));
      if (!isNaN(parsed)) out.date = parsed;
    }
    if (s) out.subject = s[1].trim();
    out.body = fwd[2];
  }
  out.subject = out.subject.replace(/^(?:fwd?|fw):\s*/i, '');
  return out;
}

function parseAddress_(s) {
  s = String(s || '').trim();
  var m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: s, email: s.toLowerCase() };
}

// ---------- read / write for the page ----------

function getMail_() {
  var cutoff = Date.now() - MAIL_KEEP_DAYS * DAY_MS;
  var mail = readTable_('Mail')
    .filter(function (m) { return Number(m.date) >= cutoff && m.dismissed !== 'true'; })
    .sort(function (a, b) { return Number(b.date) - Number(a.date); })
    .filter(function (m, i, all) {
      // The same email can arrive more than once (forwarded by hand, copied by the history
      // tool, re-copied with attachments). Show one, preferring the copy that has the files.
      var key = function (x) { return x.fromEmail + '|' + x.subject + '|' + Math.round(Number(x.date) / 120000); };
      var hasFiles = function (x) { return x.attachments && x.attachments !== NO_ATTACHMENTS; };
      var k = key(m);
      for (var j = 0; j < all.length; j++) {
        if (j === i || key(all[j]) !== k) continue;
        if (hasFiles(all[j]) && !hasFiles(m)) return false;          // a better copy exists
        if (hasFiles(all[j]) === hasFiles(m) && j < i) return false;  // same quality: keep the first
      }
      return true;
    })
    .slice(0, 150)
    .map(function (m) {
      return {
        id: m.id, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject,
        date: Number(m.date), body: m.body.slice(0, 8000), read: m.read === 'true', link: m.link,
        attachments: m.attachments && m.attachments !== NO_ATTACHMENTS ? m.attachments.split('\n') : []
      };
    });
  var roster = readTable_('Roster')
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (r) { return { id: r.id, name: r.name, kid: r.kid }; });
  var rules = readTable_('Rules')
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (r) { return { id: r.id, match: r.match, label: r.label, kind: r.kind === 'meal' ? 'meal' : 'group' }; });
  return {
    mail: mail,
    roster: roster,
    rules: rules,
    lastSync: Number(PropertiesService.getScriptProperties().getProperty('MAIL_LAST_SYNC') || 0)
  };
}

/**
 * The formatted (HTML) version of one stored school email, fetched when it's opened
 * (too big to keep in the Sheet). Only emails already in the School tab can be fetched.
 * Returns { html: "" } when there's no formatted version (e.g. plain-text copies).
 */
function getMailHtml_(id) {
  id = String(id || '');
  if (!/^[0-9a-f]{8,32}$/i.test(id)) throw new Error('Bad email id');
  var row = readTable_('Mail').filter(function (r) { return r.id === id; })[0];
  if (!row) throw new Error('Not a school email');
  var msg = GmailApp.getMessageById(id);
  var html = msg ? String(msg.getBody() || '') : '';
  if (!/<(?:html|body|div|table|p|br|span|a)\b/i.test(html)) return { html: '' };
  html = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')                      // never needed; the page sandboxes anyway
    .replace(/<meta[^>]+http-equiv[^>]*>/gi, '')
    .replace(/<img\b[^>]*\bsrc=["']cid:[^"']*["'][^>]*>/gi, '');        // inline images that can't load here
  return { html: html.slice(0, 600000) };
}

function mutateMail_(d) {
  if (d.action === 'mail.sync') {
    var added = syncMail_();
    var res = getMail_();
    res.added = added;
    return res;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (d.action === 'mail.read' || d.action === 'mail.dismiss' || d.action === 'mail.undismiss') {
      var rows = readTable_('Mail');
      var ids = {};
      (d.ids || []).forEach(function (id) { ids[String(id)] = true; });
      rows.forEach(function (r) {
        if (!ids[r.id]) return;
        if (d.action === 'mail.read') r.read = String(d.read !== false);
        else r.dismissed = d.action === 'mail.dismiss' ? 'true' : '';   // dismiss = hidden in the app only; Gmail keeps it
        writeRow_('Mail', r);
      });
    } else if (d.action === 'roster.save') {
      // Replace the whole roster: [{ name, kid }]
      var list = (d.rows || []).slice(0, 100).map(function (r, i) {
        return rowValues_('Roster', {
          id: Utilities.getUuid(),
          name: cleanText_(r.name, MAX_TEXT, 'Teacher name'),
          kid: String(r.kid || '').trim().slice(0, 100),
          order: i
        });
      });
      var sh = sheet_('Roster');
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABLES.Roster.length).clearContent();
      if (list.length) sh.getRange(2, 1, list.length, TABLES.Roster.length).setNumberFormat('@').setValues(list);
    } else if (d.action === 'rules.save') {
      // Replace all sender rules: [{ match, label, kind }]
      var rules = (d.rows || []).slice(0, 100).map(function (r, i) {
        return rowValues_('Rules', {
          id: Utilities.getUuid(),
          match: cleanText_(r.match, 200, 'Sender text'),
          label: cleanText_(r.label, 100, 'Category'),
          kind: r.kind === 'meal' ? 'meal' : 'group',
          order: i
        });
      });
      var rs = sheet_('Rules');
      if (rs.getLastRow() > 1) rs.getRange(2, 1, rs.getLastRow() - 1, TABLES.Rules.length).clearContent();
      if (rules.length) rs.getRange(2, 1, rules.length, TABLES.Rules.length).setNumberFormat('@').setValues(rules);
    } else {
      throw new Error('Unknown action');
    }
  } finally {
    lock.releaseLock();
  }
  return getMail_();
}

/**
 * DIAGNOSTIC: run from the editor. Compares emails WITH attachments in the family
 * inbox against what the School tab has stored, so we can see where files go missing.
 */
function debugAttachments() {
  var rows = readTable_('Mail');
  var byId = {};
  rows.forEach(function (r) { byId[r.id] = r; });
  var hasFiles = function (r) { return r.attachments && r.attachments !== NO_ATTACHMENTS; };
  Logger.log('STORED: ' + rows.length + ' emails | with attachments: ' + rows.filter(hasFiles).length +
    ' | not checked yet: ' + rows.filter(function (r) { return !r.attachments; }).length +
    ' | dismissed: ' + rows.filter(function (r) { return r.dismissed === 'true'; }).length);
  Logger.log('Sheet columns: ' + sheet_('Mail').getRange(1, 1, 1, sheet_('Mail').getLastColumn()).getValues()[0].join(', '));

  var threads = GmailApp.search('has:attachment newer_than:7d', 0, 30);
  Logger.log('INBOX: ' + threads.length + ' conversations with attachments in the last 7 days');
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var files = attachmentNames_(m);
      var all = m.getAttachments().length;
      var row = byId[m.getId()];
      Logger.log('  "' + m.getSubject() + '" from ' + m.getFrom() +
        ' | files: ' + (files === NO_ATTACHMENTS ? 'none (' + all + ' inline)' : files.replace(/\n/g, ', ')) +
        ' | in app: ' + (row ? 'yes, stored=' + (row.attachments ? row.attachments.replace(/\n/g, ', ') : '(unchecked)') +
          (row.dismissed === 'true' ? ', DISMISSED' : '') : 'NO'));
    });
  });
  Logger.log('SEARCHES USED: ' + mailQueries_().join('  ||  '));

  // What the page actually receives.
  var sent = getMail_().mail;
  var withFiles = sent.filter(function (m) { return m.attachments.length; });
  Logger.log('SENT TO APP: ' + sent.length + ' emails, ' + withFiles.length + ' with attachments');
  withFiles.forEach(function (m) { Logger.log('  ✨ ' + m.subject + ' [' + m.id + '] ' + m.attachments.join(', ')); });
  rows.filter(hasFiles).forEach(function (r) {
    if (!sent.some(function (m) { return m.id === r.id; })) {
      var twin = sent.filter(function (m) { return m.subject === r.subject; })[0];
      Logger.log('  HIDDEN: "' + r.subject + '" date=' + r.date + ' from=' + r.fromEmail +
        (twin ? ' | shown instead: id=' + twin.id + ' date=' + twin.date + ' from=' + twin.fromEmail : ' | no twin shown'));
    }
  });
}

/** Install the 15-minute sync trigger once (called from checkSetup). */
function ensureMailTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'syncMail';
  });
  if (!exists) ScriptApp.newTrigger('syncMail').timeBased().everyMinutes(15).create();
  return exists ? 'already installed' : 'installed';
}

/**
 * ONE-TIME HELPER: copy past emails matched by YOUR Gmail forwarding filters
 * to the family account, so Family Command's School tab can read them.
 *
 * Gmail filters only forward NEW mail. This looks up the filters in your
 * account that forward to FAMILY_ADDRESS, and copies the older emails those
 * same filters would have forwarded (the last DAYS_BACK days).
 *
 * Run it in your own Google account (not the family one):
 *   1. https://script.google.com -> New project. Paste this file.
 *   2. Left side: "Services" (+) -> Gmail API -> Add.   (lets it read your filters)
 *   3. Fill in FAMILY_ADDRESS below (and DAYS_BACK if you want). Save.
 *   4. Choose copyFilteredEmails -> Run -> approve.
 *      Optional first: run previewFilters to see what it would copy, without sending.
 *   Already ran it before attachments were included? Run recopyWithAttachments once.
 *   5. Gmail lets a script send about 100 emails a day. If the log says some
 *      are left, run it again tomorrow. Copied threads get the label
 *      "Family Command/Copied", so nothing is sent twice.
 *
 * Each copy is sent as a normal forward (original sender, date, subject at the
 * top). Nothing is deleted or changed in your inbox apart from that label.
 */

var FAMILY_ADDRESS = 'PUT-THE-FAMILY-GMAIL-ADDRESS-HERE';
var DAYS_BACK = 30;                             // copy emails from the last 30 days
var LABEL = 'Family Command/Copied';
var LABEL_FILES = 'Family Command/Copied with files';

/** Shows which filters were found and how many emails they match. Sends nothing. */
function previewFilters() {
  var q = filterQuery_();
  var n = GmailApp.search('(' + q.query + ') newer_than:' + DAYS_BACK + 'd', 0, 500).length;
  Logger.log('Filters forwarding to ' + FAMILY_ADDRESS + ':\n  ' + q.parts.join('\n  '));
  Logger.log(n + (n === 500 ? '+' : '') + ' conversations match in the last ' + DAYS_BACK + ' days.');
}

function copyFilteredEmails() {
  var q = filterQuery_();
  Logger.log('Using your filters:\n  ' + q.parts.join('\n  '));

  var label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  var budget = Math.min(90, MailApp.getRemainingDailyQuota() - 5);
  if (budget <= 0) { Logger.log('Daily send limit reached. Run again tomorrow.'); return; }

  var query = '(' + q.query + ') newer_than:' + DAYS_BACK + 'd -label:"' + LABEL + '"';
  var threads = [];
  for (var start = 0; ; start += 100) {
    var page = GmailApp.search(query, start, 100);
    threads = threads.concat(page);
    if (page.length < 100) break;
  }
  threads.reverse();                            // oldest first

  var me = Session.getActiveUser().getEmail().toLowerCase();
  var sent = 0, left = 0;
  threads.forEach(function (thread) {
    var msgs = thread.getMessages().filter(function (m) {
      return m.getFrom().toLowerCase().indexOf(me) < 0;   // skip your own replies
    });
    if (sent + msgs.length > budget) { left += msgs.length; return; }
    msgs.forEach(function (m) { sendCopy_(m); sent++; });
    thread.addLabel(label);
  });

  Logger.log('Copied ' + sent + ' emails to ' + FAMILY_ADDRESS + '.');
  Logger.log(left ? left + ' left. Run this again tomorrow to copy the rest.' : 'All done. Nothing left to copy.');
}

/**
 * For emails copied BEFORE attachments were included: re-sends only the ones
 * that have attachments, this time with the files. (Family Command shows each
 * email once and keeps the copy that has the files.)
 */
function recopyWithAttachments() {
  var done = GmailApp.getUserLabelByName(LABEL_FILES) || GmailApp.createLabel(LABEL_FILES);
  var budget = Math.min(90, MailApp.getRemainingDailyQuota() - 5);
  if (budget <= 0) { Logger.log('Daily send limit reached. Run again tomorrow.'); return; }
  var threads = GmailApp.search('label:"' + LABEL + '" has:attachment -label:"' + LABEL_FILES + '"', 0, 200);
  var me = Session.getActiveUser().getEmail().toLowerCase();
  var sent = 0, left = 0;
  threads.forEach(function (thread) {
    var msgs = thread.getMessages().filter(function (m) {
      return m.getFrom().toLowerCase().indexOf(me) < 0 &&
        m.getAttachments({ includeInlineImages: false }).length > 0;
    });
    if (sent + msgs.length > budget) { left += msgs.length; return; }
    msgs.forEach(function (m) { sendCopy_(m); sent++; });
    thread.addLabel(done);
  });
  Logger.log('Re-sent ' + sent + ' emails with their attachments.');
  Logger.log(left ? left + ' left. Run this again tomorrow.' : 'All done.');
}

/** Sends one email to the family account as a forward, with its attachments. */
function sendCopy_(m) {
  var body = '---------- Forwarded message ---------\n' +
    'From: ' + m.getFrom() + '\n' +
    'Date: ' + m.getDate().toISOString() + '\n' +
    'Subject: ' + m.getSubject() + '\n\n' +
    m.getPlainBody();
  var files = m.getAttachments({ includeInlineImages: false });
  var size = files.reduce(function (n, f) { return n + f.getSize(); }, 0);
  if (files.length && size < 20 * 1024 * 1024) {
    GmailApp.sendEmail(FAMILY_ADDRESS, 'Fwd: ' + m.getSubject(), body, { attachments: files });
  } else {
    if (files.length) body += '\n\n[Attachments too large to copy: ' + files.map(function (f) { return f.getName(); }).join(', ') + ']';
    GmailApp.sendEmail(FAMILY_ADDRESS, 'Fwd: ' + m.getSubject(), body);
  }
}

/** Builds one Gmail search from every filter that forwards to FAMILY_ADDRESS. */
function filterQuery_() {
  if (FAMILY_ADDRESS.indexOf('@') < 0) throw new Error('Fill in FAMILY_ADDRESS at the top first.');
  if (typeof Gmail === 'undefined') {
    throw new Error('Add the Gmail API service first: left side "Services" (+) -> Gmail API -> Add.');
  }
  var filters = (Gmail.Users.Settings.Filters.list('me').filter || []).filter(function (f) {
    return f.action && f.action.forward &&
      f.action.forward.toLowerCase() === FAMILY_ADDRESS.toLowerCase();
  });
  if (!filters.length) {
    throw new Error('No filters forward to ' + FAMILY_ADDRESS + '. Check Gmail settings -> Filters and Blocked Addresses.');
  }
  var parts = filters.map(function (f) {
    var c = f.criteria || {}, p = [];
    if (c.from) p.push('from:(' + c.from + ')');
    if (c.to) p.push('to:(' + c.to + ')');
    if (c.subject) p.push('subject:(' + c.subject + ')');
    if (c.query) p.push('(' + c.query + ')');
    if (c.negatedQuery) p.push('-(' + c.negatedQuery + ')');
    if (c.hasAttachment) p.push('has:attachment');
    return p.join(' ');
  }).filter(String);
  return {
    parts: parts,
    query: parts.map(function (p) { return '(' + p + ')'; }).join(' OR ')
  };
}

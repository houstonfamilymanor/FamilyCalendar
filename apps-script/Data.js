/**
 * Notes & lists store: a "Family Command Data" spreadsheet in the family
 * account's Drive, created on first use. Three tabs, one row per record:
 *
 *   Lists  id | name | order | updatedAt | updatedBy
 *   Items  id | listId | text | done | order | updatedAt | updatedBy
 *   Notes  id | title | body | pinned | updatedAt | updatedBy
 *
 * Every cell is stored as plain text (number format "@") so typed values
 * are never turned into dates or formulas. Every write returns the whole
 * store so the page can re-render from one response.
 */

var TABLES = {
  Lists: ['id', 'name', 'order', 'updatedAt', 'updatedBy'],
  Items: ['id', 'listId', 'text', 'done', 'order', 'updatedAt', 'updatedBy'],
  Notes: ['id', 'title', 'body', 'pinned', 'updatedAt', 'updatedBy'],
  // School inbox (Mail.js)
  // attachments: file names, one per line; "" = not checked yet (older rows get backfilled)
  Mail: ['id', 'threadId', 'fromName', 'fromEmail', 'subject', 'date', 'body', 'read', 'dismissed', 'link', 'importedAt', 'attachments'],
  // Dismissed school emails: NOT the email, only its Gmail id + link, shown live from Gmail
  // for 30 days, then the link is erased (the bare id stays a little longer so the 45-day
  // sync doesn't import the same email again, then that goes too). See Mail.js.
  Dismissed: ['id', 'link', 'dismissedAt'],
  // Event tags (Tags.js)
  Tags: ['id', 'name', 'color', 'hidden', 'order'],
  EventTags: ['id', 'tags', 'updatedAt'],
  // Kids' schools: lunch menus, school events, letter days (Schools.js)
  Kids: ['id', 'name', 'site', 'menuFeed', 'eventsFeed', 'letterCal', 'letterMeanings', 'lastTry', 'lastOk', 'error', 'order'],
  Lunch: ['id', 'feed', 'date', 'breakfast', 'lunch', 'fetchedAt'],
  SchoolEvents: ['id', 'feed', 'title', 'start', 'end', 'allDay', 'date', 'fetchedAt'],
  LetterDays: ['id', 'cal', 'date', 'label', 'fetchedAt'],
  Roster: ['id', 'name', 'kid', 'order'],
  // Sender categories: emails whose sender contains `match` go to `label`.
  // kind: "group" (own filter, no event suggestions) or "meal" (balance alert card).
  Rules: ['id', 'match', 'label', 'kind', 'order']
};
var MAX_TEXT = 500;      // list names, item text, note titles
var MAX_BODY = 20000;    // note bodies

// ---------- spreadsheet plumbing ----------

function db_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DATA_SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted: make a new one */ }
  }
  var ss = SpreadsheetApp.create('Family Command Data');
  Object.keys(TABLES).forEach(function (name, i) {
    var sh = i === 0 ? ss.getSheets()[0].setName(name) : ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  props.setProperty('DATA_SHEET_ID', ss.getId());
  return ss;
}

/** A table's tab, created (with headers) the first time a newer table is used. */
function sheet_(name) {
  var ss = db_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < TABLES[name].length) {
    // A column was added to this table since the tab was created: extend the header row.
    sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
  }
  return sh;
}

/** All rows of a table as objects (strings), plus their sheet row numbers. */
function readTable_(name) {
  var sh = sheet_(name);
  var cols = TABLES[name];
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map(function (row, i) {
    var obj = { _row: i + 2 };
    cols.forEach(function (c, j) { obj[c] = String(row[j]); });
    return obj;
  }).filter(function (o) { return o.id; });
}

function rowValues_(name, obj) {
  return TABLES[name].map(function (c) { return obj[c] == null ? '' : String(obj[c]); });
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, TABLES[name].length).setNumberFormat('@').setValues([rowValues_(name, obj)]);
}

function writeRow_(name, obj) {
  sheet_(name).getRange(obj._row, 1, 1, TABLES[name].length).setValues([rowValues_(name, obj)]);
}

/** Delete rows bottom-up so earlier row numbers stay valid. */
function deleteRows_(name, rows) {
  var sh = sheet_(name);
  rows.map(function (r) { return r._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (r) { sh.deleteRow(r); });
}

function find_(rows, id, what) {
  for (var i = 0; i < rows.length; i++) if (rows[i].id === String(id)) return rows[i];
  throw new Error(what + ' not found');
}

function cleanText_(v, max, what) {
  var s = String(v == null ? '' : v).trim();
  if (!s) throw new Error(what + ' is required');
  if (s.length > max) throw new Error(what + ' is too long');
  return s;
}

function stamp_(obj, email) {
  obj.updatedAt = String(Date.now());
  obj.updatedBy = email;
  return obj;
}

// ---------- read ----------

function getData_() {
  var items = readTable_('Items');
  var lists = readTable_('Lists')
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (l) {
      return {
        id: l.id,
        name: l.name,
        updatedAt: Number(l.updatedAt),
        updatedBy: l.updatedBy,
        items: items
          .filter(function (it) { return it.listId === l.id; })
          .sort(function (a, b) { return Number(a.order) - Number(b.order); })
          .map(function (it) {
            return {
              id: it.id, text: it.text, done: it.done === 'true',
              updatedAt: Number(it.updatedAt), updatedBy: it.updatedBy
            };
          })
      };
    });
  var notes = readTable_('Notes').map(function (n) {
    return {
      id: n.id, title: n.title, body: n.body, pinned: n.pinned === 'true',
      updatedAt: Number(n.updatedAt), updatedBy: n.updatedBy
    };
  });
  return { lists: lists, notes: notes };
}

// ---------- write ----------

function mutateData_(d, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    applyDataAction_(d, email);
  } finally {
    lock.releaseLock();
  }
  return getData_();
}

/** Append several items to a list in one sheet write. */
function addItems_(listId, texts, email) {
  if (texts.length > 50) throw new Error('Too many items at once');
  var existing = readTable_('Items').filter(function (it) { return it.listId === listId; });
  var order = existing.length
    ? Math.max.apply(null, existing.map(function (r) { return Number(r.order) || 0; })) + 1 : 0;
  var rows = texts.map(function (t, i) {
    return rowValues_('Items', stamp_({
      id: Utilities.getUuid(), listId: listId,
      text: cleanText_(t, MAX_TEXT, 'Item'), done: 'false', order: order + i
    }, email));
  });
  var sh = sheet_('Items');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABLES.Items.length).setNumberFormat('@').setValues(rows);
}

function applyDataAction_(d, email) {
  var rows, row;
  switch (d.action) {

    // ----- lists -----
    case 'list.create':   // optional items: [...] (voice: "...and add milk, eggs")
      rows = readTable_('Lists');
      var listId = Utilities.getUuid();
      appendRow_('Lists', stamp_({
        id: listId,
        name: cleanText_(d.name, MAX_TEXT, 'List name'),
        order: rows.length ? Math.max.apply(null, rows.map(function (r) { return Number(r.order) || 0; })) + 1 : 0
      }, email));
      if (d.items && d.items.length) addItems_(listId, d.items, email);
      return;

    case 'list.rename':
      row = find_(readTable_('Lists'), d.id, 'List');
      row.name = cleanText_(d.name, MAX_TEXT, 'List name');
      writeRow_('Lists', stamp_(row, email));
      return;

    case 'list.delete':
      row = find_(readTable_('Lists'), d.id, 'List');
      deleteRows_('Items', readTable_('Items').filter(function (it) { return it.listId === row.id; }));
      deleteRows_('Lists', [row]);
      return;

    case 'list.clearDone':
      find_(readTable_('Lists'), d.id, 'List');
      deleteRows_('Items', readTable_('Items').filter(function (it) {
        return it.listId === String(d.id) && it.done === 'true';
      }));
      return;

    // ----- items -----
    case 'item.add':   // { listId, text } or { listId, texts: [...] }
      find_(readTable_('Lists'), d.listId, 'List');
      addItems_(String(d.listId), d.texts || [d.text], email);
      return;

    case 'item.updateMany':   // { ids: [...], done: bool }  (voice: "check off milk and eggs")
      rows = readTable_('Items');
      (d.ids || []).forEach(function (id) {
        row = find_(rows, id, 'Item');
        row.done = String(d.done === true);
        writeRow_('Items', stamp_(row, email));
      });
      return;

    case 'item.deleteMany':   // { ids: [...] }
      rows = readTable_('Items');
      deleteRows_('Items', (d.ids || []).map(function (id) { return find_(rows, id, 'Item'); }));
      return;

    case 'item.update':
      row = find_(readTable_('Items'), d.id, 'Item');
      if (d.text != null) row.text = cleanText_(d.text, MAX_TEXT, 'Item');
      if (d.done != null) row.done = String(d.done === true);
      writeRow_('Items', stamp_(row, email));
      return;

    case 'item.delete':
      deleteRows_('Items', [find_(readTable_('Items'), d.id, 'Item')]);
      return;

    // ----- notes -----
    case 'note.create':
      appendRow_('Notes', stamp_({
        id: Utilities.getUuid(),
        title: cleanText_(d.title, MAX_TEXT, 'Note title'),
        body: String(d.body || '').slice(0, MAX_BODY),
        pinned: String(d.pinned === true)
      }, email));
      return;

    case 'note.update':
      row = find_(readTable_('Notes'), d.id, 'Note');
      if (d.title != null) row.title = cleanText_(d.title, MAX_TEXT, 'Note title');
      if (d.body != null) row.body = String(d.body).slice(0, MAX_BODY);
      if (d.pinned != null) row.pinned = String(d.pinned === true);
      writeRow_('Notes', stamp_(row, email));
      return;

    case 'note.delete':
      deleteRows_('Notes', [find_(readTable_('Notes'), d.id, 'Note')]);
      return;
  }
  throw new Error('Unknown action');
}

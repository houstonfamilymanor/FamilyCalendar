/**
 * Event tags: labels the family makes up (e.g. "Lunch menu", "Sports") that can be put
 * on calendar events, so the page can show or hide them with filter chips.
 *
 *   Tags       id | name | color | hidden | order
 *              hidden = "true": a detail tag, kept off the calendar until someone turns it on
 *   EventTags  id (calendar event id) | tags (tag ids, comma-separated) | updatedAt
 *
 * Kept in the data Sheet rather than on the Google Calendar event, so it's one fast read
 * for a whole month/year and repeating events can be tagged too (the tag covers the series).
 */

var TAG_COLORS = ['#e57373', '#f2a65a', '#e6c84f', '#7cc576', '#4fb3bf', '#6c8ef5', '#a77bd8', '#d97aa6', '#8d9aa8'];
var MAX_TAGS = 60;

function getTags_() {
  return readTable_('Tags')
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (t) { return { id: t.id, name: t.name, color: t.color, hidden: t.hidden === 'true' }; });
}

/** eventId -> [tagId, ...] for every tagged event. */
function eventTagMap_() {
  var map = {};
  readTable_('EventTags').forEach(function (r) {
    var ids = r.tags ? r.tags.split(',').filter(String) : [];
    if (ids.length) map[r.id] = ids;
  });
  return map;
}

/** Set one event's tags (an empty list removes the row). Caller holds the lock. */
function setEventTags_(eventId, tagIds) {
  eventId = String(eventId || '');
  if (!eventId) throw new Error('Event id is required');
  var known = {};
  readTable_('Tags').forEach(function (t) { known[t.id] = true; });
  var clean = [];
  (tagIds || []).forEach(function (id) {
    id = String(id);
    if (known[id] && clean.indexOf(id) < 0) clean.push(id);
  });
  var row = readTable_('EventTags').filter(function (r) { return r.id === eventId; })[0];
  if (!clean.length) {
    if (row) deleteRows_('EventTags', [row]);
    return;
  }
  var obj = { id: eventId, tags: clean.join(','), updatedAt: String(Date.now()) };
  if (row) { obj._row = row._row; writeRow_('EventTags', obj); }
  else appendRow_('EventTags', obj);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/**
 * tags.save   { rows: [{ id?, name, color, hidden }] } replaces the tag list (keeps ids of
 *             existing tags; tags left out are deleted and taken off every event)
 * event.tags  { id, tags: [tagId, ...] } tags one event (works for repeating events too)
 */
function mutateTags_(d) {
  return withLock_(function () {
    if (d.action === 'tags.save') {
      var existing = {};
      readTable_('Tags').forEach(function (t) { existing[t.id] = t; });
      var seen = {};
      var rows = (d.rows || []).slice(0, MAX_TAGS).map(function (r, i) {
        var name = cleanText_(r.name, 60, 'Tag name');
        var key = name.toLowerCase();
        if (seen[key]) throw new Error('Two tags are both called "' + name + '"');
        seen[key] = true;
        var id = r.id && existing[r.id] ? String(r.id) : Utilities.getUuid().slice(0, 8);
        var color = /^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : TAG_COLORS[i % TAG_COLORS.length];
        return rowValues_('Tags', { id: id, name: name, color: color, hidden: String(r.hidden === true), order: i });
      });
      var keep = {};
      rows.forEach(function (r) { keep[r[0]] = true; });
      var sh = sheet_('Tags');
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABLES.Tags.length).clearContent();
      if (rows.length) sh.getRange(2, 1, rows.length, TABLES.Tags.length).setNumberFormat('@').setValues(rows);

      // Take deleted tags off events.
      var gone = Object.keys(existing).filter(function (id) { return !keep[id]; });
      if (gone.length) {
        var drop = [];
        readTable_('EventTags').forEach(function (r) {
          var left = r.tags.split(',').filter(function (id) { return id && keep[id]; });
          if (left.join(',') === r.tags) return;
          if (left.length) { r.tags = left.join(','); writeRow_('EventTags', r); }
          else drop.push(r);
        });
        deleteRows_('EventTags', drop);
      }
      return { tags: getTags_() };
    }
    if (d.action === 'event.tags') {
      setEventTags_(d.id, d.tags);
      return { status: 'success' };
    }
    throw new Error('Unknown action');
  });
}

/**
 * Kids' schools: for each kid, the family pastes their school's website link (and,
 * optionally, the district's letter-day calendar link). From those the server reads,
 * a few times a day and with no AI:
 *
 *   - the school's lunch menu      (the menu feed the school's Dining page loads)
 *   - the school's own events      (that school's events feed, not the district's)
 *   - the letter-day rotation      (a public Google Calendar, read as iCal)
 *
 * Nothing goes on Google Calendar; the page shows these under per-kid filter chips.
 * Names and links live only in the data Sheet, never in this public file.
 *
 *   Kids          id | name | site | menuFeed | eventsFeed | letterCal | letterMeanings |
 *                 lastTry | lastOk | error (JSON {lunch, events, letters}) | order
 *   Lunch         id (feed|date) | feed | date | breakfast | lunch | fetchedAt
 *   SchoolEvents  id (feed|eventId) | feed | title | start | end | allDay | fetchedAt
 *   LetterDays    id (cal|date) | cal | date | label | fetchedAt
 *
 * Refreshed by the 15-minute mail trigger (each kid at most every SCHOOL_REFRESH_HOURS),
 * on Save and on "Check now". Page loads never wait on the school sites.
 */

var SCHOOL_REFRESH_HOURS = 6;
var SCHOOL_KEEP_PAST_DAYS = 14;
var SCHOOL_AHEAD_DAYS = 120;
var SCHOOL_STALE_DAYS = 3;      // no successful read for this long = show the troubleshooting note
var FEED_HOST = 'https://thrillshare-cmsv2.services.thrillshare.com';

// ---------- links -> feeds ----------

/**
 * The school's website (any page of it) -> { menuFeed, eventsFeed }. Either can be ''
 * if the site doesn't have one. Throws a plain-language error when it has neither.
 */
function schoolFeeds_(input) {
  var s = String(input || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(s)) throw new Error('Paste the school website link (it starts with https://)');
  var res = UrlFetchApp.fetch(s, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('That page didn\'t open (error ' + res.getResponseCode() + ')');
  var html = res.getContentText();
  var menus = /\/api\/v2\/s\/(\d+)\/menus/.exec(html);
  var events = /\/api\/v2\/s\/(\d+)\/events/.exec(html);
  if (!menus && !events) throw new Error('No menu or events found on that page. Try the school\'s Dining page.');
  return {
    menuFeed: menus ? FEED_HOST + '/api/v2/s/' + menus[1] + '/menus' : '',
    eventsFeed: events ? FEED_HOST + '/api/v2/s/' + events[1] + '/events' : ''
  };
}

/**
 * A Google Calendar "subscribe" link (…?cid=<id>, sometimes base64), a calendar id, or an
 * .ics link -> the public iCal URL. '' stays ''.
 */
function letterCalUrl_(input) {
  var s = String(input || '').trim();
  if (!s) return '';
  if (/\.ics(\?|$)/i.test(s) && /^https:\/\//i.test(s)) return s;
  var id = s;
  var cid = /[?&]cid=([^&#]+)/.exec(s);
  if (cid) {
    id = decodeURIComponent(cid[1]);
    if (id.indexOf('@') < 0) {
      try { id = Utilities.newBlob(Utilities.base64Decode(id)).getDataAsString(); } catch (e) { /* not base64 */ }
    }
  }
  if (!/^[\w.\-]+@[\w.\-]+$/.test(id)) throw new Error('That doesn\'t look like a calendar link. Use the "subscribe" button link.');
  return 'https://calendar.google.com/calendar/ical/' + encodeURIComponent(id) + '/public/basic.ics';
}

// ---------- reading feeds ----------

function getJson_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('error ' + res.getResponseCode());
  return JSON.parse(res.getContentText());
}

/** { date: { breakfast, lunch } } */
function fetchMenus_(url) {
  var days = {};
  for (var page = 1; page <= 6; page++) {
    var list = getJson_(url + '?locale=en&page_no=' + page).menus;
    if (!Array.isArray(list)) throw new Error('the menu feed changed shape');
    if (!list.length) break;
    list.forEach(function (d) {
      var date = String(d.name || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        days[date] = { breakfast: String(d.breakfast || '').slice(0, 3000), lunch: String(d.lunch || '').slice(0, 3000) };
      }
    });
  }
  if (!Object.keys(days).length) throw new Error('the menu feed is empty');
  return days;
}

/** [{ id, title, start, end, allDay }] from today to SCHOOL_AHEAD_DAYS (feed is oldest-first from today). */
function fetchSchoolEvents_(url) {
  var until = new Date(Date.now() + SCHOOL_AHEAD_DAYS * DAY_MS).toISOString();
  var out = [];
  for (var page = 1; page <= 8; page++) {
    var list = getJson_(url + '?locale=en&page_no=' + page).events;
    if (!Array.isArray(list)) throw new Error('the events feed changed shape');
    if (!list.length) break;
    var past = false;
    list.forEach(function (e) {
      var start = new Date(e.start_at);
      if (isNaN(start)) return;
      if (start.toISOString() > until) { past = true; return; }
      var end = new Date(e.end_at);
      out.push({
        id: String(e.id), title: String(e.title || '').trim().slice(0, 300),
        start: start.toISOString(), end: isNaN(end) ? start.toISOString() : end.toISOString(),
        allDay: e.all_day === true,
        // all-day events carry the school's local date in the first 10 characters
        date: String(e.start_at).slice(0, 10), endDate: String(e.end_at || e.start_at).slice(0, 10)
      });
    });
    if (past) break;
  }
  return out;
}

/** { date: label } for the iCal feed, from SCHOOL_KEEP_PAST_DAYS ago to SCHOOL_AHEAD_DAYS ahead. */
function fetchLetterDays_(url) {
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('error ' + res.getResponseCode() + ' (is the calendar public?)');
  var text = res.getContentText().replace(/\r?\n[ \t]/g, '');       // unfold long lines
  var tz = Session.getScriptTimeZone();
  var from = Utilities.formatDate(new Date(Date.now() - SCHOOL_KEEP_PAST_DAYS * DAY_MS), tz, 'yyyyMMdd');
  var to = Utilities.formatDate(new Date(Date.now() + SCHOOL_AHEAD_DAYS * DAY_MS), tz, 'yyyyMMdd');
  var days = {};
  text.split('BEGIN:VEVENT').slice(1).forEach(function (ev) {
    var dt = /\nDTSTART[^:\n]*:(\d{8})/.exec('\n' + ev);
    var sum = /\nSUMMARY:([^\r\n]*)/.exec('\n' + ev);
    if (!dt || !sum || dt[1] < from || dt[1] > to) return;
    if (/\nSTATUS:CANCELLED/.test('\n' + ev)) return;
    var date = dt[1].slice(0, 4) + '-' + dt[1].slice(4, 6) + '-' + dt[1].slice(6, 8);
    days[date] = sum[1].replace(/\\,/g, ',').trim().slice(0, 100);
  });
  if (!Object.keys(days).length) throw new Error('no days found in that calendar');
  return days;
}

// ---------- sync ----------

/** Write `fresh` rows for the feeds that were read; keep other rows; drop rows of unused feeds. */
function replaceFeedRows_(table, feedCol, fresh, readFeeds, usedFeeds, cutoff, today) {
  var keep = readTable_(table).filter(function (r) {
    if (!usedFeeds[r[feedCol]]) return false;                       // nobody uses this feed any more
    if (r.date && r.date < cutoff) return false;                    // too old
    if (readFeeds[r[feedCol]] && (!r.date || r.date >= today)) return false;   // replaced by this read
    return true;
  });
  var rows = keep.concat(fresh).sort(function (a, b) { return a.id < b.id ? -1 : 1; })
    .map(function (r) { return rowValues_(table, r); });
  var sh = sheet_(table);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABLES[table].length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, TABLES[table].length).setNumberFormat('@').setValues(rows);
}

/**
 * Re-read feeds for kids not refreshed in SCHOOL_REFRESH_HOURS (all when force).
 * Feeds two kids share are read once. Fetching happens outside the lock.
 */
function syncSchools_(force) {
  var now = Date.now();
  var kids = readTable_('Kids');
  var due = kids.filter(function (k) { return force || now - Number(k.lastTry || 0) >= SCHOOL_REFRESH_HOURS * 3600000; });
  if (!due.length) return;

  var results = { menu: {}, events: {}, letters: {} };     // feed -> { data } | { error }
  function read(kind, url, fn) {
    if (!url || results[kind][url]) return;
    try { results[kind][url] = { data: fn(url) }; }
    catch (err) { results[kind][url] = { error: String(err.message || err).slice(0, 200) }; }
  }
  due.forEach(function (k) {
    read('menu', k.menuFeed, fetchMenus_);
    read('events', k.eventsFeed, fetchSchoolEvents_);
    read('letters', k.letterCal, fetchLetterDays_);
  });

  withLock_(function () {
    var stamp = String(Date.now());
    var tz = Session.getScriptTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var cutoff = Utilities.formatDate(new Date(now - SCHOOL_KEEP_PAST_DAYS * DAY_MS), tz, 'yyyy-MM-dd');
    var current = readTable_('Kids');
    var used = { menu: {}, events: {}, letters: {} };
    current.forEach(function (k) {
      if (k.menuFeed) used.menu[k.menuFeed] = true;
      if (k.eventsFeed) used.events[k.eventsFeed] = true;
      if (k.letterCal) used.letters[k.letterCal] = true;
      if (!due.some(function (d) { return d.id === k.id; })) return;
      var err = {};
      [['lunch', 'menu', k.menuFeed], ['events', 'events', k.eventsFeed], ['letters', 'letters', k.letterCal]].forEach(function (p) {
        var r = p[2] && results[p[1]][p[2]];
        if (r && r.error) err[p[0]] = r.error;
      });
      k.lastTry = stamp;
      k.error = Object.keys(err).length ? JSON.stringify(err) : '';
      if (!k.error) k.lastOk = stamp;
      writeRow_('Kids', k);
    });

    function ok(kind) {
      var read = {};
      Object.keys(results[kind]).forEach(function (u) { if (results[kind][u].data) read[u] = true; });
      return read;
    }
    var lunch = [], events = [], letters = [];
    Object.keys(results.menu).forEach(function (u) {
      var days = results.menu[u].data;
      if (days) Object.keys(days).forEach(function (date) {
        if (date >= today) lunch.push({ id: u + '|' + date, feed: u, date: date, breakfast: days[date].breakfast, lunch: days[date].lunch, fetchedAt: stamp });
      });
    });
    Object.keys(results.events).forEach(function (u) {
      (results.events[u].data || []).forEach(function (e) {
        events.push({ id: u + '|' + e.id, feed: u, title: e.title, start: e.allDay ? e.date : e.start,
          end: e.allDay ? e.endDate : e.end, allDay: String(e.allDay), date: e.date, fetchedAt: stamp });
      });
    });
    Object.keys(results.letters).forEach(function (u) {
      var days = results.letters[u].data;
      if (days) Object.keys(days).forEach(function (date) {
        if (date >= today) letters.push({ id: u + '|' + date, cal: u, date: date, label: days[date], fetchedAt: stamp });
      });
    });
    replaceFeedRows_('Lunch', 'feed', lunch, ok('menu'), used.menu, cutoff, today);
    replaceFeedRows_('SchoolEvents', 'feed', events, ok('events'), used.events, cutoff, today);
    replaceFeedRows_('LetterDays', 'cal', letters, ok('letters'), used.letters, cutoff, today);
  });
}

/** Refresh what's due. Never throws (errors are kept per kid). */
function refreshSchoolsIfStale_() {
  try { syncSchools_(false); } catch (e) { /* e.g. lock busy: next run catches up */ }
}

/**
 * What the page shows. Only reads the Sheet, never the school sites, so page loads stay
 * fast; the feeds are re-read by the 15-minute trigger, Save and "Check now".
 */
function getSchools_() {
  var kids = readTable_('Kids')
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (k) {
      var err = {};
      try { err = k.error ? JSON.parse(k.error) : {}; } catch (e) { err = { lunch: k.error }; }
      var lastOk = Number(k.lastOk || 0);
      if (!Object.keys(err).length && Date.now() - lastOk > SCHOOL_STALE_DAYS * DAY_MS) {
        var why = lastOk ? 'hasn\'t updated in over ' + SCHOOL_STALE_DAYS + ' days' : 'not read yet';
        if (k.menuFeed) err.lunch = why;
        if (k.eventsFeed || k.letterCal) err.events = why;
      }
      return {
        id: k.id, name: k.name, site: k.site, letterCal: k.letterCal, letterMeanings: k.letterMeanings,
        hasLunch: !!k.menuFeed, hasEvents: !!k.eventsFeed, hasLetters: !!k.letterCal,
        menuFeed: k.menuFeed, eventsFeed: k.eventsFeed, errors: err, lastOk: lastOk
      };
    });
  return {
    kids: kids,
    lunch: readTable_('Lunch').map(function (r) { return { feed: r.feed, date: r.date, breakfast: r.breakfast, lunch: r.lunch }; }),
    events: readTable_('SchoolEvents').map(function (r) {
      return { feed: r.feed, id: r.id, title: r.title, start: r.start, end: r.end, allDay: r.allDay === 'true' };
    }),
    letters: readTable_('LetterDays').map(function (r) { return { cal: r.cal, date: r.date, label: r.label }; })
  };
}

/**
 * school.save  { rows: [{ id?, name, site, letterCal, letterMeanings }] } replaces the list;
 *              new or changed links are checked (readable errors) and read right away
 * school.sync  re-reads everything now
 */
function mutateSchools_(d) {
  if (d.action === 'school.save') {
    var existing = {};
    readTable_('Kids').forEach(function (k) { existing[k.id] = k; });
    var rows = (d.rows || []).slice(0, 10).map(function (r, i) {
      var name = cleanText_(r.name, 40, 'Name');
      var old = r.id && existing[r.id];
      var site = String(r.site || '').trim();
      var feeds = old && site === old.site ? { menuFeed: old.menuFeed, eventsFeed: old.eventsFeed } : schoolFeeds_(site);
      var cal = String(r.letterCal || '').trim();
      var letterCal = old && cal === old.letterCal ? old.letterCal : letterCalUrl_(cal);
      var same = old && site === old.site && letterCal === old.letterCal;
      return {
        id: old ? old.id : Utilities.getUuid().slice(0, 8), name: name, site: site,
        menuFeed: feeds.menuFeed, eventsFeed: feeds.eventsFeed, letterCal: letterCal,
        letterMeanings: String(r.letterMeanings || '').trim().slice(0, 300),
        lastTry: same ? old.lastTry : '', lastOk: same ? old.lastOk : '', error: same ? old.error : '',
        order: i
      };
    });
    withLock_(function () {
      var sh = sheet_('Kids');
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABLES.Kids.length).clearContent();
      if (rows.length) sh.getRange(2, 1, rows.length, TABLES.Kids.length).setNumberFormat('@')
        .setValues(rows.map(function (r) { return rowValues_('Kids', r); }));
    });
    syncSchools_(false);             // reads new/changed kids now (never tried yet)
    withLock_(function () {          // and drops data for feeds nobody uses any more
      var used = { feed: {}, cal: {} };
      readTable_('Kids').forEach(function (k) {
        used.feed[k.menuFeed] = used.feed[k.eventsFeed] = true;
        used.cal[k.letterCal] = true;
      });
      [['Lunch', 'feed'], ['SchoolEvents', 'feed'], ['LetterDays', 'cal']].forEach(function (t) {
        var all = readTable_(t[0]);
        var left = all.filter(function (r) { return used[t[1]][r[t[1]]]; });
        if (left.length === all.length) return;
        var sh = sheet_(t[0]);
        sh.getRange(2, 1, all.length, TABLES[t[0]].length).clearContent();
        if (left.length) sh.getRange(2, 1, left.length, TABLES[t[0]].length).setNumberFormat('@')
          .setValues(left.map(function (r) { return rowValues_(t[0], r); }));
      });
    });
  } else if (d.action === 'school.sync') {
    syncSchools_(true);
  } else {
    throw new Error('Unknown action');
  }
  return getSchools_();
}

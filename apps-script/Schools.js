/**
 * Kids' schools: for each kid, the family pastes their school's website link (and,
 * optionally, the district's letter-day calendar link). From those the server reads,
 * with no AI:
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
 *   SchoolEvents  id (feed|eventId) | feed | title | start | end | allDay | date | fetchedAt
 *   LetterDays    id (cal|date) | cal | date | label | fetchedAt
 *
 * The school sites are NEVER read inside a page request (Apps Script can't time out a
 * slow fetch, and one stuck request used to freeze the app). Reading happens in the
 * background: a one-off trigger right after Save / "Check now", and an hourly trigger
 * (each kid at most every SCHOOL_REFRESH_HOURS). All feeds are fetched in parallel, and
 * each run's start/end/duration is kept so the page can show progress or a stuck run.
 */

var SCHOOL_REFRESH_HOURS = 6;
var SCHOOL_KEEP_PAST_DAYS = 14;
var SCHOOL_AHEAD_DAYS = 120;
var SCHOOL_STALE_DAYS = 3;      // no successful read for this long = show the troubleshooting note
var SCHOOL_STUCK_MINUTES = 8;   // a background run older than this never finished
var MENU_PAGES = 4;
var EVENT_PAGES = 6;
var FEED_HOST = 'https://thrillshare-cmsv2.services.thrillshare.com';

// ---------- links -> feeds ----------

/** The school site's HTML -> { menuFeed, eventsFeed } ('' when the page doesn't have one). */
function feedsFromHtml_(html) {
  var menus = /\/api\/v2\/s\/(\d+)\/menus/.exec(html);
  var events = /\/api\/v2\/s\/(\d+)\/events/.exec(html);
  return {
    menuFeed: menus ? FEED_HOST + '/api/v2/s/' + menus[1] + '/menus' : '',
    eventsFeed: events ? FEED_HOST + '/api/v2/s/' + events[1] + '/events' : ''
  };
}

/**
 * A Google Calendar "subscribe" link (…?cid=<id>, sometimes base64), a calendar id, or an
 * .ics link -> the public iCal URL. '' stays ''. No network call.
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

// ---------- fetching (all in parallel) ----------

/** url -> { code, text } or { error }. One parallel round trip; falls back to one-by-one. */
function readAll_(urls) {
  var out = {};
  if (!urls.length) return out;
  var reqs = urls.map(function (u) { return { url: u, muteHttpExceptions: true, followRedirects: true }; });
  try {
    UrlFetchApp.fetchAll(reqs).forEach(function (res, i) {
      out[urls[i]] = { code: res.getResponseCode(), text: res.getContentText() };
    });
  } catch (e) {
    urls.forEach(function (u) {
      try {
        var res = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true });
        out[u] = { code: res.getResponseCode(), text: res.getContentText() };
      } catch (err) {
        out[u] = { error: String(err.message || err).slice(0, 150) };
      }
    });
  }
  return out;
}

function pageUrl_(feed, page) { return feed + '?locale=en&page_no=' + page; }

/** JSON list from a response, or throws a short readable error. */
function listFrom_(r, key, what) {
  if (!r) throw new Error('no answer from the ' + what + ' feed');
  if (r.error) throw new Error(r.error);
  if (r.code !== 200) throw new Error('the ' + what + ' feed answered with error ' + r.code);
  var list = JSON.parse(r.text)[key];
  if (!Array.isArray(list)) throw new Error('the ' + what + ' feed changed shape');
  return list;
}

/** { date: { breakfast, lunch } } */
function parseMenus_(responses) {
  var days = {};
  responses.forEach(function (r) {
    listFrom_(r, 'menus', 'menu').forEach(function (d) {
      var date = String(d.name || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        days[date] = { breakfast: String(d.breakfast || '').slice(0, 3000), lunch: String(d.lunch || '').slice(0, 3000) };
      }
    });
  });
  if (!Object.keys(days).length) throw new Error('the menu feed is empty');
  return days;
}

/** [{ id, title, start, end, allDay, date, endDate }] from today to SCHOOL_AHEAD_DAYS. */
function parseSchoolEvents_(responses) {
  var until = new Date(Date.now() + SCHOOL_AHEAD_DAYS * DAY_MS).toISOString();
  var out = [], seen = {};
  responses.forEach(function (r) {
    listFrom_(r, 'events', 'events').forEach(function (e) {
      var start = new Date(e.start_at);
      if (isNaN(start) || start.toISOString() > until || seen[e.id]) return;
      seen[e.id] = true;
      var end = new Date(e.end_at);
      out.push({
        id: String(e.id), title: String(e.title || '').trim().slice(0, 300),
        start: start.toISOString(), end: isNaN(end) ? start.toISOString() : end.toISOString(),
        allDay: e.all_day === true,
        // all-day events carry the school's local date in the first 10 characters
        date: String(e.start_at).slice(0, 10), endDate: String(e.end_at || e.start_at).slice(0, 10)
      });
    });
  });
  return out;
}

/** { date: label } from the iCal text, SCHOOL_KEEP_PAST_DAYS ago to SCHOOL_AHEAD_DAYS ahead. */
function parseLetterDays_(r) {
  if (!r) throw new Error('no answer from the letter-day calendar');
  if (r.error) throw new Error(r.error);
  if (r.code !== 200) throw new Error('error ' + r.code + ' (is the calendar public?)');
  var text = r.text.replace(/\r?\n[ \t]/g, '');       // unfold long lines
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

// ---------- sync (background only) ----------

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
 * Re-read feeds for kids not refreshed in SCHOOL_REFRESH_HOURS (all when force). Kids
 * whose school link is new are first looked up to find their feeds. Feeds two kids share
 * are read once; everything is fetched in two parallel rounds (sites, then feeds).
 */
function syncSchools_(force) {
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  var kids = readTable_('Kids');
  var due = kids.filter(function (k) {
    return force || !k.lastTry || now - Number(k.lastTry) >= SCHOOL_REFRESH_HOURS * 3600000;
  });
  if (!due.length) return;
  props.setProperty('SCHOOL_RUN_START', String(now));

  // Round 1: school sites whose feeds aren't known yet.
  var siteErr = {};
  var lookup = due.filter(function (k) { return k.site && !k.menuFeed && !k.eventsFeed; });
  var sites = readAll_(lookup.map(function (k) { return k.site; }).filter(function (u, i, a) { return a.indexOf(u) === i; }));
  lookup.forEach(function (k) {
    var r = sites[k.site];
    var f = r && !r.error && r.code === 200 ? feedsFromHtml_(r.text) : null;
    if (f && (f.menuFeed || f.eventsFeed)) { k.menuFeed = f.menuFeed; k.eventsFeed = f.eventsFeed; }
    else siteErr[k.id] = !r ? 'the school page didn\'t answer' : r.error ? r.error
      : r.code !== 200 ? 'the school page answered with error ' + r.code
      : 'no menu or events found on that page (try the school\'s Dining page)';
  });

  // Round 2: every feed page at once.
  var urls = [];
  var add = function (u) { if (u && urls.indexOf(u) < 0) urls.push(u); };
  due.forEach(function (k) {
    for (var p = 1; p <= MENU_PAGES; p++) if (k.menuFeed) add(pageUrl_(k.menuFeed, p));
    for (var q = 1; q <= EVENT_PAGES; q++) if (k.eventsFeed) add(pageUrl_(k.eventsFeed, q));
    add(k.letterCal);
  });
  var got = readAll_(urls);
  var pages = function (feed, n) { var a = []; for (var i = 1; i <= n; i++) a.push(got[pageUrl_(feed, i)]); return a; };

  var results = { menu: {}, events: {}, letters: {} };     // feed -> { data } | { error }
  function parse(kind, feed, fn) {
    if (!feed || results[kind][feed]) return;
    try { results[kind][feed] = { data: fn(feed) }; }
    catch (err) { results[kind][feed] = { error: String(err.message || err).slice(0, 200) }; }
  }
  due.forEach(function (k) {
    parse('menu', k.menuFeed, function (f) { return parseMenus_(pages(f, MENU_PAGES)); });
    parse('events', k.eventsFeed, function (f) { return parseSchoolEvents_(pages(f, EVENT_PAGES)); });
    parse('letters', k.letterCal, function (f) { return parseLetterDays_(got[f]); });
  });

  withLock_(function () {
    var stamp = String(Date.now());
    var tz = Session.getScriptTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var cutoff = Utilities.formatDate(new Date(now - SCHOOL_KEEP_PAST_DAYS * DAY_MS), tz, 'yyyy-MM-dd');
    var byId = {};
    due.forEach(function (k) { byId[k.id] = k; });
    var current = readTable_('Kids');
    var used = { menu: {}, events: {}, letters: {} };
    current.forEach(function (k) {
      var d = byId[k.id];
      if (d && d.site === k.site) { k.menuFeed = d.menuFeed; k.eventsFeed = d.eventsFeed; }   // found in round 1
      if (k.menuFeed) used.menu[k.menuFeed] = true;
      if (k.eventsFeed) used.events[k.eventsFeed] = true;
      if (k.letterCal) used.letters[k.letterCal] = true;
      if (!d) return;
      var err = {};
      if (siteErr[k.id]) err.lunch = err.events = siteErr[k.id];
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
  props.setProperty('SCHOOL_RUN_END', String(Date.now()));
  props.setProperty('SCHOOL_RUN_MS', String(Date.now() - now));
}

// ---------- background triggers ----------

/** One-off trigger handler: runs right after Save / "Check now". */
function syncSchoolsSoon() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSchoolsSoon') ScriptApp.deleteTrigger(t);
  });
  var props = PropertiesService.getScriptProperties();
  var force = props.getProperty('SCHOOL_FORCE') === '1';
  props.deleteProperty('SCHOOL_FORCE');
  props.deleteProperty('SCHOOL_QUEUED');
  syncSchools_(force);
}

/** Hourly trigger handler. */
function syncSchoolsHourly() {
  syncSchools_(false);
}

/** Ask for a background read in a few seconds (once; repeated asks share it). */
function queueSchoolSync_(force) {
  var props = PropertiesService.getScriptProperties();
  if (force) props.setProperty('SCHOOL_FORCE', '1');
  var queued = Number(props.getProperty('SCHOOL_QUEUED') || 0);
  var pending = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncSchoolsSoon'; });
  if (!pending || Date.now() - queued > SCHOOL_STUCK_MINUTES * 60000) {
    ScriptApp.newTrigger('syncSchoolsSoon').timeBased().after(1000).create();
  }
  props.setProperty('SCHOOL_QUEUED', String(Date.now()));
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncSchoolsHourly'; })) {
    ScriptApp.newTrigger('syncSchoolsHourly').timeBased().everyHours(1).create();
  }
}

// ---------- read / write for the page ----------

/** What the page shows. Only reads the Sheet, never the school sites, so page loads stay fast. */
function getSchools_() {
  var props = PropertiesService.getScriptProperties();
  var run = {
    queued: Number(props.getProperty('SCHOOL_QUEUED') || 0),
    start: Number(props.getProperty('SCHOOL_RUN_START') || 0),
    end: Number(props.getProperty('SCHOOL_RUN_END') || 0),
    ms: Number(props.getProperty('SCHOOL_RUN_MS') || 0)
  };
  run.running = run.start > run.end;
  run.stuck = run.running && Date.now() - run.start > SCHOOL_STUCK_MINUTES * 60000;
  run.waiting = !run.running && run.queued > run.end;
  var kids = readTable_('Kids')
    .sort(function (a, b) { return Number(a.order) - Number(b.order); })
    .map(function (k) {
      var err = {};
      try { err = k.error ? JSON.parse(k.error) : {}; } catch (e) { err = { lunch: k.error }; }
      var lastOk = Number(k.lastOk || 0);
      var why = run.stuck ? 'the school sites didn\'t answer the server' : '';
      if (!why && !Object.keys(err).length && k.lastTry && Date.now() - lastOk > SCHOOL_STALE_DAYS * DAY_MS) {
        why = 'hasn\'t updated in over ' + SCHOOL_STALE_DAYS + ' days';
      }
      if (why) { err.lunch = err.lunch || why; err.events = err.events || why; }
      return {
        id: k.id, name: k.name, site: k.site, letterCal: k.letterCal, letterMeanings: k.letterMeanings,
        hasLunch: !!k.menuFeed || !k.lastTry, hasEvents: !!k.eventsFeed || !k.lastTry, hasLetters: !!k.letterCal,
        pending: !k.lastTry, menuFeed: k.menuFeed, eventsFeed: k.eventsFeed, errors: err, lastOk: lastOk
      };
    });
  return {
    run: run,
    kids: kids,
    lunch: readTable_('Lunch').map(function (r) { return { feed: r.feed, date: r.date, breakfast: r.breakfast, lunch: r.lunch }; }),
    events: readTable_('SchoolEvents').map(function (r) {
      return { feed: r.feed, id: r.id, title: r.title, start: r.start, end: r.end, allDay: r.allDay === 'true' };
    }),
    letters: readTable_('LetterDays').map(function (r) { return { cal: r.cal, date: r.date, label: r.label }; })
  };
}

/**
 * school.save  { rows: [{ id?, name, site, letterCal, letterMeanings }] } replaces the list
 *              and queues a background read (returns right away)
 * school.sync  queues a background re-read of everything
 */
function mutateSchools_(d) {
  if (d.action === 'school.save') {
    var existing = {};
    readTable_('Kids').forEach(function (k) { existing[k.id] = k; });
    var rows = (d.rows || []).slice(0, 10).map(function (r, i) {
      var name = cleanText_(r.name, 40, 'Name');
      var old = r.id && existing[r.id];
      var site = String(r.site || '').trim();
      if (!/^https:\/\/[^\s]+$/i.test(site)) throw new Error(name + ': paste the school website link (it starts with https://)');
      var cal = String(r.letterCal || '').trim();
      var letterCal = old && cal === old.letterCal ? old.letterCal : letterCalUrl_(cal);
      var sameSite = old && site === old.site;
      var same = sameSite && letterCal === old.letterCal;
      return {
        id: old ? old.id : Utilities.getUuid().slice(0, 8), name: name, site: site,
        menuFeed: sameSite ? old.menuFeed : '', eventsFeed: sameSite ? old.eventsFeed : '',   // found in the background
        letterCal: letterCal, letterMeanings: String(r.letterMeanings || '').trim().slice(0, 300),
        lastTry: same ? old.lastTry : '', lastOk: same ? old.lastOk : '', error: same ? old.error : '',
        order: i
      };
    });
    withLock_(function () {
      var sh = sheet_('Kids');
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, TABLES.Kids.length).clearContent();
      if (rows.length) sh.getRange(2, 1, rows.length, TABLES.Kids.length).setNumberFormat('@')
        .setValues(rows.map(function (r) { return rowValues_('Kids', r); }));
      // Drop data for feeds nobody uses any more (a removed kid, a changed link).
      var used = { feed: {}, cal: {} };
      rows.forEach(function (k) { used.feed[k.menuFeed] = used.feed[k.eventsFeed] = true; used.cal[k.letterCal] = true; });
      [['Lunch', 'feed'], ['SchoolEvents', 'feed'], ['LetterDays', 'cal']].forEach(function (t) {
        var all = readTable_(t[0]);
        var left = all.filter(function (r) { return used[t[1]][r[t[1]]]; });
        if (left.length === all.length) return;
        var s = sheet_(t[0]);
        s.getRange(2, 1, all.length, TABLES[t[0]].length).clearContent();
        if (left.length) s.getRange(2, 1, left.length, TABLES[t[0]].length).setNumberFormat('@')
          .setValues(left.map(function (r) { return rowValues_(t[0], r); }));
      });
    });
    if (rows.some(function (r) { return !r.lastTry; })) queueSchoolSync_(false);
  } else if (d.action === 'school.sync') {
    queueSchoolSync_(true);
  } else {
    throw new Error('Unknown action');
  }
  return getSchools_();
}

/**
 * Family Calendar — Apps Script backend.
 * Runs as the family Google account (the deployer). Every request must carry
 * a Google ID token from the web page; the token's email must be on the
 * allowlist stored in Script Properties (kept out of the repo on purpose).
 *
 * Script Properties (Project Settings -> Script Properties):
 *   ALLOWED_EMAILS  comma-separated, e.g. "family@gmail.com,you@gmail.com"
 *   CALENDAR_ID     optional; defaults to the account's primary calendar
 *   DATA_SHEET_ID   set automatically: the "Family Command Data" spreadsheet
 *                   that holds notes and lists (see Data.js)
 */

var CLIENT_ID = '1078069358169-l17a312qdnd36rm3ucsjvsbugggb9gjj.apps.googleusercontent.com';
var LOOKAHEAD_DAYS = 7;        // default range when the page doesn't send one
var MAX_RANGE_DAYS = 400;      // enough for the year view, small enough to stay fast
var DAY_MS = 24 * 60 * 60 * 1000;
var TOKEN_CACHE_SECONDS = 300;

// ---------- One-time setup check (run from the editor) ----------

/**
 * Run this once from the Apps Script editor after changing scopes or settings.
 * It triggers the authorization prompt for every scope the app needs and
 * logs whether the server is configured.
 */
function checkSetup() {
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', { muteHttpExceptions: true });
  Logger.log('Calendar: ' + calendar_().getName());
  Logger.log('Allowed emails: ' + allowedEmails_().join(', '));
  Logger.log('Notes & lists sheet: ' + db_().getUrl());
  Logger.log('School mail sync trigger: ' + ensureMailTrigger_());
  Logger.log('School emails imported now: ' + syncMail_());
}

// ---------- HTTP entry points ----------

function doGet(e) {
  return handle_(e.parameter.auth, function () {
    if (e.parameter.what === 'data') return getData_();
    if (e.parameter.what === 'mail') return getMail_();
    return listEvents_(e.parameter.from, e.parameter.to);
  });
}

function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ error: 'Bad request body' });
  }
  return handle_(data.auth, function (email) {
    // "list.*", "item.*", "note.*" go to the notes & lists store (Data.js).
    if (/^(list|item|note)\./.test(data.action)) return mutateData_(data, email);
    // "mail.*", "roster.*", "rules.*" go to the school inbox (Mail.js).
    if (/^(mail|roster|rules)\./.test(data.action)) return mutateMail_(data);
    return mutate_(data);
  });
}

function handle_(token, fn) {
  try {
    var email = requireAllowedUser_(token);
    return json_(fn(email));
  } catch (err) {
    return json_({ error: err.message || String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Auth ----------

/** Throws unless the ID token is valid, for our client, and on the allowlist. */
function requireAllowedUser_(token) {
  if (!token) throw new Error('auth_missing');

  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var email = cache.get(key);

  if (!email) {
    var res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true });
    // tokeninfo returns non-200 for expired or forged tokens.
    if (res.getResponseCode() !== 200) throw new Error('auth_expired');

    var info = JSON.parse(res.getContentText());
    var issOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
    if (info.aud !== CLIENT_ID || !issOk || String(info.email_verified) !== 'true') {
      throw new Error('auth_invalid');
    }
    email = String(info.email).toLowerCase();
    cache.put(key, email, TOKEN_CACHE_SECONDS);
  }

  if (allowedEmails_().indexOf(email) < 0) throw new Error('not_allowed: ' + email);
  return email;
}

function allowedEmails_() {
  var raw = PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS');
  if (!raw) throw new Error('Server not configured: set ALLOWED_EMAILS in Script Properties');
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(String);
}

// ---------- Calendar ----------

function calendar_() {
  var id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  var cal = id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('Calendar not found: ' + id);
  return cal;
}

/**
 * Events overlapping [from, to). All-day events come back as "YYYY-MM-DD"
 * dates with an exclusive end (the same convention the calendar UI uses);
 * timed events come back as ISO timestamps.
 */
function listEvents_(fromStr, toStr) {
  var from = fromStr ? new Date(fromStr) : new Date();
  var to = toStr ? new Date(toStr) : new Date(from.getTime() + LOOKAHEAD_DAYS * DAY_MS);
  if (isNaN(from) || isNaN(to) || to <= from) throw new Error('Invalid date range');
  if (to - from > MAX_RANGE_DAYS * DAY_MS) throw new Error('Date range too large');

  var tz = Session.getScriptTimeZone();
  return calendar_().getEvents(from, to).map(function (ev) {
    var allDay = ev.isAllDayEvent();
    return {
      id: ev.getId(),
      title: ev.getTitle(),
      allDay: allDay,
      start: allDay ? Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd')
                    : ev.getStartTime().toISOString(),
      end: allDay ? Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd')
                  : ev.getEndTime().toISOString(),
      // getEventById() can't address a single occurrence of a repeating event,
      // so the page treats these as read-only.
      recurring: ev.isRecurringEvent()
    };
  });
}

function mutate_(data) {
  var cal = calendar_();

  if (data.action === 'create') {
    var times = parseTimes_(data);
    var created = times.allDay
      ? cal.createAllDayEvent(String(data.title), times.start, times.end)
      : cal.createEvent(String(data.title), times.start, times.end);
    return { status: 'success', id: created.getId() };
  }

  if (data.action === 'update' || data.action === 'delete') {
    var ev = data.id && cal.getEventById(data.id);
    if (!ev) throw new Error('Event not found');
    if (ev.isRecurringEvent()) throw new Error('Repeating events can only be changed in Google Calendar');
    if (data.action === 'delete') {
      ev.deleteEvent();
    } else {
      var t = parseTimes_(data);
      ev.setTitle(String(data.title));
      if (t.allDay) ev.setAllDayDates(t.start, t.end);
      else ev.setTime(t.start, t.end);
    }
    return { status: 'success' };
  }

  throw new Error('Unknown action');
}

/**
 * Timed events: ISO timestamps. All-day events: "YYYY-MM-DD" with an
 * exclusive end, built as local dates in the script's time zone.
 */
function parseTimes_(data) {
  if (!data.title) throw new Error('Title is required');
  var allDay = data.allDay === true;
  var start = allDay ? parseDate_(data.start) : new Date(data.start);
  var end = allDay ? parseDate_(data.end) : new Date(data.end);
  if (isNaN(start) || isNaN(end)) throw new Error('Invalid start or end time');
  if (allDay ? end <= start : end < start) throw new Error('End is before start');
  return { allDay: allDay, start: start, end: end };
}

function parseDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

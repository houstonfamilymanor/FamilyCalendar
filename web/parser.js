/**
 * Family Command — command parser.
 *
 * Turns a sentence (from speech recognition or typed) into a structured
 * command using keywords, with no AI involved. Pure functions, no DOM, so it
 * runs in the browser (window.FamilyParser) and in Node for tests.
 *
 * Keywords:
 *   create / make / new / start / add / schedule  -> make something
 *   event / list / note                           -> which kind of thing
 *   called / named / titled                       -> the name comes next
 *   add X to Y list / update Y list with X        -> list items
 *   check off X / cross off X / remove X from Y   -> change items
 *   stop / cancel / never mind | yes / no | done  -> conversation control
 */
(function (root) {
    "use strict";

    const MONTHS = {
        january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
        june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8,
        october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11
    };
    const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const SMALL = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const ORD_UNITS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 };
    const ORD_OTHER = {
        tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
        seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30
    };
    const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
    const WEEKDAY_RE = Object.keys(WEEKDAYS).join("|");
    const SMALL_RE = Object.keys(SMALL).join("|");
    const ORD_RE = [
        "(?:twenty|thirty)[- ](?:" + Object.keys(ORD_UNITS).join("|") + ")",
        ...Object.keys(ORD_OTHER), ...Object.keys(ORD_UNITS)
    ].join("|");
    // One clock time: "3", "3:30", "3pm", "3:30 pm", "3 o'clock", "noon", "midnight".
    const TOK = "(noon|midday|midnight|\\d{1,2}(?::\\d{2})?(?:\\s*(?:am|pm))?(?:\\s*o'?clock)?)";

    // ---------- small helpers ----------

    const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    const squash = s => String(s || "").replace(/\s+/g, " ").trim();
    const dayOnly = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

    function ordinalToNumber(word) {
        const w = word.toLowerCase().replace("-", " ");
        const m = /^(twenty|thirty) (\w+)$/.exec(w);
        if (m) return (m[1] === "twenty" ? 20 : 30) + ORD_UNITS[m[2]];
        return ORD_OTHER[w] || ORD_UNITS[w];
    }
    const suffix = n => (n % 10 === 1 && n !== 11) ? "st" : (n % 10 === 2 && n !== 12) ? "nd" : (n % 10 === 3 && n !== 13) ? "rd" : "th";

    /**
     * Make speech-recognition text regular without changing what it means:
     * "p.m." -> "pm", "sixteenth" -> "16th" (only in date-ish spots),
     * "at three thirty" -> "at 3:30".
     */
    function normalize(text) {
        let t = String(text || "").replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
        t = squash(t).replace(/[.!?]+$/, "");
        t = t.replace(/\b([ap])\.?\s?m\.?(?=[\s,]|$)/gi, (m, ap) => ap.toLowerCase() + "m");

        // Ordinal words where they're clearly dates: "November sixteenth", "the sixteenth", "sixteenth of".
        const ordToDigits = w => { const n = ordinalToNumber(w); return n + suffix(n); };
        t = t.replace(new RegExp(`\\b(${MONTH_RE})\\s+(the\\s+)?(${ORD_RE})\\b`, "gi"),
            (m, mo, the, o) => `${mo} ${the || ""}${ordToDigits(o)}`);
        t = t.replace(new RegExp(`\\bthe\\s+(${ORD_RE})\\b`, "gi"), (m, o) => `the ${ordToDigits(o)}`);
        t = t.replace(new RegExp(`\\b(${ORD_RE})\\s+of\\b`, "gi"), (m, o) => `${ordToDigits(o)} of`);

        // Spoken clock numbers: "at three", "three pm", "three thirty".
        t = t.replace(new RegExp(`\\b(at|from|to|until|till|by|around|and|between)\\s+(${SMALL_RE})\\b`, "gi"),
            (m, w, n) => `${w} ${SMALL[n.toLowerCase()]}`);
        t = t.replace(new RegExp(`\\b(${SMALL_RE})(\\s*)(am|pm|o'?clock)\\b`, "gi"),
            (m, n, sp, ap) => `${SMALL[n.toLowerCase()]}${sp}${ap}`);
        t = t.replace(/\b(\d{1,2})\s+(fifteen|thirty|forty[- ]?five|o'?clock)\b/gi, (m, h, w) => {
            const mins = /fifteen/i.test(w) ? "15" : /thirty/i.test(w) ? "30" : /forty/i.test(w) ? "45" : "00";
            return `${h}:${mins}`;
        });
        return squash(t);
    }

    /**
     * A cursor over the sentence: take(regex, fn) finds a match, lets fn accept
     * or reject it, and blanks the matched span (same length) so later
     * patterns don't see it and what's left over can become the title.
     */
    function cursor(text) {
        const st = { orig: text, low: text.toLowerCase() };
        st.take = (re, fn) => {
            const m = re.exec(st.low);
            if (!m) return false;
            if (fn && fn(m) === false) return false;
            const a = m.index, b = m.index + m[0].length, blank = " ".repeat(b - a);
            st.low = st.low.slice(0, a) + blank + st.low.slice(b);
            st.orig = st.orig.slice(0, a) + blank + st.orig.slice(b);
            return true;
        };
        return st;
    }

    // ---------- dates & times ----------

    function parseTok(tok) {
        tok = tok.trim();
        if (/noon|midday/.test(tok)) return { h: 12, m: 0, ap: "pm", explicit: true };
        if (/midnight/.test(tok)) return { h: 0, m: 0, ap: "am", explicit: true };
        const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(o'?clock)?$/.exec(tok);
        if (!m) return null;
        const h = Number(m[1]), min = Number(m[2] || 0);
        if (h > 23 || min > 59) return null;
        return { h, m: min, ap: m[3] || null, explicit: !!(m[2] || m[3] || m[4]) };
    }

    /** 12h -> 24h. With no am/pm: 1-7 is afternoon/evening, 8-11 morning (family-calendar guess). */
    function to24(t, ap, hint) {
        let h = t.h;
        ap = ap || t.ap;
        if (h > 12) return { h, m: t.m };
        if (ap === "pm" && h < 12) h += 12;
        else if (ap === "am" && h === 12) h = 0;
        else if (!ap) {
            if (hint === "pm" && h < 12) h += 12;
            else if (!hint && h >= 1 && h <= 7) h += 12;
        }
        return { h, m: t.m };
    }
    const mins = t => t.h * 60 + t.m;

    /** Pull date/time phrases out of the cursor. Returns what it found. */
    // nearest: a date with no year means the closest one (emails: "thanks for coming Oct 30th"),
    // otherwise the next upcoming one (commands: "November 16th" said in December = next year).
    function extractWhen(st, now, nearest) {
        const out = { date: null, endDate: null, start: null, end: null, durationMin: null, allDay: false, hint: null };
        const today = dayOnly(now);
        const upcoming = (y, mo, d, explicitYear) => {
            if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
            let dt = new Date(y, mo, d);
            if (dt.getMonth() !== mo) return null;                       // e.g. Feb 31
            if (!explicitYear && nearest) {
                dt = [y - 1, y, y + 1].map(yy => new Date(yy, mo, d))
                    .sort((a, b) => Math.abs(a - today) - Math.abs(b - today))[0];
            } else if (!explicitYear && dt < today) dt = new Date(y + 1, mo, d);
            return dt;
        };
        const year = y => !y ? null : (y.length === 2 ? 2000 + Number(y) : Number(y));
        const setDate = d => { if (!d) return false; out.date = d; };

        // ----- dates (first match wins) -----
        st.take(/\b(?:on\s+)?(?:the\s+)?day after tomorrow\b/, () => setDate(addDays(today, 2)))
        || st.take(/\b(?:on\s+)?(today|tonight|this (?:morning|afternoon|evening)|tomorrow(?:\s+(?:morning|afternoon|evening|night))?)\b/, m => {
            setDate(addDays(today, m[1].startsWith("tomorrow") ? 1 : 0));
            if (/night|evening|afternoon/.test(m[1])) out.hint = "pm";
            else if (/morning/.test(m[1])) out.hint = "am";
        })
        || st.take(new RegExp(`\\b(?:on\\s+)?(?:(?:${WEEKDAY_RE})\\s*,?\\s+)?(?:the\\s+)?(${MONTH_RE})\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:-|–|through|thru)\\s*(\\d{1,2})(?:st|nd|rd|th)?)?\\b(?:\\s*,?\\s*(\\d{4}))?`), m => {
            // "November 25-27": a multi-day span
            const y = year(m[4]);
            const d = upcoming(y || today.getFullYear(), MONTHS[m[1]], Number(m[2]), !!y);
            if (d && m[3] && Number(m[3]) > Number(m[2])) out.endDate = new Date(d.getFullYear(), d.getMonth(), Number(m[3]));
            return setDate(d);
        })
        || st.take(new RegExp(`\\b(?:on\\s+)?(?:(?:${WEEKDAY_RE})\\s*,?\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b(?:\\s*,?\\s*(\\d{4}))?`), m => {
            const y = year(m[3]);
            return setDate(upcoming(y || today.getFullYear(), MONTHS[m[2]], Number(m[1]), !!y));
        })
        || st.take(/\b(?:on\s+|from\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s*(?:-|–|through|thru|to)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?)?\b/, m => {
            // "11/25-11/27": a multi-day span
            const y = year(m[3]);
            const d = upcoming(y || today.getFullYear(), Number(m[1]) - 1, Number(m[2]), !!y);
            if (d && m[4]) {
                const e = new Date(d.getFullYear() + (Number(m[4]) < Number(m[1]) ? 1 : 0), Number(m[4]) - 1, Number(m[5]));
                if (e > d) out.endDate = e;
            }
            return setDate(d);
        })
        || st.take(new RegExp(`\\b(on\\s+)?(?:(this|next|coming)\\s+)?(${WEEKDAY_RE})\\b`), m => {
            // In emails a bare weekday is often part of a name ("our first ever Saturday Holiday
            // Shoppe"), so there it only counts as a date after "on" / "this" / "next".
            if (nearest && !m[1] && !m[2]) return false;
            let diff = (WEEKDAYS[m[3]] - today.getDay() + 7) % 7;
            if (m[2] === "next" && diff === 0) diff = 7;
            setDate(addDays(today, diff));
        })
        || st.take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/, m => {
            // "the 20th": this month, or next month if that day has passed.
            const d = Number(m[1]);
            let dt = upcoming(today.getFullYear(), today.getMonth(), d, true);
            if (!dt || dt < today) {
                const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
                dt = upcoming(next.getFullYear(), next.getMonth(), d, true);
            }
            return setDate(dt);
        })
        || st.take(/\bin\s+(\d+|a|an|one|two|three|four|five|six)\s+(days?|weeks?)\b/, m => {
            const n = /^\d+$/.test(m[1]) ? Number(m[1]) : (SMALL[m[1]] || 1);
            setDate(addDays(today, /week/.test(m[2]) ? n * 7 : n));
        });

        // ----- times -----
        st.take(/\ball[- ]day(?:\s+long)?\b/, () => { out.allDay = true; });
        st.take(/\b(?:in\s+the\s+)?(morning|afternoon|evening)\b|\bat\s+night\b/, m => {
            out.hint = m[1] === "morning" ? "am" : "pm";
        });

        // Range: "from 3 to 5", "3-5pm", "between 2 and 4", "11 to 1pm".
        st.take(new RegExp(`\\b(from\\s+|between\\s+)?${TOK}\\s*(?:-|–|to|until|till|through|and)\\s*${TOK}`), m => {
            const a = parseTok(m[2]), b = parseTok(m[3]);
            if (!a || !b) return false;
            if (/\band\b/.test(m[0]) && !/between/.test(m[1] || "")) return false;
            if (!m[1] && !a.explicit && !b.explicit) return false;
            let aa = to24(a, a.ap || b.ap, out.hint);
            let bb = to24(b, b.ap || a.ap, out.hint);
            if (!a.ap && b.ap && mins(aa) >= mins(bb)) aa = to24(a, b.ap === "pm" ? "am" : "pm");
            if (mins(bb) <= mins(aa) && bb.h < 12) bb = { h: bb.h + 12, m: bb.m };
            out.start = aa; out.end = bb;
        });
        if (!out.start) {
            st.take(new RegExp(`\\b(?:at|@|around|by|starting at|starts at|beginning at)\\s+${TOK}`), m => {
                const t = parseTok(m[1]);
                if (!t) return false;
                out.start = to24(t, null, out.hint);
            })
            || st.take(new RegExp(`\\b${TOK}`), m => {
                const t = parseTok(m[1]);
                if (!t || !t.explicit) return false;     // "3pm", "1:30", "noon" count; a bare "3" doesn't
                out.start = to24(t, null, out.hint);
            });
        }
        if (out.start && !out.end) {
            st.take(new RegExp(`\\b(?:until|till|til|to|ending at|ends at)\\s+${TOK}`), m => {
                const t = parseTok(m[1]);
                if (!t) return false;
                let e = to24(t, null, out.start.h >= 12 ? "pm" : out.hint);
                if (mins(e) <= mins(out.start) && e.h < 12) e = { h: e.h + 12, m: e.m };
                out.end = e;
            });
        }
        st.take(/\bfor\s+(?:an?\s+)?(?:hour\s+and\s+a\s+half|half\s+(?:an\s+)?hour|(\d+(?:\.\d+)?|an?|one|two|three|four|five|six)\s*(hours?|hrs?|minutes?|mins?)(\s+and\s+a\s+half)?)\b/, m => {
            if (/hour and a half/.test(m[0])) out.durationMin = 90;
            else if (/half/.test(m[0]) && !m[1]) out.durationMin = 30;
            else {
                const n = /^\d/.test(m[1]) ? Number(m[1]) : (SMALL[m[1]] || 1);
                out.durationMin = Math.round((/^h/.test(m[2]) ? n * 60 : n) + (m[3] ? 30 : 0));
            }
        });

        out.found = !!(out.date || out.start || out.allDay);
        return out;
    }

    /** Turn what extractWhen found into concrete start/end for an event. */
    function resolveEvent(when, now) {
        const date = when.date || dayOnly(now);
        if (!when.start || when.allDay) {
            const last = when.endDate && when.endDate > date ? when.endDate : date;
            return { allDay: true, start: dayOnly(date), end: addDays(dayOnly(last), 1) };
        }
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), when.start.h, when.start.m);
        let end;
        if (when.end) end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), when.end.h, when.end.m);
        else end = new Date(start.getTime() + (when.durationMin || 60) * 60000);
        if (end <= start) end = new Date(end.getTime() + 24 * 3600000);
        return { allDay: false, start, end };
    }

    // ---------- names, items, matching ----------

    // keepVerbs: for text that isn't a command (emails, imports), so "Book fair" stays "Book fair".
    function cleanTitle(s, keepVerbs) {
        let t = squash(s);
        t = t.replace(/\b(?:to|on|in|onto)\s+(?:the\s+|our\s+|my\s+)?calendar\b/gi, " ");
        t = squash(t);
        if (!keepVerbs) t = t.replace(/^(?:(?:please|can you|could you|go ahead and|i need you to|let's)\s+)*(?:create|make|add|schedule|put|set up|setup|book|plan|enter|new)?\s*(?:me\s+|us\s+)?(?:a\s+|an\s+)?(?:new\s+)?(?:calendar\s+)?(?:event|appointment|meeting|reminder|entry)?\b/i, "");
        const marker = /\b(?:called|named|titled)\s+/i.exec(t);
        if (marker) t = t.slice(marker.index + marker[0].length);
        t = t.replace(/^(?:[\s,:;\-]|\b(?:for|on|at|that|about|and|it'?s|its|it is|is|the event is|which is)\b)+/i, "");
        t = t.replace(/(?:[\s,:;\-]|\b(?:on|at|for|from|to|and|the|is|it'?s|starting|starts|by)\b)+$/i, "");
        return cap(squash(t));
    }

    function cleanListName(s) {
        let t = squash(s).replace(/^(?:the|my|our|a|an)\s+/i, "").replace(/'s$/i, "");
        return cap(squash(t));
    }

    function splitItems(s) {
        return String(s || "")
            .replace(/\b(?:and then|then|also|plus|as well as)\b/gi, ",")
            .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
            .map(x => squash(x.replace(/^(?:and|some|more|a few)\s+/i, "").replace(/[.;:]+$/, "")))
            .filter(x => x && !/^(?:and|the|a)$/i.test(x))
            .map(cap);
    }

    const stem = w => w.endsWith("ies") ? w.slice(0, -3) + "y" : (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) ? w.slice(0, -1) : w;
    function key(s) {
        return String(s || "").toLowerCase().replace(/'/g, "")
            .replace(/\b(?:the|my|our|list)\b/g, " ")
            .replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map(stem).join(" ");
    }
    function lev(a, b) {
        const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j++) d[0][j] = j;
        for (let i = 1; i <= a.length; i++)
            for (let j = 1; j <= b.length; j++)
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        return d[a.length][b.length];
    }

    /** Best fuzzy match of `query` among `names`; returns the index or -1. */
    function bestMatch(query, names) {
        const q = key(query);
        if (!q) return -1;
        let best = -1, bestScore = 0;
        names.forEach((n, i) => {
            const k = key(n);
            let score = 0;
            if (k === q) score = 4;
            else if (k && (k.includes(q) || q.includes(k))) score = 3;
            else if (k && lev(k, q) <= Math.max(1, Math.floor(Math.max(k.length, q.length) / 5))) score = 2;
            if (score > bestScore) { best = i; bestScore = score; }
        });
        return best;
    }

    // ---------- the command parser ----------

    const LIST_TAIL = "(?:\\s+list)?";
    const THE = "(?:the\\s+|my\\s+|our\\s+)?";

    /**
     * parse(text, now) -> { kind, ... }
     *   cancel | done | yes | no | edit
     *   agenda {when: "today"|"tomorrow"|"week"}
     *   event.create {title, allDay, start, end, hasDate}
     *   list.create {name, items}
     *   item.add {list, items}        list may be null = "the current list"
     *   item.check {list, items}
     *   item.remove {list, items}
     *   list.clearDone {list}
     *   list.delete {list}
     *   list.read {list}
     *   note.create {title, body}
     *   unknown {text}
     */
    function parse(text, now) {
        now = now || new Date();
        const t = normalize(text);
        const low = t.toLowerCase().replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
        const words = low.split(" ").filter(Boolean).length;

        // ----- conversation control (short utterances only) -----
        if (words <= 4) {
            if (/^(?:stop|cancel|never ?mind|forget (?:it|that)|quit|abort|scratch that)\b/.test(low)) return { kind: "cancel" };
            if (/^(?:done|i'?m done|all done|that'?s (?:all|it)|nothing(?: else)?|no thanks?|no thank you|thanks?|thank you|good ?bye|bye)\b/.test(low)) return { kind: "done" };
            if (/^(?:yes|yeah|yep|yup|sure|ok|okay|confirm|do it|go ahead|sounds good|correct|that'?s right|right|please do|save(?: it)?|add it|perfect)\b/.test(low)) return { kind: "yes" };
            if (/^(?:no|nope|nah|wrong|that'?s wrong|not right|don'?t)\b/.test(low)) return { kind: "no" };
            if (/^(?:edit(?: it)?|change it|let me (?:edit|fix) it|fix it|open it)\b/.test(low)) return { kind: "edit" };
        }

        // ----- what's on the calendar -----
        let m;
        if (/\b(?:what'?s|what is|what do we have|anything|what have we got|read me)\b.*\b(?:today|tonight|tomorrow|this week|coming up|next)\b/.test(low)
            && !/\blist\b/.test(low)) {
            return { kind: "agenda", when: /tomorrow/.test(low) ? "tomorrow" : /week|coming up/.test(low) ? "week" : "today" };
        }

        // ----- notes -----
        if ((m = /^(?:please\s+)?(?:create|make|add|take|write|new|start|jot)\s+(?:down\s+)?(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?note\b[\s,:-]*(.*)$/i.exec(t))) {
            let rest = m[1] || "", title = rest, body = "";
            const split = /\s*(?:\b(?:that says|which says|saying|and it says|it says|that reads|with the text|with text|body|contents?)\b|:)\s*/i.exec(rest);
            if (split) { title = rest.slice(0, split.index); body = rest.slice(split.index + split[0].length); }
            title = title.replace(/^(?:called|named|titled|about|for)\s+/i, "");
            return { kind: "note.create", title: cap(squash(title)), body: cap(squash(body)) };
        }

        // ----- lists -----
        // "create/make/start a list ..." ("add" only as "add a new list", so "add X to the Y list" isn't a new list)
        if ((m = /^(?:please\s+)?(?:(?:create|make|start|begin|set up|new)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+)?|add\s+(?:a\s+|an\s+)(?=(?:new\s+)?(?:\w+\s+)?list\b))(?:new\s+)?(.*?)\blist\b[\s,]*(.*)$/i.exec(t))
            && !/\b(?:to|on|onto|in|into|from)\b/i.test(m[1])) {
            let descriptor = squash(m[1]), rest = m[2] || "", name = "", items = [];
            const called = /^(?:called|named|titled)\s+/i.exec(rest);
            const itemSplit = /\s*(?:\b(?:and add|and put|with|containing|that has|and it has|including|add|for)\b|:)\s*/i;
            if (called) {
                rest = rest.slice(called[0].length);
                const s = itemSplit.exec(rest);
                name = s ? rest.slice(0, s.index) : rest;
                if (s) items = splitItems(rest.slice(s.index + s[0].length));
            } else {
                name = descriptor ? descriptor + " list" : "";
                const s = itemSplit.exec(rest);
                if (s) items = splitItems(rest.slice(s.index + s[0].length));
            }
            return { kind: "list.create", name: cleanListName(name), items };
        }

        // "remove X from the Y list" before "delete the Y list"
        if ((m = new RegExp(`^(?:please\\s+)?(?:remove|delete|take|drop|scratch)\\s+(.+?)\\s+(?:from|off of|off)\\s+${THE}(.+?)${LIST_TAIL}$`, "i").exec(t))) {
            return { kind: "item.remove", list: cleanListName(m[2]), items: splitItems(m[1]) };
        }
        if ((m = new RegExp(`^(?:please\\s+)?(?:delete|remove|get rid of|trash)\\s+${THE}(.+?)\\s+list$`, "i").exec(t))) {
            return { kind: "list.delete", list: cleanListName(m[1]) };
        }
        if ((m = new RegExp(`^(?:please\\s+)?(?:read(?: me)?|what'?s on|what is on|what'?s in|show(?: me)?|tell me|what do we need (?:on|from))\\s+${THE}(.+?)\\s+list$`, "i").exec(t))) {
            return { kind: "list.read", list: cleanListName(m[1]) };
        }
        if ((m = new RegExp(`^(?:please\\s+)?clear\\s+(?:the\\s+)?(?:checked|completed|done|finished)(?:\\s+(?:items|things))?(?:\\s+(?:from|on|off)\\s+${THE}(.+?)${LIST_TAIL})?$`, "i").exec(t))) {
            return { kind: "list.clearDone", list: m[1] ? cleanListName(m[1]) : null };
        }
        if ((m = new RegExp(`^(?:please\\s+)?(?:check off|cross off|tick off|mark off|check|mark|we got|i got|got)\\s+(.+?)(?:\\s+(?:as\\s+)?(?:done|complete|completed|off|bought|purchased))?(?:\\s+(?:on|from|in|off)\\s+${THE}(.+?)${LIST_TAIL})?$`, "i").exec(t))) {
            return { kind: "item.check", list: m[2] ? cleanListName(m[2]) : null, items: splitItems(m[1]) };
        }

        // ----- events (explicit) -----
        const eventWords = /\b(?:event|appointment|calendar|meeting|reminder)\b|^(?:please\s+)?(?:schedule|book)\b/i;
        if (eventWords.test(t)) return eventFrom(t, now);

        // ----- adding to lists -----
        if ((m = new RegExp(`^(?:please\\s+)?update\\s+${THE}(.+?)${LIST_TAIL}\\s+(?:with|to add|and add|by adding|adding|add)\\s+(.+)$`, "i").exec(t))) {
            return { kind: "item.add", list: cleanListName(m[1]), items: splitItems(m[2]) };
        }
        if ((m = new RegExp(`^(?:please\\s+)?(?:add|put|throw|stick|we need|i need)\\s+(.+?)\\s+(?:to|on|onto|in|into)\\s+${THE}(.+?)${LIST_TAIL}$`, "i").exec(t))) {
            return { kind: "item.add", list: cleanListName(m[2]), items: splitItems(m[1]) };
        }
        if ((m = /^(?:please\s+)?(?:add|we need|i need|we're out of|we are out of|out of)\s+(.+)$/i.exec(t))) {
            const probe = cursor(t);
            if (extractWhen(probe, now).found) return eventFrom(t, now);
            return { kind: "item.add", list: null, items: splitItems(m[1]) };
        }

        // ----- anything with a date or time is probably an event -----
        const probe = cursor(t);
        if (extractWhen(probe, now).found) return eventFrom(t, now);

        return { kind: "unknown", text: t };
    }

    function eventFrom(t, now) {
        const st = cursor(t);
        const when = extractWhen(st, now);
        const ev = resolveEvent(when, now);
        return {
            kind: "event.create",
            title: cleanTitle(st.orig),
            allDay: ev.allDay,
            start: ev.start,
            end: ev.end,
            hasDate: !!(when.date || when.start)
        };
    }

    /** Parse only a date/time phrase (for follow-up answers like "on Friday at 3"). */
    function parseWhen(text, now) {
        now = now || new Date();
        const st = cursor(normalize(text));
        const when = extractWhen(st, now);
        return when.found ? resolveEvent(when, now) : null;
    }

    // ---------- events inside email / document text ----------

    /** Remove web links from email text: "<https://…>" (even wrapped across lines) and bare URLs. */
    function stripLinks(text) {
        return String(text || "")
            .replace(/<https?:\/\/[^>]*>/gi, " ")
            .replace(/https?:\/\/\S+/gi, " ")
            .replace(/[ \t]{2,}/g, " ");
    }

    // A date only becomes a suggestion when it sits near one of these.
    const EVENT_WORDS = /\b(?:trip|field ?trip|picture|photo|party|parties|concert|conference|conferences|meeting|program|performance|early release|early dismissal|dismissal|no school|half[- ]day|holiday|break|celebration|show|fair|game|practice|test|quiz|exam|due|deadline|bring|wear|spirit|assembly|parade|festival|night|fundraiser|visit|presentation|orientation|open house|play|recital|day|days|dance|carnival|sale|drive|ceremony|graduation|social|lunch|breakfast|potluck|camp|tournament|meet|walk|run|reading|volunteer|sign[- ]?up|registration|return|turn in|starts?|ends?)\b/i;
    // ...and is skipped when it reads like a policy change rather than something to attend.
    const POLICY_WORDS = /\b(?:no longer|not permitted|not allowed|effective|as of|from now on|until further notice|policy|rule|rules)\b/i;

    /**
     * Find likely events in free text (an email body, pasted newsletter, PDF text).
     * sentAt anchors relative dates ("tomorrow", "Friday") to when the email was sent.
     * Past dates are dropped. Returns [{ title, allDay, start, end, sentence }].
     */
    function findEvents(text, sentAt, now) {
        sentAt = sentAt || new Date();
        now = now || new Date();
        const today = dayOnly(now);
        const out = [], seen = new Set();
        const sentences = stripLinks(text)
            .replace(/\r/g, "")
            .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])|\n(?=\s*[-•*▪]|\s*\d{1,2}\/\d{1,2})/)
            .map(squash).filter(s => s.length > 3 && s.length < 400);

        for (const sentence of sentences) {
            const st = cursor(normalize(sentence));
            const when = extractWhen(st, sentAt, true);
            if (!when.date) continue;                                   // a time alone isn't enough
            const ev = resolveEvent(when, sentAt);
            if (ev.end <= today) continue;                             // already over
            if (!EVENT_WORDS.test(sentence)) continue;
            if (POLICY_WORDS.test(sentence) && !/\b(?:trip|party|concert|conference|early release|no school|picture|assembly|fair|program)\b/i.test(sentence)) continue;
            let title = cleanTitle(st.orig, true)
                .replace(/^(?:please\s+)?(?:remember|note|reminder|don't forget|just a reminder)(?:\s+that)?[\s,:]*/i, "")
                .replace(/^(?:additionally|also|of note|in addition|finally|plus|lastly|next|and|but|so)\b[\s,:]*/i, "")
                .replace(/^(?:please\s+)?(?:remember|note|reminder|don't forget|just a reminder)(?:\s+that)?[\s,:]*/i, "")
                .replace(/^(?:we will (?:have|be having)|we have|there will be|there is|our)\s+/i, "")
                .replace(/^(?:we are|we're) (?:now )?/i, "")
                .replace(/\s*(?:click here|learn more|information can be found)[\s\S]*$/i, "")
                .replace(/\s+(?:will be|will take place|is scheduled|takes place|happens|is|are)$/i, "");
            if (title.length > 70) title = title.slice(0, 67).replace(/\s+\S*$/, "") + "…";
            title = cap(title || "School event");
            const k = (ev.allDay ? ev.start.toDateString() : ev.start.toISOString()) + "|" + title.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push({ title, allDay: ev.allDay, start: ev.start, end: ev.end, sentence });
        }
        return out;
    }

    // ---------- meal-account alerts ----------

    /**
     * Pull the balance and the child out of a lunch-account email.
     * kidNames: the family's kids (from the Teachers roster), matched case-insensitively.
     * Returns { balance: number|null, balanceText, kid: string|null }.
     */
    function mealSummary(text, kidNames) {
        const t = String(text || "").replace(/\r/g, "");
        const money = /(\(\s*)?(-\s*)?\$\s?(-\s*)?(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)(\s*\))?/g;
        const found = [];
        let m;
        while ((m = money.exec(t))) {
            const before = t.slice(Math.max(0, m.index - 80), m.index);
            const negative = !!(m[2] || m[3] || (m[1] && m[5])) || /\b(?:negative|overdrawn|owe[sd]?|past due|deficit)\b[^$]*$/i.test(before);
            const value = Number(m[4].replace(/,/g, "")) * (negative ? -1 : 1);
            // Prefer the amount right after "balance"/"account"; the closer the better.
            const cue = /(?:balance|bal\.?|account|remaining|available|current)\b[^$\n]{0,40}$/i.exec(before);
            let score = cue ? 100 - (before.length - cue.index) : 0;
            // "low balance threshold $10.00" is a setting, not the balance.
            if (/\b(?:threshold|minimum|limit|below|under|at least|level|deposit|payment of)\b[^$\n]{0,15}$/i.test(before)) score -= 200;
            found.push({ value, score, index: m.index });
        }
        found.sort((a, b) => (b.score - a.score) || (a.index - b.index));
        const pick = found[0];

        let kid = null, first = Infinity;
        for (const k of kidNames || []) {
            const i = t.search(new RegExp("\\b" + String(k).replace(/[^\w]/g, "") + "\\b", "i"));
            if (k && i >= 0 && i < first) { kid = k; first = i; }
        }
        return {
            balance: pick ? pick.value : null,
            balanceText: pick ? (pick.value < 0 ? "-" : "") + "$" + Math.abs(pick.value).toFixed(2) : null,
            kid
        };
    }

    const api = { parse, parseWhen, normalize, splitItems, bestMatch, cleanTitle, cleanListName, findEvents, mealSummary, stripLinks };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.FamilyParser = api;
})(typeof window !== "undefined" ? window : globalThis);

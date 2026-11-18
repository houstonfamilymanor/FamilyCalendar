/**
 * Family Command — kids' schools: lunch menus, school events, letter days.
 *
 * The backend (apps-script/Schools.js) reads each kid's school feeds into the Sheet. Here
 * they become all-day / timed items under two built-in chips per kid, "Lunch · <name>" and
 * "School · <name>" (events + letter days), both off until someone turns them on. When both
 * kids have the same thing on a day (same menu, shared event, same letter), it shows once
 * as "Name & Name". These items live only in this app, never on Google Calendar. If a feed
 * can't be read, the page says so loudly so it gets fixed.
 *
 * Names and links are entered in Settings and stored in the family Sheet, not in this code.
 * Uses globals from index.html: api, calendar, escapeHtml, parseYmd, ymd, fmtTime,
 * renderDashboard, FamilyTags.
 */
(function (root) {
    "use strict";

    const TROUBLE_MENU = "I can't see the menu 😞 TROUBLESHOOTING TIME!";
    const TROUBLE_SCHOOL = "I can't see the school calendar 😞 TROUBLESHOOTING TIME!";
    const COLORS = [["#e6c84f", "#4fb3bf"], ["#f2a65a", "#a77bd8"], ["#7cc576", "#d97aa6"]];

    // ---------- pure helpers (tested in tests/kids.test.js) ----------

    /**
     * "Choose One Entrée:\n• A\n• B\n\nChoose Your Sides:\n• C" -> { entrees: [A, B], sides: [C], note: "" }
     * Text with no bullet lines (e.g. "NO SCHOOL") comes back as a note.
     */
    function parseMenu(text) {
        const out = { entrees: [], sides: [], note: "" };
        const lines = String(text || "").replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
        let section = "entrees";
        let bullets = 0;
        for (const line of lines) {
            const b = /^[•·\-*]\s*(.+)$/.exec(line);
            if (b) {
                bullets++;
                out[section].push(b[1].replace(/\s{2,}/g, " ").trim());
            } else if (/side/i.test(line)) {
                section = "sides";
            } else if (/entr[ée]e|main|choose one/i.test(line)) {
                section = "entrees";
            }
        }
        if (!bullets) out.note = lines.join(" ").trim();
        return out;
    }

    const titleCase = s => s.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (m, a, c) => a + c.toUpperCase());

    /** A menu day -> { text: "A / B" or "No School", lunch, breakfast } ("" text = nothing to show). */
    function describeLunch(day) {
        const lunch = parseMenu(day.lunch), breakfast = parseMenu(day.breakfast);
        const note = lunch.note || (!lunch.entrees.length ? breakfast.note : "");
        const text = lunch.entrees.length ? lunch.entrees.join(" / ") : note ? titleCase(note.replace(/[!.]+$/, "")) : "";
        return { text, isNote: !lunch.entrees.length && !!note, lunch, breakfast };
    }

    /** "C-Day" / "C Day" / "C" -> "C"; anything else -> null. */
    function letterOf(label) {
        const m = /^\s*([A-Z])(?:[\s-]*day)?\s*$/i.exec(String(label || ""));
        return m ? m[1].toUpperCase() : null;
    }

    /** "A: Gym, B = Art; C - Music" -> { A: "Gym", B: "Art", C: "Music" } */
    function parseMeanings(text) {
        const out = {};
        String(text || "").split(/[,;\n]+/).forEach(part => {
            const m = /^\s*([A-Z])\s*[:=\-–]\s*(.+?)\s*$/i.exec(part);
            if (m) out[m[1].toUpperCase()] = m[2];
        });
        return out;
    }

    const pad2 = n => String(n).padStart(2, "0");
    const dayOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;   // local "yyyy-mm-dd"

    /** "Sam", "Sam & Mia", "Sam, Mia & Leo" */
    const joinNames = names => names.length < 3 ? names.join(" & ") : names.slice(0, -1).join(", ") + " & " + names[names.length - 1];

    /**
     * All school items for [from, to) as plain objects:
     * { key, kind: "lunch"|"event"|"letter", title, allDay, start: "yyyy-mm-dd" | ISO, end, tags, detail }
     * Items two kids share are merged into one.
     */
    function buildItems(data, from, to) {
        const kids = data.kids || [];
        const inRange = date => date >= from && date < to;          // from/to as "yyyy-mm-dd"
        const groups = new Map();
        const add = (key, make, kid, tag) => {
            if (!groups.has(key)) groups.set(key, { ...make(), kids: [], tags: [] });
            const g = groups.get(key);
            if (!g.kids.includes(kid.name)) g.kids.push(kid.name);
            if (!g.tags.includes(tag)) g.tags.push(tag);
        };

        for (const kid of kids) {
            const meanings = parseMeanings(kid.letterMeanings);
            for (const day of data.lunch || []) {
                if (day.feed !== kid.menuFeed || !inRange(day.date)) continue;
                const d = describeLunch(day);
                if (!d.text) continue;
                add("lunch|" + day.date + "|" + d.text, () => ({ kind: "lunch", date: day.date, text: d.text, isNote: d.isNote, detail: d }),
                    kid, "_lunch:" + kid.id);
            }
            for (const ev of data.events || []) {
                if (ev.feed !== kid.eventsFeed) continue;
                const date = ev.allDay ? ev.start : dayOf(new Date(ev.start));
                if (!inRange(date)) continue;
                add("event|" + ev.title.toLowerCase() + "|" + ev.start, () => ({ kind: "event", date, ev }), kid, "_school:" + kid.id);
            }
            for (const day of data.letters || []) {
                if (day.cal !== kid.letterCal || !inRange(day.date)) continue;
                const letter = letterOf(day.label);
                const label = letter ? letter + "-Day" : day.label;
                const meaning = letter && meanings[letter] || "";
                add("letter|" + day.date + "|" + label + "|" + meaning, () => ({ kind: "letter", date: day.date, label, meaning }),
                    kid, "_school:" + kid.id);
            }
        }

        return [...groups.entries()].map(([key, g]) => {
            const who = joinNames(g.kids) + ": ";
            if (g.kind === "lunch") {
                return { key, kind: "lunch", allDay: true, start: g.date, end: g.date, tags: g.tags,
                    title: (g.isNote ? "🏫 " : "🍎 ") + who + g.text, detail: { ...g.detail, names: g.kids, date: g.date } };
            }
            if (g.kind === "letter") {
                return { key, kind: "letter", allDay: true, start: g.date, end: g.date, tags: g.tags,
                    title: "🔤 " + who + g.label + (g.meaning ? " · " + g.meaning : ""),
                    detail: { names: g.kids, date: g.date, label: g.label, meaning: g.meaning } };
            }
            const ev = g.ev;
            return { key, kind: "event", allDay: ev.allDay, start: ev.start, end: ev.end, tags: g.tags,
                title: "📌 " + who + ev.title, detail: { names: g.kids, date: g.date, ev } };
        });
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { parseMenu, describeLunch, letterOf, parseMeanings, buildItems, dayOf };
        return;
    }

    // ---------- state ----------

    const el = id => document.getElementById(id);
    let data = { kids: [], lunch: [], events: [], letters: [] };
    let items = new Map();            // key -> item (for the popup)
    let loaded = null;

    // The server reads the school sites in the background after Save / "Check now";
    // while that runs, check back every few seconds (up to ~9 minutes) and redraw when done.
    let polling = null;
    const busy = res => res && res.run && (res.run.waiting || res.run.running) && !res.run.stuck;
    function poll() {
        if (polling) return;
        const started = Date.now();
        polling = setInterval(async () => {
            try {
                const res = await api("GET", { what: "school" });
                setState(res);
                if (!busy(res) || Date.now() - started > 9 * 60000) {
                    clearInterval(polling); polling = null;
                    redraw();
                }
            } catch (e) { /* try again next tick */ }
        }, 8000);
    }

    function setState(res) {
        data = res && res.kids ? res : data;
        if (busy(data)) poll();
        const chips = [];
        data.kids.forEach((k, i) => {
            const [c1, c2] = COLORS[i % COLORS.length];
            if (k.hasLunch) chips.push({ id: "_lunch:" + k.id, name: "Lunch · " + k.name, color: c1, hidden: true, builtin: true });
            if (k.hasEvents || k.hasLetters) chips.push({ id: "_school:" + k.id, name: "School · " + k.name, color: c2, hidden: true, builtin: true });
        });
        FamilyTags.setBuiltins(chips);
        renderSettings();
    }

    /** Loads once per sign-in; the calendar and Today panel wait on this. */
    function ready() {
        if (!loaded) {
            loaded = api("GET", { what: "school" })
                .then(setState)
                .catch(err => {
                    loaded = null;
                    data.kids = data.kids.map(k => ({ ...k, errors: { lunch: err.message, events: err.message } }));
                    renderSettings();
                });
        }
        return loaded;
    }

    // index.html's `calendar` (window.calendar is the #calendar <div>, so don't test that).
    const cal = () => (typeof calendar !== "undefined" && calendar && calendar.getEventSourceById) ? calendar : null;

    function redraw() {
        const src = cal() && cal().getEventSourceById("kids");
        if (src) src.refetch();
        if (typeof renderDashboard === "function") renderDashboard();
    }

    async function reload() {
        loaded = null;
        await ready();
        redraw();
    }

    /** Troubleshooting lines for kids whose chip is on but whose feed can't be read. */
    function trouble() {
        const out = [];
        for (const k of data.kids) {
            const e = k.errors || {};
            if (e.lunch && FamilyTags.isOnId("_lunch:" + k.id)) out.push(`${TROUBLE_MENU} (${k.name}: ${e.lunch})`);
            const s = [e.events && "events: " + e.events, e.letters && "letter days: " + e.letters].filter(Boolean).join("; ");
            if (s && FamilyTags.isOnId("_school:" + k.id)) out.push(`${TROUBLE_SCHOOL} (${k.name}: ${s})`);
        }
        return out;
    }

    // ---------- calendar + Today panel ----------

    function itemsBetween(from, to) {
        const list = buildItems(data, ymd(from), ymd(to));
        list.forEach(it => items.set(it.key, it));
        return list;
    }

    const colorOf = tags => {
        const id = tags[0].split(":")[1];
        const i = Math.max(0, data.kids.findIndex(k => k.id === id));
        return COLORS[i % COLORS.length][tags[0].startsWith("_lunch") ? 0 : 1];
    };

    /** End for FullCalendar / the dashboard: all-day ends are exclusive. */
    function endOf(it) {
        if (!it.allDay) return it.end;
        const last = it.end && it.end > it.start ? it.end : it.start;
        const d = parseYmd(last); d.setDate(d.getDate() + 1);
        return ymd(d);
    }

    /**
     * FullCalendar event source (id "kids"). FullCalendar draws NOTHING until every source has
     * answered, so this answers at once with what it has (nothing, before the first load) and
     * refetches itself when the school data arrives. A slow school request never blanks the calendar.
     */
    let dataReady = false;
    const calendarSource = {
        id: "kids",
        events: (info, success) => {
            if (!dataReady) {
                success([]);
                Promise.all([ready(), FamilyTags.ready()]).then(() => { dataReady = true; redraw(); });
                return;
            }
            success(itemsBetween(info.start, info.end).map(it => ({
                id: it.key,
                title: it.title,
                start: it.start,
                end: endOf(it),
                allDay: it.allDay,
                editable: false,
                display: FamilyTags.visible({ tags: it.tags }) ? "auto" : "none",
                classNames: ["ev-school"],
                extendedProps: { tags: it.tags, tagColor: colorOf(it.tags), school: it.key }
            })));
        }
    };

    /** School items in the dashboard's shape (normalize() in index.html). */
    function dashboardItems(from, to) {
        return itemsBetween(from, to).map(it => ({
            id: it.key, title: it.title, allDay: it.allDay, recurring: false, school: it.key, tags: it.tags,
            start: it.allDay ? parseYmd(it.start) : new Date(it.start),
            end: it.allDay ? parseYmd(endOf(it)) : new Date(it.end),
            startStr: it.start, endStr: endOf(it)
        }));
    }

    // ---------- the popup ----------

    function listHtml(label, m) {
        if (m.note) return `<h4>${escapeHtml(label)}</h4><p class="lunch-note">${escapeHtml(titleCase(m.note))}</p>`;
        if (!m.entrees.length && !m.sides.length) return "";
        return `<h4>${escapeHtml(label)}</h4>
            ${m.entrees.length ? `<p class="lunch-sub">Choose one</p><ul>${m.entrees.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
            ${m.sides.length ? `<p class="lunch-sub">Sides</p><ul class="lunch-sides">${m.sides.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}`;
    }

    const longDate = date => parseYmd(date).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

    function show(key) {
        const it = items.get(key);
        if (!it) return;
        const d = it.detail, who = joinNames(d.names);
        let title, body;
        if (it.kind === "lunch") {
            title = who + " · " + longDate(d.date);
            body = listHtml("Lunch", d.lunch) + listHtml("Breakfast", d.breakfast);
        } else if (it.kind === "letter") {
            title = who + " · " + longDate(d.date);
            body = `<p class="letter-big">${escapeHtml(d.label)}</p>` +
                (d.meaning ? `<p>${escapeHtml(d.meaning)}</p>` :
                    `<p class="roster-help">Add what each letter means in ⚙ Settings → Kids' schools (e.g. “C: Gym”).</p>`);
        } else {
            const ev = d.ev;
            const when = ev.allDay ? longDate(ev.start) + (ev.end > ev.start ? " – " + longDate(ev.end) : "") + " · All day"
                : longDate(ymd(new Date(ev.start))) + " · " + fmtTime(new Date(ev.start)) +
                  (ev.end > ev.start ? " – " + fmtTime(new Date(ev.end)) : "");
            title = ev.title;
            body = `<p>${escapeHtml(when)}</p><p class="roster-help">From ${escapeHtml(who)}'s school calendar.</p>`;
        }
        el("lunch-modal-title").textContent = title;
        el("lunch-modal-body").innerHTML = body;
        el("lunch-modal").style.display = "flex";
    }
    const close = () => { el("lunch-modal").style.display = "none"; };
    el("lunch-close").addEventListener("click", close);
    el("lunch-modal").addEventListener("click", e => { if (e.target.id === "lunch-modal") close(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && el("lunch-modal").style.display === "flex") close(); });

    // ---------- Settings: one row per kid ----------

    function ago(ms) {
        const mins = Math.round((Date.now() - ms) / 60000);
        if (mins < 2) return "just now";
        if (mins < 90) return mins + " minutes ago";
        const hrs = Math.round(mins / 60);
        return hrs < 36 ? hrs + " hours ago" : Math.round(hrs / 24) + " days ago";
    }

    function statusLines(k) {
        if (!k.id) return "";
        if (k.pending && busy(data)) return "⏳ Reading the school sites in the background… (this updates by itself)";
        const e = k.errors || {};
        const today = ymd(new Date());
        const count = (list, match) => list.filter(x => match(x) && (x.date || x.start || "").slice(0, 10) >= today).length;
        const parts = [];
        if (k.hasLunch) parts.push(e.lunch ? `<span class="error">Lunch: ${escapeHtml(TROUBLE_MENU)} (${escapeHtml(e.lunch)})</span>`
            : `✓ Lunch: ${count(data.lunch, x => x.feed === k.menuFeed)} days`);
        if (k.hasEvents) parts.push(e.events ? `<span class="error">Events: ${escapeHtml(TROUBLE_SCHOOL)} (${escapeHtml(e.events)})</span>`
            : `✓ Events: ${count(data.events, x => x.feed === k.eventsFeed)} coming up`);
        if (k.hasLetters) parts.push(e.letters ? `<span class="error">Letter days: ${escapeHtml(TROUBLE_SCHOOL)} (${escapeHtml(e.letters)})</span>`
            : `✓ Letter days: ${count(data.letters, x => x.cal === k.letterCal)} days`);
        if (!e.lunch && !e.events && !e.letters && k.lastOk) {
            parts.push(`read ${ago(k.lastOk)}` + (data.run && data.run.ms ? ` (took ${(data.run.ms / 1000).toFixed(1)}s)` : ""));
        }
        return parts.join(" · ");
    }

    function row(k) {
        return `<div class="kid-row" data-id="${escapeHtml(k.id || "")}">
            <input class="input" data-f="name" placeholder="Kid's name" value="${escapeHtml(k.name || "")}" maxlength="40">
            <input class="input" data-f="site" placeholder="School website link (the Dining page works best)" value="${escapeHtml(k.site || "")}">
            <button type="button" class="icon-btn danger" data-act="rm" aria-label="Remove this kid">✕</button>
            <input class="input" data-f="letterCal" placeholder="Letter-day calendar link (optional)" value="${escapeHtml(k.letterCal || "")}">
            <input class="input" data-f="letterMeanings" placeholder="What the letters mean, e.g. A: Gym, B: Art, C: Music (optional)" value="${escapeHtml(k.letterMeanings || "")}" maxlength="300">
            <p class="roster-help kid-status">${statusLines(k)}</p>
        </div>`;
    }

    function renderSettings() {
        el("kids-count").textContent = data.kids.length ? `(${data.kids.length})` : "(none yet)";
        el("kids-check").hidden = !data.kids.length;
        if (el("kids").contains(document.activeElement)) return;      // don't wipe what's being typed
        el("kids-rows").innerHTML = (data.kids.length ? data.kids : [{}]).map(row).join("");
    }

    el("kids-add").addEventListener("click", () => {
        el("kids-rows").insertAdjacentHTML("beforeend", row({}));
        el("kids-rows").lastElementChild.querySelector("input").focus();
    });
    el("kids-rows").addEventListener("click", e => {
        if (e.target.closest("[data-act='rm']")) e.target.closest(".kid-row").remove();
    });

    async function send(payload) {
        const btns = [el("kids-save"), el("kids-check")];
        btns.forEach(b => b.disabled = true);
        el("kids-msg").textContent = "Saving…";
        try {
            if (el("kids").contains(document.activeElement)) document.activeElement.blur();
            const res = await api("POST", payload);
            setState(res);
            loaded = Promise.resolve();
            redraw();
            el("kids-msg").textContent = busy(res) ? "Saved. Reading the school sites in the background…" : "Saved.";
        } catch (err) {
            el("kids-msg").textContent = "Couldn't save: " + err.message;
        } finally {
            btns.forEach(b => b.disabled = false);
        }
    }
    el("kids-save").addEventListener("click", () => {
        const rows = [...el("kids-rows").querySelectorAll(".kid-row")].map(r => {
            const v = f => r.querySelector(`[data-f='${f}']`).value.trim();
            return { id: r.dataset.id || undefined, name: v("name"), site: v("site"), letterCal: v("letterCal"), letterMeanings: v("letterMeanings") };
        }).filter(r => r.name || r.site || r.letterCal);
        if (rows.some(r => !r.name || !r.site)) { el("kids-msg").textContent = "Each kid needs a name and a school link."; return; }
        send({ action: "school.save", rows });
    });
    el("kids-check").addEventListener("click", () => send({ action: "school.sync" }));

    root.FamilyKids = { ready, reload, calendarSource, dashboardItems, show, trouble };
})(typeof window !== "undefined" ? window : globalThis);

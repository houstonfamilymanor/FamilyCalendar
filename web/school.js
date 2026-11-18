/**
 * Family Command — School tab.
 *
 * Shows school emails the backend copied from the family Gmail (Mail.js),
 * tags them by teacher/kid using the Teachers roster, and suggests calendar
 * events found in the text (parser.js findEvents). Nothing goes on the
 * calendar until someone taps Add and saves the pre-filled event form.
 *
 * Uses globals from index.html: api, openModal, refreshAll, escapeHtml, ymd,
 * fmtTime, startOfDay, DAY, $.
 */
(function () {
    "use strict";

    const P = window.FamilyParser;
    const el = id => document.getElementById(id);

    let mail = [], roster = [], rules = [], lastSync = 0, loaded = false, loading = null;
    let filter = "all";
    let openId = null;
    const calendarHits = {};          // mailId -> Set of suggestion indexes already on the calendar

    // Dismissed emails (last 30 days), read live from Gmail; the Sheet only keeps their links.
    let dismissedMail = [], dismissedLoaded = false, dismissedLoading = null, keepDays = 30, openDismissed = null;

    // Per-device memory of dismissed suggestions ("mailId:index").
    let dismissed = new Set();
    try { dismissed = new Set(JSON.parse(localStorage.getItem("school-dismissed") || "[]")); } catch (e) {}
    const saveDismissed = () => { try { localStorage.setItem("school-dismissed", JSON.stringify([...dismissed].slice(-500))); } catch (e) {} };

    // ---------- helpers ----------

    const titleCase = s => String(s || "").toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
    const tokens = s => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

    function ago(ms) {
        const d = new Date(ms), now = new Date();
        if (ymd(d) === ymd(now)) return fmtTime(d);
        const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY);
        if (days === 1) return "Yesterday";
        if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
        return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }

    /** Roster name -> ["first", ..., "last"]: handles "Smith, Jane", "Mrs. Smith", "J Doe". */
    function nameTokens(name) {
        let n = String(name || "");
        const comma = /^\s*([^,]+),\s*(.+)$/.exec(n);
        if (comma) n = comma[2] + " " + comma[1];
        const t = tokens(n).filter(x => !/^(mrs|mr|ms|miss|dr|coach)$/.test(x));
        if (t.length > 1 && t[t.length - 1].length === 1) t.unshift(t.pop());   // portal style "Doe J"
        return t;
    }

    /** Which roster entry sent this? Display name first, then the signature. */
    function whoSent(m) {
        const from = tokens(m.fromName);
        for (const r of roster) {
            const t = nameTokens(r.name);
            if (!t.length) continue;
            const last = t[t.length - 1];
            if (!from.includes(last)) continue;
            if (t.length > 1) {
                const first = t[0];
                if (first.length === 1 ? !from.some(f => f[0] === first) : !from.includes(first)) continue;
            }
            return r;
        }
        // Fallback: signed at the bottom ("Thank you, Mrs. Smith").
        const tail = String(m.body || "").slice(-300).toLowerCase();
        for (const r of roster) {
            const last = nameTokens(r.name).pop();
            if (last && last.length > 3 && new RegExp("\\b" + last + "\\b").test(tail)) return r;
        }
        return null;
    }

    function suggestionsFor(m) {
        if (catOf(m) !== SCHOOL) return [];
        if (!m._suggest) {
            try { m._suggest = P.findEvents(m.body, new Date(m.date), new Date()); }
            catch (e) { m._suggest = []; }
        }
        return m._suggest;
    }

    const kids = () => [...new Set(roster.map(r => r.kid).filter(Boolean))];

    // ---------- categories (by sender) ----------
    // Rules live in the family's private Google Sheet ("Rules" tab), edited on the School tab:
    // an email whose sender address or name contains `match` goes to that category.
    // kind "meal" = balance alert cards; "group" = its own filter. Anything else is regular
    // school mail (teacher tags + event suggestions).
    const SCHOOL = { id: "school", label: "School" };
    const MEAL = { id: "meal", label: "Meal Account Alert" };
    let categories = [];          // one entry per category label (several rules can share one)
    function buildCategories() {
        const byLabel = new Map();
        for (const r of rules) {
            const id = r.kind === "meal" ? "meal" : "g:" + r.label.toLowerCase();
            if (!byLabel.has(id)) byLabel.set(id, r.kind === "meal" ? { ...MEAL, label: r.label, matches: [] } : { id, label: r.label, matches: [] });
            byLabel.get(id).matches.push(r.match.toLowerCase());
        }
        categories = [...byLabel.values()];
    }
    const catOf = m => m._cat || (m._cat = categories.find(c => {
        const sender = (m.fromEmail + " " + m.fromName).toLowerCase();
        return c.matches.some(x => x && sender.includes(x));
    }) || SCHOOL);
    const teacherOf = m => catOf(m) === SCHOOL ? whoSent(m) : null;
    const meal = m => m._meal || (m._meal = P.mealSummary(m.subject + "\n" + m.body, kids()));
    function kidIn(m) {
        const text = m.subject + " " + m.body;
        return kids().find(k => new RegExp("\\b" + k.replace(/[^\w]/g, "") + "\\b", "i").test(text)) || null;
    }

    // ---------- loading ----------

    function apply(res) {
        mail = res.mail || [];
        roster = res.roster || [];
        rules = res.rules || [];
        buildCategories();
        lastSync = res.lastSync || 0;
        loaded = true;
        render();
        renderRoster();
        renderRules();
    }

    const AUTO_SYNC_AFTER = 2 * 60 * 1000;   // don't re-check Gmail more often than this

    /** Show what's stored right away, then check Gmail for new email in the background. */
    async function load() {
        if (loading) return loading;
        loading = (async () => {
            try {
                apply(await api("GET", { what: "mail" }));
                el("school-error").textContent = "";
                if (Date.now() - lastSync > AUTO_SYNC_AFTER) syncNow();
                if (!dismissedLoaded) loadDismissed();
            } catch (err) {
                el("school-error").textContent = "Couldn't load school email: " + err.message;
            } finally {
                loading = null;
            }
        })();
        return loading;
    }

    /** The Dismissed list, fetched in the background (each one is read from Gmail, so it's slower). */
    async function loadDismissed() {
        if (dismissedLoading) return dismissedLoading;
        dismissedLoading = (async () => {
            try {
                const res = await api("GET", { what: "dismissed" });
                dismissedMail = res.dismissed || [];
                keepDays = res.keepDays || keepDays;
                dismissedLoaded = true;
                render();
            } catch (err) {
                if (filter === "dismissed") el("school-error").textContent = "Couldn't load dismissed email: " + err.message;
            } finally {
                dismissedLoading = null;
            }
        })();
        return dismissedLoading;
    }

    async function restoreMail(d, btn) {
        if (btn) { btn.disabled = true; btn.textContent = "Restoring…"; }
        try {
            apply(await api("POST", { action: "mail.undismiss", ids: [d.id] }));
            dismissedMail = dismissedMail.filter(x => x !== d);
            render();
            showToast("Email restored to the School tab.");
        } catch (err) {
            showToast("Couldn't restore: " + err.message);
            if (btn) { btn.disabled = false; btn.textContent = "Restore"; }
        }
    }

    let syncing = false;
    async function syncNow() {
        if (syncing) return;
        syncing = true;
        const btn = el("school-sync-btn");
        btn.disabled = true; btn.textContent = "Checking…";
        try {
            const res = await api("POST", { action: "mail.sync" });
            apply(res);
            el("school-sync-text").textContent = res.added ? `${res.added} new` : "No new email";
        } catch (err) {
            el("school-error").textContent = "Couldn't check email: " + err.message;
        } finally {
            syncing = false;
            btn.disabled = false; btn.textContent = "Check now";
        }
    }

    async function setRead(m, read) {
        if (m.read === read) return;
        m.read = read;
        render();
        try { await api("POST", { action: "mail.read", ids: [m.id], read }); }
        catch (err) { el("school-error").textContent = "Couldn't save: " + err.message; }
    }

    /** Dismiss = hide in the app only (the email stays in Gmail). Undo for a few seconds. */
    let toastTimer = null;
    async function dismissMail(m) {
        const at = mail.indexOf(m);
        mail = mail.filter(x => x !== m);
        if (openId === m.id) openId = null;
        render();
        showToast("Email dismissed. It's still in Gmail.", async () => {
            mail.splice(Math.max(0, at), 0, m);
            render();
            try { await api("POST", { action: "mail.undismiss", ids: [m.id] }); loadDismissed(); }
            catch (err) { el("school-error").textContent = "Couldn't undo: " + err.message; load(); }
        });
        try { await api("POST", { action: "mail.dismiss", ids: [m.id] }); loadDismissed(); }
        catch (err) { el("school-error").textContent = "Couldn't save: " + err.message; load(); }
    }

    function showToast(text, undo) {
        const t = el("school-toast");
        t.innerHTML = `<span>${escapeHtml(text)}</span>` + (undo ? `<button type="button" class="btn-sm">Undo</button>` : "");
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
        const b = t.querySelector("button");
        if (b) b.onclick = () => { t.hidden = true; clearTimeout(toastTimer); undo(); };
    }

    /** Mark suggestions that are already on the calendar (same day, similar title). */
    async function checkCalendar(m) {
        const sugg = suggestionsFor(m);
        if (!sugg.length || calendarHits[m.id]) return;
        calendarHits[m.id] = new Set();
        const from = new Date(Math.min(...sugg.map(s => s.start.getTime())));
        const to = new Date(Math.max(...sugg.map(s => s.end.getTime())));
        try {
            const events = await api("GET", { from: startOfDay(from).toISOString(), to: new Date(to.getTime() + DAY).toISOString() });
            sugg.forEach((s, i) => {
                const sameDay = events.filter(ev => (ev.start || "").slice(0, 10) === ymd(s.start) ||
                    ymd(new Date(ev.start)) === ymd(s.start));
                if (sameDay.length && P.bestMatch(s.title, sameDay.map(ev => ev.title)) >= 0) calendarHits[m.id].add(i);
            });
            if (openId === m.id) render();
        } catch (e) { /* not critical */ }
    }

    // ---------- rendering ----------

    function updateBadge() {
        const n = mail.filter(m => catOf(m).id === "meal" || (!m.read && teacherOf(m))).length;
        const b = el("school-badge");
        b.hidden = !n;
        b.textContent = n;
    }

    function renderFilters() {
        const count = id => mail.filter(m => catOf(m).id === id).length;
        const opts = [["all", "All"], ["cat:school", "School"],
            ...categories.filter(c => count(c.id)).map(c => ["cat:" + c.id, c.id === "meal" ? `${c.label} (${count(c.id)})` : c.label]),
            ["unread", "Unread"], ["teachers", "Teachers"],
            ["attach", "✨ Has attachment"], ["files", "📎 Files"],
            ...kids().map(k => ["kid:" + k, k]),
            ["dismissed", dismissedLoaded && dismissedMail.length ? `🗑 Dismissed (${dismissedMail.length})` : "🗑 Dismissed"]];
        el("school-filters").innerHTML = opts.map(([v, label]) =>
            `<button type="button" class="chip" data-filter="${escapeHtml(v)}" aria-pressed="${filter === v}">${escapeHtml(label)}</button>`).join("");
        el("school-sync-text").textContent = lastSync ? `Checked ${ago(lastSync)}` : "";
    }

    function contextHtml(sentence, title) {
        // Show the sentence it came from, with the part used as the title highlighted.
        const s = escapeHtml(sentence);
        const t = escapeHtml(title.replace(/…$/, ""));
        const i = t ? s.toLowerCase().indexOf(t.toLowerCase()) : -1;
        return i >= 0 ? s.slice(0, i) + "<mark>" + s.slice(i, i + t.length) + "</mark>" + s.slice(i + t.length) : s;
    }

    function render() {
        if (!loaded) return;
        renderFilters();
        updateBadge();

        if (filter === "dismissed") {
            el("school-list").innerHTML = dismissedHtml();
            return;
        }

        if (filter === "files") {
            const rows = mail.flatMap(m => (m.attachments || []).map((a, i) => fileRow(m, a, i, true)));
            el("school-list").innerHTML = rows.length
                ? `<ul class="file-list files-view">${rows.join("")}</ul>`
                : `<p class="empty">No attachments yet.</p>`;
            return;
        }

        // Meal alerts are shown as alert cards at the top, not as emails.
        let alerts = mail.filter(m => catOf(m).id === "meal");
        if (filter.startsWith("kid:")) alerts = alerts.filter(m => meal(m).kid === filter.slice(4));
        const showAlerts = filter === "all" || filter === "cat:meal" || filter.startsWith("kid:");
        const alertsBlock = showAlerts && alerts.length ? alertsHtml(alerts) : "";

        const list = mail.filter(m => catOf(m).id !== "meal").map(m => ({ m, who: teacherOf(m), cat: catOf(m) })).filter(({ m, who, cat }) =>
            filter === "all" ? true :
            filter === "cat:meal" ? false :
            filter.startsWith("cat:") ? cat.id === filter.slice(4) :
            filter === "unread" ? !m.read :
            filter === "attach" ? (m.attachments || []).length > 0 :
            filter === "teachers" ? !!who :
            filter.startsWith("kid:") ? (who && who.kid === filter.slice(4)) || kidIn(m) === filter.slice(4) : true);

        // Teacher emails first within each day? Keep it simple: newest first, teachers float above
        // other mail from the same day.
        list.sort((a, b) => {
            const da = ymd(new Date(a.m.date)), db = ymd(new Date(b.m.date));
            if (da !== db) return b.m.date - a.m.date;
            return (!!b.who - !!a.who) || (b.m.date - a.m.date);
        });

        if (!list.length && !alertsBlock) {
            el("school-list").innerHTML = `<p class="empty">${mail.length ? "Nothing matches this filter." :
                "No school email yet. Emails forwarded to the family account from Focus show up here within 15 minutes, or tap “Check now”."}</p>`;
            return;
        }

        el("school-list").innerHTML = alertsBlock + list.map(({ m, who, cat }) => {
            const sugg = suggestionsFor(m);
            const live = sugg.map((s, i) => ({ s, i })).filter(({ i }) => !dismissed.has(m.id + ":" + i));
            const open = openId === m.id;
            const excerpt = P.stripLinks(m.body).replace(/\s+/g, " ").trim().slice(0, 220);
            const hits = calendarHits[m.id] || new Set();
            return `
            <article class="mail ${who ? "teacher" : ""} ${m.read ? "" : "unread"}" data-mail="${escapeHtml(m.id)}">
                <div class="mail-head" data-act="toggle">
                    <span class="mail-dot"></span>
                    <div class="mail-main">
                        <div class="mail-from">
                            <strong>${escapeHtml(titleCase(m.fromName) || m.fromEmail)}</strong>
                            ${who ? `<span class="kid-tag">${escapeHtml(who.kid ? who.kid + "'s teacher" : "Teacher")}</span>` : ""}
                            ${cat !== SCHOOL ? `<span class="cat-tag">${escapeHtml(cat.label)}</span>` : ""}
                            ${cat !== SCHOOL && kidIn(m) ? `<span class="kid-tag">${escapeHtml(kidIn(m))}</span>` : ""}
                            <span class="mail-when">${escapeHtml(ago(m.date))}</span>
                            <button type="button" class="icon-btn mail-dismiss" data-act="dismiss" title="Dismiss (stays in Gmail)" aria-label="Dismiss">✕</button>
                        </div>
                        <div class="mail-subject">${escapeHtml(m.subject || "(no subject)")}</div>
                        ${open ? "" : `<div class="mail-excerpt">${escapeHtml(excerpt)}</div>`}
                        ${!open && live.length ? `<div class="mail-suggest-count">📅 ${live.length} possible event${live.length === 1 ? "" : "s"} to review</div>` : ""}
                    </div>
                    ${(m.attachments || []).length ? `<span class="attach attach-corner" title="${escapeHtml(m.attachments.length + " attachment" + (m.attachments.length === 1 ? "" : "s") + ": " + m.attachments.join(", "))}"><svg class="sparkle" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="gold-${m.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".45" stop-color="#f2c94c"/><stop offset="1" stop-color="#b8860b"/></linearGradient></defs><path fill="url(#gold-${m.id})" d="M12 1.5l2.3 6.4 6.7 2.1-6.7 2.1L12 18.5l-2.3-6.4L3 10l6.7-2.1z"/><path class="twinkle" fill="#f2c94c" d="M19 15l.9 2.4 2.4.9-2.4.9L19 21.6l-.9-2.4-2.4-.9 2.4-.9z"/><path class="twinkle t2" fill="#f2c94c" d="M5 15.5l.6 1.6 1.6.6-1.6.6L5 19.9l-.6-1.6-1.6-.6 1.6-.6z"/></svg>${m.attachments.length > 1 ? `<span class="attach-n">${m.attachments.length}</span>` : ""}</span>` : ""}
                </div>
                ${open ? `
                <div class="mail-body">
                    ${live.map(({ s, i }) => `
                        <div class="suggest ${hits.has(i) ? "done" : ""}" data-sug="${i}">
                            <div class="suggest-head">
                                <span class="suggest-what">📅 ${escapeHtml(s.title)}</span>
                                <span class="suggest-when">${escapeHtml(whenLabel(s))}</span>
                            </div>
                            <div class="suggest-context">“${contextHtml(s.sentence, s.title)}”</div>
                            <div class="mail-actions">
                                ${hits.has(i) ? `<span class="roster-help">Already on the calendar</span>` :
                                    `<button class="btn-sm" data-act="add">Review &amp; add…</button>`}
                                <button class="btn-sm btn-secondary" data-act="skip">Not an event</button>
                            </div>
                        </div>`).join("")}
                    ${(m.attachments || []).length ? `
                    <div class="attach-list">
                        <span class="attach"><svg class="sparkle" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="gold-${m.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".45" stop-color="#f2c94c"/><stop offset="1" stop-color="#b8860b"/></linearGradient></defs><path fill="url(#gold-${m.id})" d="M12 1.5l2.3 6.4 6.7 2.1-6.7 2.1L12 18.5l-2.3-6.4L3 10l6.7-2.1z"/><path class="twinkle" fill="#f2c94c" d="M19 15l.9 2.4 2.4.9-2.4.9L19 21.6l-.9-2.4-2.4-.9 2.4-.9z"/><path class="twinkle t2" fill="#f2c94c" d="M5 15.5l.6 1.6 1.6.6-1.6.6L5 19.9l-.6-1.6-1.6-.6 1.6-.6z"/></svg></span>
                        <div>
                            <strong>${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"}</strong>. Could be a schedule or a form.
                            <ul class="file-list">${m.attachments.map((a, i) => fileRow(m, a, i, false)).join("")}</ul>
                            ${m.link ? `<a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">Open in Gmail to view or download ↗</a>` : ""}
                        </div>
                    </div>` : ""}
                    <div class="mail-view">${viewInner(m)}</div>
                    <div class="mail-actions">
                        <button class="btn-sm btn-secondary" data-act="unread">Mark unread</button>
                        <button class="btn-sm btn-secondary" data-act="dismiss">Dismiss</button>
                        ${m.link ? `<a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">Open in Gmail ↗</a>` : ""}
                    </div>
                </div>` : ""}
            </article>`;
        }).join("");
        hydrateFrames();
    }

    /** Dismissed view: only a link is kept, so each email here was just read from Gmail. */
    function dismissedHtml() {
        if (!dismissedLoaded) return `<p class="empty">Loading dismissed email from Gmail…</p>`;
        const help = `<p class="roster-help dismissed-help">Emails you dismissed in the last ${keepDays} days. The app keeps only a link to each one, and the link deletes itself after ${keepDays} days. The emails stay in Gmail either way.</p>`;
        if (!dismissedMail.length) return help + `<p class="empty">Nothing dismissed in the last ${keepDays} days.</p>`;
        return help + dismissedMail.map(d => {
            const daysLeft = Math.max(0, Math.ceil((d.expiresAt - Date.now()) / DAY));
            const open = openDismissed === d.id;
            const gmail = `<a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">Open in Gmail ↗</a>`;
            const meta = `<span class="mail-when">dismissed ${escapeHtml(ago(d.dismissedAt))} · link expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}</span>`;
            if (d.missing) {
                return `<article class="mail dismissed-mail" data-dis="${escapeHtml(d.id)}">
                    <div class="mail-head"><div class="mail-main">
                        <div class="mail-from"><strong>No longer in Gmail</strong> ${meta}</div>
                        <div class="mail-subject">This email was deleted from the family Gmail.</div>
                    </div></div>
                </article>`;
            }
            const excerpt = P.stripLinks(d.body || "").replace(/\s+/g, " ").trim().slice(0, 220);
            return `
            <article class="mail dismissed-mail" data-dis="${escapeHtml(d.id)}">
                <div class="mail-head" data-act="toggle">
                    <div class="mail-main">
                        <div class="mail-from">
                            <strong>${escapeHtml(titleCase(d.fromName) || d.fromEmail)}</strong>
                            <span class="mail-when">${escapeHtml(ago(d.date))}</span>
                        </div>
                        <div class="mail-subject">${escapeHtml(d.subject || "(no subject)")}</div>
                        ${open ? "" : `<div class="mail-excerpt">${escapeHtml(excerpt)}</div>`}
                        <div class="dismissed-meta">${meta}</div>
                    </div>
                </div>
                ${open ? `<div class="mail-body"><div class="mail-text">${textHtml(d.body)}</div></div>` : ""}
                <div class="mail-actions">
                    <button class="btn-sm" data-act="restore">Restore</button>
                    <button class="btn-sm btn-secondary" data-act="toggle">${open ? "Hide" : "Read"}</button>
                    ${gmail}
                </div>
            </article>`;
        }).join("");
    }

    // ---------- showing an email the way Gmail would ----------

    /** Plain text, with "<https://…>" blobs and bare URLs turned into small "🔗 link" links. */
    function textHtml(body) {
        const t = String(body || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
        const re = /<(https?:\/\/[^>]+)>|(https?:\/\/[^\s<>"]+)/gi;
        let out = "", last = 0, x;
        while ((x = re.exec(t))) {
            out += escapeHtml(t.slice(last, x.index));
            const url = (x[1] || x[2]).replace(/\s+/g, "");
            out += `<a class="text-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">🔗 link</a>`;
            last = re.lastIndex;
        }
        return out + escapeHtml(t.slice(last));
    }

    /** Formatted email once loaded; cleaned-up text meanwhile, or when there's no formatted version. */
    function viewInner(m) {
        if (m._html === undefined) fetchHtml(m);
        if (m._html) {
            return `<iframe class="mail-frame" data-frame="${escapeHtml(m.id)}" title="Email"
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`;
        }
        return `<div class="mail-text">${textHtml(m.body)}</div>`;
    }

    async function fetchHtml(m) {
        if (m._htmlLoading) return;
        m._htmlLoading = true;
        try {
            const res = await api("GET", { what: "mailhtml", id: m.id });
            m._html = res.html || "";
        } catch (e) {
            m._html = "";
        }
        if (openId === m.id) render();
    }

    // The email's own HTML goes in a locked-down frame: no scripts or forms run (sandbox has no
    // allow-scripts / allow-forms) and links open in a new tab.
    function frameDoc(html) {
        const head = `<base target="_blank"><meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                html, body { margin: 0; background: #fff; color: #222; }
                body { padding: 14px; font: 14px/1.5 Arial, Helvetica, sans-serif; overflow-wrap: anywhere; }
                img { max-width: 100% !important; height: auto !important; }
                table { max-width: 100% !important; }
                a { color: #1a73e8; }
                pre { white-space: pre-wrap; }
            </style>`;
        return /<head[^>]*>/i.test(html)
            ? html.replace(/<head[^>]*>/i, h => h + head)
            : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
    }

    function hydrateFrames() {
        document.querySelectorAll("#school-list iframe[data-frame]").forEach(f => {
            const m = mail.find(x => x.id === f.dataset.frame);
            if (!m || !m._html) return;
            f.addEventListener("load", () => fitFrame(f), { once: true });
            f.srcdoc = frameDoc(m._html);
        });
    }

    function fitFrame(f) {
        try {
            const d = f.contentDocument;
            if (!d) return;
            const fit = () => {
                const h = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
                f.style.height = Math.min(h + 2, 5000) + "px";
            };
            fit();
            d.querySelectorAll("img").forEach(i => i.addEventListener("load", fit));
            setTimeout(fit, 800);
        } catch (e) { /* leave the default height */ }
    }

    // ---------- attachments: view / download ----------

    function fileIcon(name) {
        const ext = String(name).split(".").pop().toLowerCase();
        if (ext === "pdf") return "📄";
        if (/^(png|jpe?g|gif|webp|heic|bmp|svg)$/.test(ext)) return "🖼️";
        if (/^(docx?|rtf|odt|txt|pages)$/.test(ext)) return "📝";
        if (/^(xlsx?|csv|ods|numbers)$/.test(ext)) return "📊";
        if (/^(pptx?|key|odp)$/.test(ext)) return "📽️";
        return "📎";
    }

    function fileRow(m, name, i, showFrom) {
        return `<li class="file-row" data-mail="${escapeHtml(m.id)}" data-file="${i}">
            <span class="file-icon" aria-hidden="true">${fileIcon(name)}</span>
            <span class="file-name">${escapeHtml(name)}
                ${showFrom ? `<span class="file-from">${escapeHtml(titleCase(m.fromName) || m.fromEmail)} · ${escapeHtml(ago(m.date))} · ${escapeHtml(m.subject || "")}</span>` : ""}
            </span>
            <span class="file-actions">
                <button type="button" class="btn-sm" data-act="file-view">View</button>
                <button type="button" class="btn-sm btn-secondary" data-act="file-dl">Download</button>
            </span>
        </li>`;
    }

    const fileCache = new Map();      // "mailId:index" -> { name, type, url }
    async function getFile(m, i) {
        const key = m.id + ":" + i;
        if (fileCache.has(key)) return fileCache.get(key);
        const res = await api("GET", { what: "attachment", id: m.id, i });
        const bin = atob(res.data);
        const bytes = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
        const file = { name: res.name, type: res.type, url: URL.createObjectURL(new Blob([bytes], { type: res.type })) };
        fileCache.set(key, file);
        return file;
    }

    function download(file) {
        const a = document.createElement("a");
        a.href = file.url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    const isPhone = () => window.matchMedia("(pointer: coarse)").matches;

    async function openFile(m, i, mode, btn) {
        const label = btn ? btn.textContent : "";
        if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
        try {
            const f = await getFile(m, i);
            const isImage = /^image\//.test(f.type);
            const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
            // Phones can't show a PDF inside a page: hand it to the phone's PDF viewer instead.
            if (mode === "dl" || (!isImage && !isPdf) || (isPdf && isPhone())) { download(f); return; }
            el("viewer-name").textContent = f.name;
            el("viewer-body").innerHTML = isImage
                ? `<img src="${f.url}" alt="${escapeHtml(f.name)}">`
                : `<iframe src="${f.url}" title="${escapeHtml(f.name)}"></iframe>`;
            el("viewer-dl").onclick = () => download(f);
            el("file-viewer").style.display = "flex";
        } catch (err) {
            showToast("Couldn't open the file: " + err.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = label; }
        }
    }

    function closeViewer() {
        el("file-viewer").style.display = "none";
        el("viewer-body").innerHTML = "";
    }
    el("viewer-close").addEventListener("click", closeViewer);
    el("file-viewer").addEventListener("click", e => { if (e.target.id === "file-viewer") closeViewer(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && el("file-viewer").style.display === "flex") closeViewer(); });

    function alertsHtml(alerts) {
        return `<section class="meal-alerts">` + alerts.map(m => {
            const s = meal(m);
            const open = openId === m.id;
            const neg = s.balance !== null && s.balance < 0;
            return `
            <div class="meal-alert ${neg ? "neg" : ""}" data-mail="${escapeHtml(m.id)}">
                <div class="meal-icon" aria-hidden="true">🍽</div>
                <div class="meal-main">
                    <div class="meal-kind">Meal Account Alert · ${escapeHtml(ago(m.date))}</div>
                    <div class="meal-line">
                        <strong>${escapeHtml(s.kid || "Lunch account")}</strong>
                        ${s.balanceText ? `<span class="meal-bal">${escapeHtml(s.balanceText)}</span>` : `<span class="meal-sub">balance not found, see email</span>`}
                    </div>
                    <div class="meal-sub">${escapeHtml(m.subject || "")}</div>
                </div>
                <div class="meal-actions">
                    <button class="btn-sm" data-act="handled">Took care of it</button>
                    <button class="btn-sm btn-secondary" data-act="toggle">${open ? "Hide email" : "View email"}</button>
                </div>
                ${open ? `<div class="mail-text meal-text">${textHtml(m.body)}</div>` : ""}
            </div>`;
        }).join("") + `</section>`;
    }

    /** "Took care of it": clears this alert and any older ones for the same child. */
    async function handled(m) {
        const kid = meal(m).kid;
        const ids = mail.filter(x => catOf(x).id === "meal" && x.date <= m.date && meal(x).kid === kid).map(x => x.id);
        mail = mail.filter(x => !ids.includes(x.id));
        openId = null;
        render();
        try { await api("POST", { action: "mail.dismiss", ids }); loadDismissed(); }
        catch (err) { el("school-error").textContent = "Couldn't save: " + err.message; load(); }
    }

    function whenLabel(s) {
        const day = s.start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
        if (!s.allDay) return `${day} · ${fmtTime(s.start)}`;
        const last = new Date(s.end.getTime() - DAY);
        return ymd(last) === ymd(s.start) ? `${day} · All day`
            : `${day} – ${last.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
    }

    // ---------- roster ----------

    function renderRoster() {
        el("roster-count").textContent = roster.length ? `(${roster.length})` : "(none yet)";
        if (document.activeElement !== el("roster-text")) {
            el("roster-text").value = roster.map(r => r.kid ? `${r.name} - ${r.kid}` : r.name).join("\n");
        }
    }

    async function saveRoster() {
        const rows = el("roster-text").value.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
            const m = /^(.*?)\s*(?:-|–|:|,)\s*([^-–:,]+)$/.exec(l);
            return m ? { name: m[1].trim(), kid: m[2].trim() } : { name: l, kid: "" };
        });
        const btn = el("roster-save");
        btn.disabled = true;
        try {
            apply(await api("POST", { action: "roster.save", rows }));
            el("roster-msg").textContent = `Saved ${rows.length} teacher${rows.length === 1 ? "" : "s"}.`;
        } catch (err) {
            el("roster-msg").textContent = "Couldn't save: " + err.message;
        } finally {
            btn.disabled = false;
        }
    }

    // ---------- sender rules editor ----------

    function ruleRow(r) {
        return `<div class="rule-row">
            <input class="input" data-f="match" placeholder="sender contains… e.g. example.org" value="${escapeHtml(r.match || "")}" maxlength="200">
            <input class="input" data-f="label" placeholder="Category" value="${escapeHtml(r.label || "")}" maxlength="100">
            <label class="check-row" title="Show the dollar balance and child as an alert card"><input type="checkbox" data-f="meal" ${r.kind === "meal" ? "checked" : ""}> Balance alert</label>
            <button type="button" class="icon-btn danger" data-act="rm" aria-label="Remove rule">✕</button>
        </div>`;
    }

    function renderRules() {
        el("rules-count").textContent = rules.length ? `(${rules.length})` : "(none yet)";
        if (el("rules").contains(document.activeElement)) return;     // don't wipe what's being typed
        el("rules-rows").innerHTML = (rules.length ? rules : [{}]).map(ruleRow).join("");
    }

    el("rules-add").addEventListener("click", () => {
        el("rules-rows").insertAdjacentHTML("beforeend", ruleRow({}));
        el("rules-rows").lastElementChild.querySelector("input").focus();
    });
    el("rules-rows").addEventListener("click", e => {
        if (e.target.closest("[data-act='rm']")) e.target.closest(".rule-row").remove();
    });
    el("rules-save").addEventListener("click", async () => {
        const rows = [...el("rules-rows").querySelectorAll(".rule-row")].map(r => ({
            match: r.querySelector("[data-f='match']").value.trim(),
            label: r.querySelector("[data-f='label']").value.trim(),
            kind: r.querySelector("[data-f='meal']").checked ? "meal" : "group"
        })).filter(r => r.match || r.label);
        const bad = rows.find(r => !r.match || !r.label);
        if (bad) { el("rules-msg").textContent = "Each rule needs both the sender text and a category."; return; }
        const btn = el("rules-save");
        btn.disabled = true;
        try {
            apply(await api("POST", { action: "rules.save", rows }));
            el("rules-msg").textContent = `Saved ${rows.length} rule${rows.length === 1 ? "" : "s"}.`;
        } catch (err) {
            el("rules-msg").textContent = "Couldn't save: " + err.message;
        } finally {
            btn.disabled = false;
        }
    });

    // ---------- events ----------

    el("school-filters").addEventListener("click", e => {
        const b = e.target.closest("[data-filter]");
        if (!b) return;
        filter = b.dataset.filter;
        if (filter === "dismissed") loadDismissed();     // pick up dismissals from the other phone
        render();
    });
    el("school-sync-btn").addEventListener("click", syncNow);
    el("roster-save").addEventListener("click", saveRoster);

    el("school-list").addEventListener("click", e => {
        const fileBtn = e.target.closest("[data-act='file-view'], [data-act='file-dl']");
        if (fileBtn) {
            const row = fileBtn.closest("[data-file]");
            const fm = mail.find(x => x.id === row.dataset.mail);
            if (fm) openFile(fm, Number(row.dataset.file), fileBtn.dataset.act === "file-dl" ? "dl" : "view", fileBtn);
            return;
        }
        const disCard = e.target.closest("[data-dis]");
        if (disCard) {
            if (e.target.closest("a")) return;
            const d = dismissedMail.find(x => x.id === disCard.dataset.dis);
            const dact = e.target.closest("[data-act]");
            if (!d || !dact) return;
            if (dact.dataset.act === "restore") restoreMail(d, dact);
            else if (dact.dataset.act === "toggle") { openDismissed = openDismissed === d.id ? null : d.id; render(); }
            return;
        }
        const card = e.target.closest("[data-mail]");
        if (!card || e.target.closest("a")) return;
        const m = mail.find(x => x.id === card.dataset.mail);
        if (!m) return;
        const act = e.target.closest("[data-act]")?.dataset.act;
        const sugEl = e.target.closest("[data-sug]");
        const s = sugEl ? suggestionsFor(m)[Number(sugEl.dataset.sug)] : null;

        if (act === "toggle") {
            openId = openId === m.id ? null : m.id;
            if (openId) { setRead(m, true); checkCalendar(m); }
            render();
        } else if (act === "handled") {
            handled(m);
        } else if (act === "unread") {
            openId = null;
            setRead(m, false);
        } else if (act === "dismiss") {
            dismissMail(m);
        } else if (act === "skip" && sugEl) {
            dismissed.add(m.id + ":" + sugEl.dataset.sug);
            saveDismissed();
            render();
        } else if (act === "add" && s) {
            // Approval step: the normal event form, pre-filled, so it can be checked and fixed first.
            openModal(null, s.allDay
                ? { allDay: true, startStr: ymd(s.start), endStr: ymd(s.end) }
                : { allDay: false, start: s.start, end: s.end });
            $("title").value = s.title.replace(/…$/, "");
            $("modal-error").textContent = "From: " + titleCase(m.fromName) + " · check the details, then Save.";
            $("modal-error").classList.add("info");
            pendingAdd = { m, i: Number(sugEl.dataset.sug) };
        }
    });

    // After an event is saved, re-check that email's suggestions against the real calendar
    // (works whether the form was saved or cancelled).
    let pendingAdd = null;
    const origRefresh = window.refreshAll;
    window.refreshAll = function () {
        const r = origRefresh.apply(this, arguments);
        if (pendingAdd) {
            const m = pendingAdd.m;
            pendingAdd = null;
            delete calendarHits[m.id];
            setTimeout(() => checkCalendar(m), 1500);
        }
        return r;
    };

    // Coming back to the app (switching from another app or tab): refresh, and check Gmail
    // if it's been a couple of minutes. Keeps the School badge current on every tab.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && idToken && loaded) load();
    });

    // ---------- Settings screen (gear icon left of the title) ----------

    function openSettings() {
        el("settings").style.display = "flex";
        renderRules();
        renderRoster();
        load();                          // pick up edits made on the other phone
        if (window.FamilyTags) FamilyTags.reload();
    }
    function closeSettings() { el("settings").style.display = "none"; }

    document.addEventListener("click", e => {
        if (e.target.closest("[data-open-settings]")) openSettings();
    });
    el("settings-close").addEventListener("click", closeSettings);
    el("settings").addEventListener("click", e => { if (e.target.id === "settings") closeSettings(); });
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && el("settings").style.display === "flex") closeSettings();
    });

    window.FamilySchool = { load, render, openSettings };
})();

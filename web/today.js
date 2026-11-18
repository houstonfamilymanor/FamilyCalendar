/**
 * Family Command — Today: the day at a glance (the landing tab).
 *
 * Everything for today only, in one place:
 *   - heads-up: feeds that can't be read, meal-account alerts, school email that says
 *     something happens today, unread teacher email
 *   - today's schedule from the family calendar (done / now / next)
 *   - one card per kid: letter day, lunch, school events
 * Unlike the Calendar tab, nothing here is hidden by the tag chips.
 *
 * Read-only: it draws from what the other parts already loaded (index.html's dashboardAll,
 * FamilyKids, FamilySchool) and never makes its own server calls.
 * Uses globals from index.html: dashboardAll, dashboardState, escapeHtml, fmtTime, startOfDay,
 * DAY, showTab, openEditModal, calendar.
 */
(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const esc = s => escapeHtml(s);

    function greeting(now) {
        const h = now.getHours();
        return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    }

    function untilText(ms) {
        const mins = Math.round(ms / 60000);
        if (mins < 1) return "now";
        if (mins < 60) return `in ${mins} min`;
        const h = Math.floor(mins / 60), m = mins % 60;
        return `in ${h} hr${m ? " " + m + " min" : ""}`;
    }

    // ---------- pieces ----------

    let shown = [];   // schedule events on screen, for clicks

    function scheduleHtml(now) {
        if (dashboardState === "loading") return `<p class="empty">Loading…</p>`;
        if (dashboardState !== "ok") return `<p class="error">Couldn't load today's events: ${esc(dashboardState)}</p>`;
        const today = startOfDay(now), tomorrow = new Date(today.getTime() + DAY);
        shown = dashboardAll.filter(ev => ev.start < tomorrow && ev.end > today);
        if (!shown.length) return `<p class="empty">Nothing on the family calendar today.</p>`;

        const allDay = shown.filter(ev => ev.allDay);
        const timed = shown.filter(ev => !ev.allDay).sort((a, b) => a.start - b.start);
        const next = timed.find(ev => ev.start > now);
        let html = "";
        if (allDay.length) {
            html += `<div class="td-allday">${allDay.map((ev, i) =>
                `<button type="button" class="td-chip ${ev.recurring ? "recurring" : ""}" data-ev="${shown.indexOf(ev)}">${esc(ev.title)}</button>`).join("")}</div>`;
        }
        let nowDrawn = false;
        const nowLine = `<div class="td-now"><span>Now · ${esc(fmtTime(now))}</span></div>`;
        for (const ev of timed) {
            const done = ev.end <= now, on = ev.start <= now && ev.end > now;
            if (!nowDrawn && ev.start > now) { html += nowLine; nowDrawn = true; }
            const multi = ev.start < today;   // started yesterday
            const note = on ? `<span class="td-note on">happening now</span>`
                : ev === next ? `<span class="td-note">${esc(untilText(ev.start - now))}</span>` : "";
            html += `<div class="td-row ${done ? "done" : ""} ${on ? "on" : ""} ${ev.recurring ? "recurring" : ""}" data-ev="${shown.indexOf(ev)}">
                <span class="td-time">${done ? "✓ " : ""}${esc(multi ? "…" : fmtTime(ev.start))}</span>
                <span class="td-what">${esc(ev.title)}${FamilyTags.badges(ev)}</span>
                ${note}
            </div>`;
        }
        if (timed.length && !nowDrawn && timed[timed.length - 1].end <= now) html += `<p class="td-done">All done for today.</p>`;
        return html;
    }

    function menuHtml(label, m) {
        if (m.note) return `<div class="td-menu"><span class="td-label">${esc(label)}</span>${esc(FamilyKids.titleCase(m.note))}</div>`;
        if (!m.entrees.length) return "";
        return `<div class="td-menu"><span class="td-label">${esc(label)}</span>${m.entrees.map(esc).join(" <span class='td-or'>or</span> ")}
            ${m.sides.length ? `<div class="td-sides">with ${m.sides.map(esc).join(", ")}</div>` : ""}</div>`;
    }

    function kidHtml(k) {
        const e = k.errors || {};
        const parts = [];
        if (k.letter) {
            parts.push(`<div class="td-letter"><span class="td-letter-big">${esc(k.letter.label)}</span>
                ${k.letter.meaning ? `<span>${esc(k.letter.meaning)}</span>`
                    : `<span class="td-muted">Add what it means in <button type="button" class="link-btn" data-open-settings>⚙ Settings</button></span>`}</div>`);
        }
        if (k.lunch) {
            parts.push(k.lunch.isNote ? `<div class="td-menu"><span class="td-label">Lunch</span>🏫 ${esc(k.lunch.text)}</div>`
                : menuHtml("Lunch", k.lunch.lunch) + menuHtml("Breakfast", k.lunch.breakfast));
        } else if (k.has.lunch && !e.lunch) {
            parts.push(`<div class="td-menu td-muted"><span class="td-label">Lunch</span>No menu posted for today.</div>`);
        }
        for (const ev of k.events) {
            const when = ev.allDay ? "All day" : fmtTime(new Date(ev.start)) + (ev.end > ev.start ? " – " + fmtTime(new Date(ev.end)) : "");
            parts.push(`<div class="td-sev">📌 <strong>${esc(ev.title)}</strong> <span class="td-muted">${esc(when)}</span></div>`);
        }
        if (e.lunch) parts.push(`<p class="lunch-trouble">I can't see the menu 😞 TROUBLESHOOTING TIME!</p>`);
        if (e.events || e.letters) parts.push(`<p class="lunch-trouble">I can't see the school calendar 😞 TROUBLESHOOTING TIME!</p>`);
        if (!parts.length) parts.push(`<p class="td-muted">${k.pending ? "⏳ Still reading the school site…" : "Nothing from school today."}</p>`);
        return `<div class="panel td-kid"><h2>${esc(k.name)}</h2>${parts.join("")}</div>`;
    }

    function kidsHtml() {
        const kids = FamilyKids.today();
        if (!kids) return `<div class="panel td-kid"><h2>School</h2><p class="empty">Loading…</p></div>`;
        if (!kids.length) {
            return `<div class="panel td-kid"><h2>School</h2><p class="td-muted">Add the kids' schools in
                <button type="button" class="link-btn" data-open-settings>⚙ Settings</button> to see lunch and letter days here.</p></div>`;
        }
        return kids.map(kidHtml).join("");
    }

    function headsUpHtml() {
        const a = window.FamilySchool && FamilySchool.attention();
        if (!a) return "";
        const rows = [];
        for (const m of a.meals) {
            rows.push(`<button type="button" class="td-alert ${m.balance < 0 ? "neg" : ""}" data-mail="${esc(m.id)}">🍽 <strong>${esc(m.kid || "Lunch account")}</strong>
                ${m.balanceText ? `lunch balance <strong>${esc(m.balanceText)}</strong>` : "lunch account alert"}</button>`);
        }
        for (const s of a.mentions) {
            rows.push(`<button type="button" class="td-alert" data-mail="${esc(s.id)}">📧 <strong>${esc(s.title)}</strong>
                <span class="td-muted">${esc(s.allDay ? "today" : fmtTime(s.start))} · from ${esc(s.from)}'s email</span></button>`);
        }
        if (a.unread) {
            rows.push(`<button type="button" class="td-alert" data-tab-go="school">✉️ <strong>${a.unread}</strong> unread teacher email${a.unread === 1 ? "" : "s"}</button>`);
        }
        return rows.length ? `<div class="td-heads">${rows.join("")}</div>` : "";
    }

    // ---------- the page ----------

    function render() {
        const view = el("today-view");
        if (!view || typeof dashboardAll === "undefined") return;
        const now = new Date();
        const kids = FamilyKids.today() || [];
        const letters = [...new Set(kids.map(k => k.letter && k.letter.label).filter(Boolean))];

        const today = startOfDay(now), tomorrow = new Date(today.getTime() + DAY);
        const left = dashboardState === "ok"
            ? dashboardAll.filter(ev => ev.start < tomorrow && ev.end > now && !ev.allDay).length : null;
        const sub = [
            left === null ? "" : left ? `${left} ${left === 1 ? "thing" : "things"} still ahead` : "",
            letters.join(" / ")
        ].filter(Boolean).join(" · ");

        el("td-greet").textContent = greeting(now);
        el("td-date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
        el("td-sub").textContent = sub;
        el("td-heads").innerHTML = headsUpHtml();
        el("td-schedule").innerHTML = scheduleHtml(now);
        el("td-kids").innerHTML = kidsHtml();
    }

    el("today-view").addEventListener("click", e => {
        const evEl = e.target.closest("[data-ev]");
        if (evEl) {
            const ev = shown[Number(evEl.dataset.ev)];
            if (!ev) return;
            if (ev.recurring) {
                showTab("calendar");
                calendar.changeView("timeGridDay", ev.start);
            } else {
                openEditModal(ev);
            }
            return;
        }
        const mailEl = e.target.closest("[data-mail]");
        if (mailEl) { FamilySchool.openMail(mailEl.dataset.mail); return; }
        const tabEl = e.target.closest("[data-tab-go]");
        if (tabEl) showTab(tabEl.dataset.tabGo);
    });

    window.FamilyToday = { render };
})();

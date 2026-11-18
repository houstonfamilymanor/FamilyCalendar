/**
 * Family Command — event tags.
 *
 * Tags (name, color, "hide until turned on") are made and edited in Settings and stored
 * in the family Sheet (apps-script/Tags.js). Events carry tag ids. The chips above the
 * calendar turn tags on/off on this device; a "detail" tag (e.g. Lunch menu) starts off,
 * so that kind of event is there when you want it and out of the way when you don't.
 *
 * An event shows when it has no tags, or when at least one of its tags is turned on.
 *
 * Uses globals from index.html: api, calendar, escapeHtml, renderDashboard, $.
 */
(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const PALETTE = ["#e57373", "#f2a65a", "#e6c84f", "#7cc576", "#4fb3bf", "#6c8ef5", "#a77bd8", "#d97aa6", "#8d9aa8"];

    let tags = [];
    let builtins = [];               // filters the app adds itself (one per kid's lunch menu): chips only
    let loadedPromise = null;
    const allTags = () => builtins.concat(tags);

    // Per-device on/off choices: { tagId: true|false }. Unset = the tag's shared default.
    let choice = {};
    try { choice = JSON.parse(localStorage.getItem("tag-filter") || "{}") || {}; } catch (e) {}
    const saveChoice = () => { try { localStorage.setItem("tag-filter", JSON.stringify(choice)); } catch (e) {} };

    const byId = id => allTags().find(t => t.id === id);
    const isOn = t => (t.id in choice) ? choice[t.id] : !t.hidden;
    const isOnId = id => { const t = byId(id); return !!t && isOn(t); };

    function setBuiltins(list) {
        builtins = list || [];
        renderFilters();
    }

    // ---------- loading ----------

    function setTags(list) {
        tags = list || [];
        renderFilters();
        renderPicker();
        renderEditor();
    }

    /** Loads once per sign-in; the calendar waits on this so hidden tags never flash. */
    function ready() {
        if (!loadedPromise) {
            loadedPromise = api("GET", { what: "tags" })
                .then(res => setTags(res.tags))
                .catch(err => { loadedPromise = null; el("tags-msg").textContent = "Couldn't load tags: " + err.message; });
        }
        return loadedPromise;
    }

    function reload() {
        loadedPromise = null;
        return ready().then(applyToCalendar);
    }

    // ---------- event helpers (used by index.html) ----------

    const tagsOf = ev => (ev.tags || []).map(byId).filter(Boolean);

    function visible(ev) {
        const t = tagsOf(ev);
        return !t.length || t.some(isOn);
    }

    function color(ev) {
        const t = tagsOf(ev);
        return t.length ? t[0].color : "";
    }

    /** Small colored tag names for dashboard rows. */
    function badges(ev) {
        return tagsOf(ev).map(t => `<span class="tag-badge" style="--tag:${escapeHtml(t.color)}">${escapeHtml(t.name)}</span>`).join("");
    }

    // ---------- filter chips above the calendar ----------

    function renderFilters() {
        const box = el("tag-filters");
        const list = allTags();
        if (!list.length) { box.hidden = true; box.innerHTML = ""; return; }
        box.hidden = false;
        box.innerHTML = `<span class="tag-filters-label">Show:</span>` + list.map(t => `
            <button type="button" class="chip tag-chip ${t.hidden ? "detail" : ""}" data-tag="${escapeHtml(t.id)}"
                aria-pressed="${isOn(t)}" style="--tag:${escapeHtml(t.color)}"
                title="${isOn(t) ? "Showing" : "Hidden"}${t.hidden ? " · detail tag (off unless you turn it on)" : ""}">
                <span class="tag-dot"></span>${escapeHtml(t.name)}</button>`).join("");
    }

    el("tag-filters").addEventListener("click", e => {
        const b = e.target.closest("[data-tag]");
        if (!b) return;
        const t = byId(b.dataset.tag);
        if (!t) return;
        choice[t.id] = !isOn(t);
        if (choice[t.id] === !t.hidden) delete choice[t.id];     // back to the default: forget it
        saveChoice();
        renderFilters();
        applyToCalendar();
    });

    /** Show/hide events already on the calendar without fetching them again. */
    function applyToCalendar() {
        if (window.calendar) {
            calendar.batchRendering(() => {
                calendar.getEvents().forEach(e => {
                    const ev = { tags: e.extendedProps.tags || [] };
                    const want = visible(ev) ? "auto" : "none";
                    if (e.display !== want) e.setProp("display", want);
                    const c = color(ev);
                    if ((e.extendedProps.tagColor || "") !== c) e.setExtendedProp("tagColor", c);
                });
            });
        }
        if (typeof renderDashboard === "function") renderDashboard();
    }

    // ---------- picker in the event form ----------

    let picked = new Set();

    function renderPicker() {
        // Only there once tags exist; tags are made and edited in Settings, not here.
        el("tag-picker-group").hidden = !tags.length;
        el("tag-picker").innerHTML = tags.map(t => `
            <button type="button" class="chip tag-chip" data-pick="${escapeHtml(t.id)}" aria-pressed="${picked.has(t.id)}"
                style="--tag:${escapeHtml(t.color)}"><span class="tag-dot"></span>${escapeHtml(t.name)}</button>`).join("");
    }

    /** Called by openModal with the event's tags. */
    function setPicked(ids) {
        picked = new Set(ids || []);
        renderPicker();
    }
    const getPicked = () => [...picked].filter(id => tags.some(t => t.id === id));

    el("tag-picker").addEventListener("click", e => {
        const b = e.target.closest("[data-pick]");
        if (!b || b.disabled) return;
        const id = b.dataset.pick;
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        renderPicker();
    });

    // ---------- tag editor in Settings ----------

    function editorRow(t) {
        return `<div class="tag-row" data-id="${escapeHtml(t.id || "")}">
            <input type="color" class="tag-color" data-f="color" value="${escapeHtml(t.color || PALETTE[0])}" aria-label="Tag color">
            <input class="input" data-f="name" placeholder="Tag name, e.g. Lunch menu" value="${escapeHtml(t.name || "")}" maxlength="60">
            <label class="check-row" title="Events with only this tag stay off the calendar until someone turns the tag on">
                <input type="checkbox" data-f="hidden" ${t.hidden ? "checked" : ""}> Hide until turned on</label>
            <button type="button" class="icon-btn danger" data-act="rm" aria-label="Remove tag">✕</button>
        </div>`;
    }

    function renderEditor() {
        el("tags-count").textContent = tags.length ? `(${tags.length})` : "(none yet)";
        if (el("tags").contains(document.activeElement)) return;     // don't wipe what's being typed
        el("tags-rows").innerHTML = (tags.length ? tags : [{}]).map(editorRow).join("");
    }

    el("tags-add").addEventListener("click", () => {
        const n = el("tags-rows").children.length;
        el("tags-rows").insertAdjacentHTML("beforeend", editorRow({ color: PALETTE[n % PALETTE.length] }));
        el("tags-rows").lastElementChild.querySelector("[data-f='name']").focus();
    });
    el("tags-rows").addEventListener("click", e => {
        if (e.target.closest("[data-act='rm']")) e.target.closest(".tag-row").remove();
    });
    el("tags-save").addEventListener("click", async () => {
        const rows = [...el("tags-rows").querySelectorAll(".tag-row")].map(r => ({
            id: r.dataset.id || undefined,
            name: r.querySelector("[data-f='name']").value.trim(),
            color: r.querySelector("[data-f='color']").value,
            hidden: r.querySelector("[data-f='hidden']").checked
        })).filter(r => r.name);
        const removed = tags.filter(t => !rows.some(r => r.id === t.id));
        if (removed.length && !confirm(`Delete ${removed.map(t => `"${t.name}"`).join(", ")}? It comes off every event (the events stay).`)) return;
        const btn = el("tags-save");
        btn.disabled = true;
        try {
            const res = await api("POST", { action: "tags.save", rows });
            el("tags").contains(document.activeElement) && document.activeElement.blur();
            setTags(res.tags);
            applyToCalendar();
            el("tags-msg").textContent = `Saved ${rows.length} tag${rows.length === 1 ? "" : "s"}.`;
        } catch (err) {
            el("tags-msg").textContent = "Couldn't save: " + err.message;
        } finally {
            btn.disabled = false;
        }
    });

    window.FamilyTags = { ready, reload, visible, color, badges, setPicked, getPicked, applyToCalendar, renderEditor, setBuiltins, isOnId };
})();

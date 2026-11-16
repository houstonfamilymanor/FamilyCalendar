/**
 * Family Command — voice/text assistant.
 *
 * Listening: the browser's built-in speech recognition (Chrome/Edge/Android use
 * Google's service, iPhone Safari uses Apple's; free, no key).
 * Talking back: the browser's built-in voices (Edge has Microsoft's natural voices).
 * Understanding: parser.js (keywords, dates, times; no AI).
 *
 * Uses globals from index.html's main script: api, dataAction, loadData, data,
 * dataLoaded, selectedListId, renderLists, showTab, refreshAll, dashboardEvents,
 * openModal, openNote, ymd, fmtTime, escapeHtml, HOUR, DAY, $.
 */
(function () {
    "use strict";

    const P = window.FamilyParser;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const canListen = !!SR;
    const canSpeak = "speechSynthesis" in window;

    const el = id => document.getElementById(id);
    const sheet = el("asst"), log = el("asst-log"), interimEl = el("asst-interim"),
        statusEl = el("asst-status"), input = el("asst-input"), micBtn = el("asst-mic");

    let rec = null;              // the active SpeechRecognition
    let listening = false;
    let conversation = false;    // keep listening after each reply until "done"/silence
    let pending = null;          // { type: "confirm", run, card } | { type: "slot", slot, draft }
    let lastListId = null;       // "add butter" goes to the list we last talked about
    let muted = false;
    try { muted = localStorage.getItem("asst-muted") === "1"; } catch (e) {}

    // ---------- speaking ----------

    function pickVoice() {
        const voices = canSpeak ? speechSynthesis.getVoices() : [];
        const en = voices.filter(v => /^en(-|_|$)/i.test(v.lang));
        return en.find(v => /natural/i.test(v.name) && /en-US/i.test(v.lang))   // Edge: Microsoft neural voices
            || en.find(v => /Google US English/i.test(v.name))                   // Chrome
            || en.find(v => /Samantha|Ava|Allison/i.test(v.name))                // Apple
            || en.find(v => v.default) || en[0] || null;
    }
    if (canSpeak) speechSynthesis.onvoiceschanged = () => {};   // some browsers load voices lazily

    function say(text) {
        addBubble("bot", text);
        if (muted || !canSpeak) return Promise.resolve();
        return new Promise(resolve => {
            speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(text);
            const v = pickVoice();
            if (v) u.voice = v;
            u.rate = 1.05;
            u.onend = u.onerror = () => resolve();
            setStatus("Speaking…");
            speechSynthesis.speak(u);
        });
    }

    // ---------- listening ----------

    function setStatus(s) { statusEl.textContent = s; }

    function updateMic() {
        micBtn.classList.toggle("listening", listening);
        el("asst-fab").classList.toggle("listening", listening);
        micBtn.setAttribute("aria-label", listening ? "Stop listening" : "Start listening");
        if (!listening && statusEl.textContent === "Listening…") setStatus(conversation ? "" : "Tap the mic to talk");
    }

    function listen() {
        if (!canListen) { setStatus("Voice isn't supported in this browser. Type instead."); return; }
        if (listening) return;
        if (canSpeak) speechSynthesis.cancel();
        rec = new SR();
        rec.lang = "en-US";
        rec.interimResults = true;
        rec.continuous = false;
        rec.maxAlternatives = 1;
        let finalText = "";

        rec.onresult = e => {
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                if (r.isFinal) finalText += r[0].transcript;
                else interim += r[0].transcript;
            }
            interimEl.textContent = (finalText + " " + interim).trim();
            // Codewords act immediately, before the sentence is finished.
            if (/^\s*(stop|cancel|never ?mind)\s*$/i.test(interim)) { finalText = interim; rec.stop(); }
        };
        rec.onerror = e => {
            if (e.error === "not-allowed" || e.error === "service-not-allowed") {
                conversation = false;
                setStatus("Microphone is blocked. Allow it in the browser's site settings, or type instead.");
            } else if (e.error === "no-speech") {
                setStatus("");
            } else if (e.error !== "aborted") {
                setStatus("Couldn't hear that (" + e.error + "). Tap the mic to try again.");
            }
        };
        rec.onend = () => {
            listening = false;
            rec = null;
            interimEl.textContent = "";
            updateMic();
            const text = finalText.trim();
            if (text) handle(text);
            else if (conversation) endConversation();      // silence ends a conversation quietly
        };

        try {
            rec.start();
            listening = true;
            setStatus("Listening…");
            updateMic();
        } catch (err) {
            // iPhone may refuse to restart without a tap.
            setStatus("Tap the mic to answer.");
        }
    }

    function stopListening() {
        if (rec) { try { rec.abort(); } catch (e) {} }
        listening = false;
        updateMic();
    }

    // After the assistant speaks: keep the conversation going hands-free.
    async function reply(text, keepListening = conversation) {
        await say(text);
        if (keepListening && sheet.hidden === false) listen();
        else setStatus(canListen ? "Tap the mic to talk" : "");
    }

    function endConversation() {
        conversation = false;
        stopListening();
        setStatus(canListen ? "Tap the mic to talk" : "");
    }

    // ---------- the log ----------

    function addBubble(who, text) {
        const b = document.createElement("div");
        b.className = "asst-bubble " + who;
        b.textContent = text;
        log.appendChild(b);
        log.scrollTop = log.scrollHeight;
        return b;
    }

    function addCard(title, lines, actions) {
        const c = document.createElement("div");
        c.className = "asst-card";
        c.innerHTML = `<div class="asst-card-kind">${escapeHtml(title)}</div>` +
            lines.map((l, i) => `<div class="${i === 0 ? "asst-card-main" : "asst-card-sub"}">${escapeHtml(l)}</div>`).join("") +
            `<div class="asst-card-actions">${actions.map(a =>
                `<button type="button" class="${a.primary ? "" : "btn-secondary"} btn-sm" data-a="${a.id}">${escapeHtml(a.label)}</button>`).join("")}</div>`;
        log.appendChild(c);
        log.scrollTop = log.scrollHeight;
        return c;
    }

    function closeCard(card, note) {
        if (!card) return;
        card.querySelectorAll("button").forEach(b => b.disabled = true);
        card.classList.add("resolved");
        if (!note) return;
        const slot = card.querySelector(".asst-card-actions, .asst-card-note");
        if (slot) slot.outerHTML = `<div class="asst-card-note">${escapeHtml(note)}</div>`;
    }

    log.addEventListener("click", e => {
        const b = e.target.closest("button[data-a]");
        if (!b || !pending || pending.card !== b.closest(".asst-card")) return;
        answerPending(b.dataset.a);
    });

    // ---------- formatting ----------

    const dayName = d => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    const spokenDay = d => d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    function whenText(ev, spoken) {
        if (ev.allDay) {
            const last = new Date(ev.end.getTime() - DAY);
            const one = ymd(last) === ymd(ev.start);
            return (spoken ? spokenDay(ev.start) : dayName(ev.start)) + (one ? (spoken ? ", all day" : " · All day") : " – " + dayName(last));
        }
        return (spoken ? spokenDay(ev.start) + " at " : dayName(ev.start) + " · ") + fmtTime(ev.start) +
            (spoken ? "" : " – " + fmtTime(ev.end));
    }
    const joinWords = arr => arr.length <= 1 ? (arr[0] || "") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];

    // ---------- lists ----------

    async function ensureData() {
        if (!dataLoaded) await loadData();
        return dataLoaded;
    }

    /** Resolve a spoken list name (or null = the list we're on) to a list object. */
    function findList(name) {
        if (!name) {
            return data.lists.find(l => l.id === lastListId)
                || data.lists.find(l => l.id === selectedListId)
                || (data.lists.length === 1 ? data.lists[0] : null);
        }
        // 1) exact name, with or without "list"  2) the list we just used, if it fits  3) closest name
        const q = name.toLowerCase().replace(/\s+list$/, "");
        const exact = data.lists.find(l => l.name.toLowerCase().replace(/\s+list$/, "") === q);
        if (exact) return exact;
        const last = data.lists.find(l => l.id === lastListId);
        if (last && P.bestMatch(name, [last.name]) === 0) return last;
        const i = P.bestMatch(name, data.lists.map(l => l.name));
        return i >= 0 ? data.lists[i] : null;
    }

    function findItems(list, names) {
        const found = [], missing = [];
        for (const n of names) {
            const i = P.bestMatch(n, list.items.map(it => it.text));
            if (i >= 0) found.push(list.items[i]); else missing.push(n);
        }
        return { found, missing };
    }

    function showList(list) {
        lastListId = list.id;
        selectedListId = list.id;
        if (typeof renderLists === "function") renderLists();
    }

    // ---------- confirmations ----------

    function confirm(card, run, speak, edit) {
        pending = { type: "confirm", run, card, edit };
        return reply(speak);     // in a voice conversation, listens for "yes"/"no" next
    }

    async function answerPending(answer) {
        const p = pending;
        if (!p || p.type !== "confirm") return;
        pending = null;
        if (answer === "yes") {
            closeCard(p.card, "Saving…");
            try {
                const msg = await p.run();
                closeCard(p.card, "✓ Done");
                await reply(msg);
            } catch (err) {
                closeCard(p.card, "Couldn't save");
                await reply("Sorry, that didn't save. " + err.message, false);
            }
        } else if (answer === "edit") {
            closeCard(p.card, "Opened in the editor");
            endConversation();
            p.edit && p.edit();
        } else {
            closeCard(p.card, "Cancelled");
            await reply("Okay, I won't.");
        }
    }

    // ---------- handling one utterance ----------

    async function handle(text) {
        addBubble("me", text);
        const cmd = P.parse(text, new Date());

        if (cmd.kind === "cancel") {
            if (pending && pending.card) closeCard(pending.card, "Cancelled");
            pending = null;
            if (canSpeak) speechSynthesis.cancel();
            addBubble("bot", "Okay, stopped.");
            endConversation();
            return;
        }
        if (cmd.kind === "done") {
            pending = null;
            await say("Okay!");
            endConversation();
            return;
        }

        // Answering a question the assistant asked.
        if (pending && pending.type === "confirm") {
            if (cmd.kind === "yes" || cmd.kind === "no" || cmd.kind === "edit") return answerPending(cmd.kind);
            closeCard(pending.card, "Skipped");
            pending = null;                 // a new command replaces the unanswered one
        }
        if (pending && pending.type === "slot") {
            const p = pending;
            pending = null;
            if (cmd.kind === "no") return reply("Okay, never mind.");
            return fillSlot(p, text, cmd);
        }

        try {
            await run(cmd, text);
        } catch (err) {
            await reply("Sorry, something went wrong: " + err.message, false);
        }
    }

    async function fillSlot(p, text, cmd) {
        const d = p.draft;
        if (p.slot === "date") {
            const when = P.parseWhen(text, new Date());
            if (!when) { pending = p; return reply("I didn't catch a day. Try something like “Friday at 3” or “November 20th”."); }
            Object.assign(d, when);
            return proposeEvent(d);
        }
        if (p.slot === "title") {
            d.title = P.cleanTitle(text) || text;
            return proposeEvent(d);
        }
        if (p.slot === "list") {
            const list = findList(P.cleanListName(text));
            if (!list) return reply(`I couldn't find a list called ${text}.`);
            return addItems(list, d.items);
        }
        if (p.slot === "newlist") {
            if (cmd.kind === "yes") return createList(d.name, d.items);
            return reply("Okay, I won't create it.");
        }
    }

    async function run(cmd, text) {
        switch (cmd.kind) {
            case "yes": case "no": case "edit":
                return reply("There's nothing waiting for an answer. What would you like to do?");

            case "event.create": {
                const d = { title: cmd.title, allDay: cmd.allDay, start: cmd.start, end: cmd.end };
                if (!cmd.hasDate) {
                    pending = { type: "slot", slot: "date", draft: d };
                    return reply(`${d.title ? d.title + "," : "Okay,"} what day${d.title ? "" : " and time"}?`);
                }
                return proposeEvent(d);
            }

            case "list.create": {
                if (!cmd.name) return reply("What should the list be called? Say “create a list called groceries”.");
                if (!(await ensureData())) return reply("I couldn't load your lists.");
                const existing = data.lists.find(l => l.name.toLowerCase() === cmd.name.toLowerCase());
                if (existing && cmd.items.length) return addItems(existing, cmd.items, `You already have a ${existing.name} list, so I added to it. `);
                return createList(cmd.name, cmd.items);
            }

            case "item.add": {
                if (!cmd.items.length) return reply("What should I add?");
                if (!(await ensureData())) return reply("I couldn't load your lists.");
                const list = findList(cmd.list);
                if (!list) {
                    if (cmd.list) {
                        pending = { type: "slot", slot: "newlist", draft: { name: cmd.list + (/list$/i.test(cmd.list) ? "" : " list"), items: cmd.items } };
                        return reply(`There's no ${cmd.list} list. Should I create it?`);
                    }
                    pending = { type: "slot", slot: "list", draft: { items: cmd.items } };
                    return reply("Which list should I add that to?");
                }
                return addItems(list, cmd.items);
            }

            case "item.check":
            case "item.remove": {
                if (!(await ensureData())) return reply("I couldn't load your lists.");
                const list = findList(cmd.list);
                if (!list) return reply(cmd.list ? `I couldn't find a ${cmd.list} list.` : "Which list? Say “check off milk on the grocery list”.");
                const { found, missing } = findItems(list, cmd.items);
                if (!found.length) return reply(`I couldn't find ${joinWords(cmd.items)} on the ${list.name} list.`);
                const ids = found.map(i => i.id);
                const ok = cmd.kind === "item.check"
                    ? await dataAction({ action: "item.updateMany", ids, done: true }, () => found.forEach(i => i.done = true))
                    : await dataAction({ action: "item.deleteMany", ids }, () => { list.items = list.items.filter(i => !ids.includes(i.id)); });
                if (!ok) return reply("Sorry, that didn't save.", false);
                showList(data.lists.find(l => l.id === list.id) || list);
                const verb = cmd.kind === "item.check" ? "Checked off" : "Removed";
                return reply(`${verb} ${joinWords(found.map(i => i.text))}.` + (missing.length ? ` I couldn't find ${joinWords(missing)}.` : ""));
            }

            case "list.clearDone": {
                if (!(await ensureData())) return reply("I couldn't load your lists.");
                const list = findList(cmd.list);
                if (!list) return reply("Which list should I clear?");
                const n = list.items.filter(i => i.done).length;
                if (!n) return reply(`Nothing is checked on the ${list.name} list.`);
                await dataAction({ action: "list.clearDone", id: list.id }, () => { list.items = list.items.filter(i => !i.done); });
                return reply(`Cleared ${n} checked item${n === 1 ? "" : "s"} from ${list.name}.`);
            }

            case "list.delete": {
                if (!(await ensureData())) return reply("I couldn't load your lists.");
                const list = findList(cmd.list);
                if (!list) return reply(`I couldn't find a ${cmd.list} list.`);
                const n = list.items.length;
                const card = addCard("Delete list", [list.name, `${n} item${n === 1 ? "" : "s"} will be deleted`],
                    [{ id: "yes", label: "Delete", primary: true }, { id: "no", label: "Cancel" }]);
                return confirm(card, async () => {
                    const ok = await dataAction({ action: "list.delete", id: list.id }, () => { data.lists = data.lists.filter(l => l.id !== list.id); });
                    if (!ok) throw new Error("the server said no");
                    return `Deleted the ${list.name} list.`;
                }, `Delete the ${list.name} list and its ${n} item${n === 1 ? "" : "s"}? Say yes to confirm.`);
            }

            case "list.read": {
                if (!(await ensureData())) return reply("I couldn't load your lists.");
                const list = findList(cmd.list);
                if (!list) return reply(`I couldn't find a ${cmd.list} list.`);
                showList(list);
                const open = list.items.filter(i => !i.done).map(i => i.text);
                return reply(open.length ? `${list.name} has ${open.length} item${open.length === 1 ? "" : "s"}: ${joinWords(open)}.` : `The ${list.name} list is empty.`);
            }

            case "note.create": {
                if (!cmd.title) return reply("What should the note say? Try “create a note called wifi that says …”.");
                const lines = [cmd.title];
                if (cmd.body) lines.push(cmd.body);
                const card = addCard("New note", lines,
                    [{ id: "yes", label: "Save note", primary: true }, { id: "edit", label: "Edit" }, { id: "no", label: "Cancel" }]);
                return confirm(card, async () => {
                    const ok = await dataAction({ action: "note.create", title: cmd.title, body: cmd.body, pinned: false });
                    if (!ok) throw new Error("the server said no");
                    return `Saved the note ${cmd.title}.`;
                }, `Save a note called ${cmd.title}?`,
                () => { showTab("lists"); openNote(null); el("note-title").value = cmd.title; el("note-body").value = cmd.body; });
            }

            case "agenda":
                return readAgenda(cmd.when);

            default:
                return reply("Sorry, I didn't understand. Try “add milk to the grocery list” or “create an event Friday at 3 called dentist”.");
        }
    }

    // ---------- events ----------

    async function proposeEvent(d) {
        if (!d.title) {
            pending = { type: "slot", slot: "title", draft: d };
            return reply("What should I call it?");
        }
        const card = addCard("New event", [d.title, whenText(d, false)],
            [{ id: "yes", label: "Add it", primary: true }, { id: "edit", label: "Edit" }, { id: "no", label: "Cancel" }]);
        return confirm(card, async () => {
            await api("POST", {
                action: "create", title: d.title, allDay: d.allDay,
                start: d.allDay ? ymd(d.start) : d.start.toISOString(),
                end: d.allDay ? ymd(d.end) : d.end.toISOString()
            });
            refreshAll();
            return `Added ${d.title}.`;
        }, `${d.title}, ${whenText(d, true)}. Should I add it?`, () => {
            showTab("calendar");
            openModal(null, d.allDay
                ? { allDay: true, startStr: ymd(d.start), endStr: ymd(d.end) }
                : { allDay: false, start: d.start, end: d.end });
            el("title").value = d.title;
        });
    }

    async function createList(name, items) {
        const before = new Set(data.lists.map(l => l.id));
        const ok = await dataAction({ action: "list.create", name, items });
        if (!ok) return reply("Sorry, I couldn't create that list.", false);
        const created = data.lists.find(l => !before.has(l.id));
        if (created) { showTab("lists"); showList(created); }
        return reply(`Created ${name}` + (items.length ? ` with ${joinWords(items)}.` : ". What should I add?"));
    }

    async function addItems(list, items, prefix = "") {
        const ok = await dataAction({ action: "item.add", listId: list.id, texts: items },
            () => items.forEach(t => list.items.push({ id: "tmp-" + Math.random(), text: t, done: false, updatedAt: Date.now() })));
        if (!ok) return reply("Sorry, that didn't save.", false);
        showList(data.lists.find(l => l.id === list.id) || list);
        return reply(`${prefix}Added ${joinWords(items)} to ${list.name}.`);
    }

    function readAgenda(when) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const from = when === "tomorrow" ? new Date(today.getTime() + DAY) : today;
        const to = new Date(from.getTime() + (when === "week" ? 7 : 1) * DAY);
        const evs = (dashboardEvents || []).filter(e => e.start < to && e.end > from);
        const label = when === "tomorrow" ? "Tomorrow" : when === "week" ? "This week" : "Today";
        if (!evs.length) return reply(`${label} there's nothing on the calendar.`);
        const parts = evs.slice(0, 8).map(e => e.allDay ? e.title : `${e.title} at ${fmtTime(e.start)}` + (when === "week" ? ` ${e.start.toLocaleDateString([], { weekday: "long" })}` : ""));
        return reply(`${label} you have ${joinWords(parts)}.`);
    }

    // ---------- open / close ----------

    function open(startListening) {
        sheet.hidden = false;
        el("asst-fab").hidden = true;
        if (!log.children.length) addBubble("bot", canListen
            ? "Hi! Tap the mic and tell me what to do, or type it below."
            : "Hi! Voice isn't available in this browser, but you can type commands below.");
        if (startListening && canListen) { conversation = true; listen(); }
        else setStatus(canListen ? "Tap the mic to talk" : "");
    }

    function close() {
        endConversation();
        if (canSpeak) speechSynthesis.cancel();
        if (pending && pending.card) closeCard(pending.card, "Cancelled");
        pending = null;
        sheet.hidden = true;
        el("asst-fab").hidden = false;
    }

    el("asst-fab").addEventListener("click", () => open(true));
    el("asst-close").addEventListener("click", close);
    micBtn.addEventListener("click", () => {
        if (listening) { endConversation(); return; }
        conversation = true;
        listen();
    });
    el("asst-form").addEventListener("submit", e => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        conversation = false;          // typed commands don't open the mic
        stopListening();
        handle(text);
    });
    el("asst-mute").addEventListener("click", () => {
        muted = !muted;
        if (muted && canSpeak) speechSynthesis.cancel();
        el("asst-mute").setAttribute("aria-pressed", String(muted));
        el("asst-mute").title = muted ? "Voice replies off" : "Voice replies on";
        try { localStorage.setItem("asst-muted", muted ? "1" : "0"); } catch (e) {}
    });
    el("asst-mute").setAttribute("aria-pressed", String(muted));
    if (!canListen) micBtn.hidden = true;

    // For testing from the console.
    window.FamilyAssistant = { handle, open, close };
})();

// Run: node tests/parser.test.js
// Checks the voice/text command parser against real phrasings (no browser needed).
const P = require("../web/parser.js");

// Sunday, Nov 15 2026, 6:00 PM local
const NOW = new Date(2026, 10, 15, 18, 0);
const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` +
    (d.getHours() || d.getMinutes() ? ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "");

let pass = 0, fail = 0;
function check(input, expected) {
    const r = P.parse(input, NOW);
    const got = { kind: r.kind };
    for (const k of Object.keys(expected)) {
        if (k === "kind") continue;
        let v = r[k];
        if (v instanceof Date) v = fmt(v);
        got[k] = v;
    }
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${input}`);
    if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(got)}`);
}

// --- the three examples from the brief ---
check("Create a new list called grocery list and add milk eggs and sugar.",
    { kind: "list.create", name: "Grocery list", items: ["Milk eggs", "Sugar"] });
check("Create a new list called grocery list and add milk, eggs, and sugar",
    { kind: "list.create", name: "Grocery list", items: ["Milk", "Eggs", "Sugar"] });
check("Update the grocery list with vegetable oil",
    { kind: "item.add", list: "Grocery", items: ["Vegetable oil"] });
check("Create a new event, november 16th at 3pm its JJs birthday",
    { kind: "event.create", title: "JJs birthday", allDay: false, start: "2026-11-16 15:00", end: "2026-11-16 16:00" });
check("Create a new event November 16th at 3 p.m. it's JJ's birthday",
    { kind: "event.create", title: "JJ's birthday", allDay: false, start: "2026-11-16 15:00", end: "2026-11-16 16:00" });

// --- events ---
check("create an event called dentist on friday at 3:30",
    { kind: "event.create", title: "Dentist", allDay: false, start: "2026-11-20 15:30", end: "2026-11-20 16:30" });
check("schedule soccer practice tomorrow from 5 to 6:30",
    { kind: "event.create", title: "Soccer practice", start: "2026-11-16 17:00", end: "2026-11-16 18:30" });
check("add JJ's birthday party to the calendar on December 5th",
    { kind: "event.create", title: "JJ's birthday party", allDay: true, start: "2026-12-05", end: "2026-12-06" });
check("new event thanksgiving dinner on the 26th at 4pm for 3 hours",
    { kind: "event.create", title: "Thanksgiving dinner", start: "2026-11-26 16:00", end: "2026-11-26 19:00" });
check("create an event on November sixteenth at three thirty called piano recital",
    { kind: "event.create", title: "Piano recital", start: "2026-11-16 15:30" });
check("book a haircut next tuesday at 10",
    { kind: "event.create", title: "Haircut", start: "2026-11-17 10:00" });
check("Picture day is on the 20th",
    { kind: "event.create", title: "Picture day", allDay: true, start: "2026-11-20" });
check("make an appointment for the vet on 12/3 at 9am",
    { kind: "event.create", title: "The vet", start: "2026-12-03 09:00" });
check("create an event called date night saturday at 7",
    { kind: "event.create", title: "Date night", start: "2026-11-21 19:00" });
check("schedule a party january 2nd from 11 to 1pm",
    { kind: "event.create", title: "Party", start: "2027-01-02 11:00", end: "2027-01-02 13:00" });
check("create an event teacher workday monday all day",
    { kind: "event.create", title: "Teacher workday", allDay: true, start: "2026-11-16" });
check("create an event called fishing trip",
    { kind: "event.create", title: "Fishing trip", hasDate: false });
check("Dinner with grandma tomorrow at 6",
    { kind: "event.create", title: "Dinner with grandma", start: "2026-11-16 18:00" });

// --- lists ---
check("add vegetable oil to the grocery list", { kind: "item.add", list: "Grocery", items: ["Vegetable oil"] });
check("put paper towels and dish soap on the costco list", { kind: "item.add", list: "Costco", items: ["Paper towels", "Dish soap"] });
check("add bread", { kind: "item.add", list: null, items: ["Bread"] });
check("we need butter", { kind: "item.add", list: null, items: ["Butter"] });
check("make a new grocery list with apples and bananas", { kind: "list.create", name: "Grocery list", items: ["Apples", "Bananas"] });
check("start a list called packing", { kind: "list.create", name: "Packing", items: [] });
check("check off milk", { kind: "item.check", list: null, items: ["Milk"] });
check("cross off eggs on the grocery list", { kind: "item.check", list: "Grocery", items: ["Eggs"] });
check("remove sugar from the grocery list", { kind: "item.remove", list: "Grocery", items: ["Sugar"] });
check("delete the costco list", { kind: "list.delete", list: "Costco" });
check("read me the grocery list", { kind: "list.read", list: "Grocery" });
check("what's on the grocery list", { kind: "list.read", list: "Grocery" });
check("clear checked items", { kind: "list.clearDone", list: null });

// --- notes ---
check("create a note called wifi password that says network Smith password is sunshine",
    { kind: "note.create", title: "Wifi password", body: "Network Smith password is sunshine" });
check("take a note buy wrapping paper", { kind: "note.create", title: "Buy wrapping paper", body: "" });

// --- control & agenda ---
check("stop", { kind: "cancel" });
check("never mind", { kind: "cancel" });
check("yes", { kind: "yes" });
check("yeah do it", { kind: "yes" });
check("no", { kind: "no" });
check("that's all", { kind: "done" });
check("what's on the calendar today", { kind: "agenda", when: "today" });
check("what do we have tomorrow", { kind: "agenda", when: "tomorrow" });

// --- fuzzy list matching ---
const lists = ["Groceries", "Costco run", "Weekend to-do"];
const mcheck = (q, want) => {
    const i = P.bestMatch(q, lists), ok = (i === -1 ? null : lists[i]) === want;
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  match "${q}" -> ${i === -1 ? null : lists[i]}`);
};
mcheck("Grocery", "Groceries");
mcheck("grocery list", "Groceries");
mcheck("costco", "Costco run");
mcheck("weekend todo", "Weekend to-do");
mcheck("hardware", null);

// --- follow-up date answers ---
const w = P.parseWhen("on friday at 3", NOW);
const wok = w && fmt(w.start) === "2026-11-20 15:00"; wok ? pass++ : fail++;
console.log(`${wok ? "PASS" : "FAIL"}  parseWhen "on friday at 3" -> ${w && fmt(w.start)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

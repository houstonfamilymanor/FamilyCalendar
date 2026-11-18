// Run: node tests/kids.test.js
// Kids' school feeds -> calendar items (made-up kids, schools and menus).
const K = require("../web/kids.js");
let pass = 0, fail = 0;
function check(name, got, expected) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(got)}`));
}

// ----- menus -----
const typical = "Choose One Entrée:\n• Turkey Wrap\n• Veggie  Pasta\n\nChoose Your Sides:\n• Corn\n• Apple Slices\n• Milk\n\n";
check("entrees and sides split", K.parseMenu(typical),
    { entrees: ["Turkey Wrap", "Veggie Pasta"], sides: ["Corn", "Apple Slices", "Milk"], note: "" });
check("bullet with no space", K.parseMenu("Choose One Entrée:\n•Grilled Cheese\n• Soup").entrees, ["Grilled Cheese", "Soup"]);
check("closure text is a note", K.parseMenu("NO SCHOOL"), { entrees: [], sides: [], note: "NO SCHOOL" });
check("lunch text", K.describeLunch({ lunch: typical, breakfast: "" }).text, "Turkey Wrap / Veggie Pasta");
check("no-school day", K.describeLunch({ breakfast: "NO SCHOOL", lunch: "" }).text, "No School");
check("holiday drops the !", K.describeLunch({ breakfast: "HAPPY NEW YEAR!", lunch: "" }).text, "Happy New Year");
check("nothing listed", K.describeLunch({ breakfast: "", lunch: "" }).text, "");

// ----- letter days -----
check("C-Day", K.letterOf("C-Day"), "C");
check("C Day", K.letterOf("C Day"), "C");
check("bare letter", K.letterOf(" e "), "E");
check("not a letter day", K.letterOf("Early Release"), null);
check("meanings", K.parseMeanings("A: Gym, B = Art; c - Music\nD: Library"), { A: "Gym", B: "Art", C: "Music", D: "Library" });

// ----- merging two kids -----
const data = {
    kids: [
        { id: "k1", name: "Sam", menuFeed: "menuX", eventsFeed: "evX", letterCal: "cal", letterMeanings: "C: Gym" },
        { id: "k2", name: "Mia", menuFeed: "menuY", eventsFeed: "evY", letterCal: "cal", letterMeanings: "C: Art" }
    ],
    lunch: [
        { feed: "menuX", date: "2030-01-07", lunch: typical, breakfast: "" },
        { feed: "menuY", date: "2030-01-07", lunch: typical, breakfast: "" },            // same menu at the other school
        { feed: "menuY", date: "2030-01-08", lunch: "Choose One Entrée:\n• Tacos", breakfast: "" }
    ],
    events: [
        { feed: "evX", id: "1", title: "Book Fair", start: "2030-01-07", end: "2030-01-07", allDay: true },
        { feed: "evY", id: "2", title: "book fair", start: "2030-01-07", end: "2030-01-07", allDay: true },   // shared
        { feed: "evY", id: "3", title: "Holiday Shop", start: "2030-01-08", end: "2030-01-08", allDay: true },
        { feed: "evZ", id: "4", title: "Other school's thing", start: "2030-01-08", end: "2030-01-08", allDay: true }
    ],
    letters: [{ cal: "cal", date: "2030-01-07", label: "C Day" }]
};
const titles = K.buildItems(data, "2030-01-07", "2030-01-09").map(i => i.title).sort();
check("merged + per-kid titles", titles, [
    "🍎 Mia: Tacos",
    "🍎 Sam & Mia: Turkey Wrap / Veggie Pasta",
    "📌 Mia: Holiday Shop",
    "📌 Sam & Mia: Book Fair",
    "🔤 Mia: C-Day · Art",
    "🔤 Sam: C-Day · Gym"
]);
const shared = K.buildItems(data, "2030-01-07", "2030-01-08").find(i => i.kind === "lunch");
check("shared item carries both kids' chips", shared.tags, ["_lunch:k1", "_lunch:k2"]);
check("other schools' events never show", K.buildItems(data, "2030-01-01", "2030-02-01").some(i => /Other school/.test(i.title)), false);
check("range is respected", K.buildItems(data, "2030-01-08", "2030-01-09").length, 2);

// ----- Today page: one day, kid by kid -----
const day7 = K.kidDay(data, "2030-01-07");
check("today: one entry per kid", day7.map(k => k.name), ["Sam", "Mia"]);
check("today: letter + that kid's meaning", day7.map(k => k.letter), [{ label: "C-Day", meaning: "Gym" }, { label: "C-Day", meaning: "Art" }]);
check("today: lunch entrées", day7[0].lunch.lunch.entrees, ["Turkey Wrap", "Veggie Pasta"]);
check("today: own school's events only", day7.map(k => k.events.map(e => e.title)), [["Book Fair"], ["book fair"]]);
const day8 = K.kidDay(data, "2030-01-08");
check("today: no letter / no menu that day", [day8[0].letter, day8[0].lunch], [null, null]);
check("today: other kid's menu that day", day8[1].lunch.text, "Tacos");
const multi = { kids: [{ id: "k", name: "Sam", eventsFeed: "e" }], events: [
    { feed: "e", title: "Spirit Week", start: "2030-01-06", end: "2030-01-10", allDay: true },
    { feed: "e", title: "Concert", start: new Date(2030, 0, 7, 18).toISOString(), end: new Date(2030, 0, 7, 19).toISOString(), allDay: false },
    { feed: "e", title: "Assembly", start: new Date(2030, 0, 7, 9).toISOString(), end: new Date(2030, 0, 7, 10).toISOString(), allDay: false },
    { feed: "e", title: "Tomorrow thing", start: new Date(2030, 0, 8, 9).toISOString(), end: new Date(2030, 0, 8, 10).toISOString(), allDay: false }] };
check("today: multi-day + timed in order, all-day first", K.kidDay(multi, "2030-01-07")[0].events.map(e => e.title),
    ["Spirit Week", "Assembly", "Concert"]);
check("today: no feeds set up -> empty, no crash", K.kidDay({ kids: [{ id: "k", name: "Sam" }], lunch: [{ date: "2030-01-07", lunch: typical }] }, "2030-01-07")[0],
    { id: "k", name: "Sam", letter: null, lunch: null, events: [], errors: {}, pending: false, has: { lunch: false, events: false, letters: false } });

// ----- weekly cache -----
const saved = { at: new Date(2030, 0, 8, 9).getTime(), res: { kids: [] } };
check("cache: 6 days later -> still use it", K.cacheFresh(saved, new Date(2030, 0, 14, 8)), true);
check("cache: 7 days later -> ask the server", K.cacheFresh(saved, new Date(2030, 0, 15, 9)), false);
check("cache: clock went backwards -> ask the server", K.cacheFresh(saved, new Date(2030, 0, 7)), false);
check("cache: nothing saved", K.cacheFresh(null, new Date()), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

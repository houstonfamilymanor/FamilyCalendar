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

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;

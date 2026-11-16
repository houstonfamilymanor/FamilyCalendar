// Run: node tests/findEvents.test.js
// Event suggestions pulled out of school-email text.
const P = require("../web/parser.js");

const NOW = new Date(2026, 10, 15, 18, 0);       // Sun Nov 15 2026
const fmt = d => `${d.getMonth() + 1}/${d.getDate()}` + (d.getHours() ? ` ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : "");
let pass = 0, fail = 0;
function check(name, text, sentAt, expected) {
    const got = P.findEvents(text, sentAt, NOW).map(e => `${fmt(e.start)} ${e.allDay ? "(all day) " : ""}${e.title}` + (e.allDay && e.end - e.start > 864e5 ? ` (thru ${fmt(new Date(e.end - 864e5))})` : ""));
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) console.log(`      expected ${JSON.stringify(expected, null, 1)}\n      got      ${JSON.stringify(got, null, 1)}`);
}

// A classroom policy change (not an event), and its only date is already past.
check("classroom rule change -> nothing", `I am writing to share an update regarding a change in our classroom rules.

Earlier this year, students were allowed to bring fidget toys to help them focus. Over the past few weeks, they have become a distraction during learning time.

For these reasons, fidget toys are no longer permitted in our classroom starting 10/22/26.

If a student brings one to school, it will stay in their backpack for the day.

Thank you for your help and understanding,

Mrs. Smith`, new Date(2026, 9, 20), []);

// Same kind of rule change but in the future: still not an event.
check("future policy -> nothing",
    "Effective December 1st, phones are no longer allowed in classrooms.", new Date(2026, 10, 14), []);

check("field trip with time", `Hi families!

Our class will be going on a field trip to the Science Center on Friday, December 4th. Buses leave at 8:30am.
Please return permission slips by November 30th.

Thanks!`, new Date(2026, 10, 13), [
    "12/4 (all day) Class will be going on a field trip to the Science Center",
    "11/30 (all day) Please return permission slips"
]);

check("relative day anchored to the sent date",
    "Reminder: tomorrow is picture day! Wear your best smile.", new Date(2026, 10, 16, 15, 0),
    ["11/17 (all day) Is picture day"]);

check("newsletter lines", `Upcoming dates
- 11/18 Early release, 1:30 dismissal
- 11/25-11/27 Thanksgiving break, no school
- 12/10 Winter concert at 6:30pm in the gym`, new Date(2026, 10, 15), [
    "11/18 13:30 Early release, dismissal",
    "11/25 (all day) Thanksgiving break, no school (thru 11/27)",
    "12/10 18:30 Winter concert in the gym"
]);

check("past dates dropped",
    "Thanks to everyone who came to the Fall Festival on October 30th!", new Date(2026, 10, 2), []);

// A newsletter full of tracking links; a weekday that's part of a name isn't a date.
check("newsletter with links", `This Week at School is LIVE on the school website, and is linked
below for your convenience!

This Week at School! Week of 11/16/26
<https://u1.ct.example.net/ls/click?upn=u001.abc-2FvUyY2FIHn1INr-
2FnAH0DZPahm9cPmcBxMuS8cQIPrhrw-3D>

Of note, our school-wide Genius Day will be on Monday, November 23.
Information can be found by clicking the link above!

Additionally, we are now accepting RSVPs for our first ever Saturday
Holiday Shoppe! Click here to learn more!
<https://u1.ct.example.net/ls/click?upn=u001.4G-2BjNSxLlRW50aopnT0b8Vq>`, new Date(2026, 10, 15), [
    "11/23 (all day) School-wide Genius Day"
]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

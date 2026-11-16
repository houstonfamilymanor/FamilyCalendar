// Run: node tests/mealSummary.test.js
// Balance + child pulled from lunch-account emails (made-up names; the real roster isn't in the repo).
const P = require("../web/parser.js");
const KIDS = ["Sam", "Mia"];
let pass = 0, fail = 0;
function check(name, text, expected) {
    const r = P.mealSummary(text, KIDS);
    const got = { balanceText: r.balanceText, kid: r.kid };
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(got)}`));
}

check("plain low balance", "This is a reminder that the meal account balance for Sam Smith is $2.15. Please add funds.",
    { balanceText: "$2.15", kid: "Sam" });
check("labelled negative", "Student: MIA SMITH\nSchool: Lincoln Elementary\nCurrent Balance: -$3.50\nThreshold: $5.00",
    { balanceText: "-$3.50", kid: "Mia" });
check("parentheses = negative", "Account balance for Sam: ($4.25)\nLow balance threshold $10.00",
    { balanceText: "-$4.25", kid: "Sam" });
check("threshold mentioned first", "Your low balance threshold of $10.00 has been reached. Mia's balance is now $7.80.",
    { balanceText: "$7.80", kid: "Mia" });
check("overdrawn wording", "Sam's lunch account is overdrawn by $1.75.",
    { balanceText: "-$1.75", kid: "Sam" });
check("no kid named", "Your account balance is $12.40.", { balanceText: "$12.40", kid: null });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

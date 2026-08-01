/* test_demogap.js — the guard-demonstration tool, checked against a fixture it cannot argue with.
 *
 * The point of demogap is to say which assertions have been observed discriminating something.
 * So the load-bearing test here is not a unit test of a regex: it is a miniature repo, built in
 * a temp dir, containing one assertion of each kind whose correct classification is known in
 * advance — including the one the first version of the tool got WRONG.
 *
 *   a constant expression        must come out INERT
 *   a sound NEGATIVE assertion   must NOT come out INERT   <- the negative control
 *   an assertion reading a value must come out DEMONSTRATED
 *
 * The negative control is the whole reason the tool runs two referent legs instead of one.
 * Emptying a file makes `ok(!/FORBIDDEN/.test(src))` pass for free, and the first version
 * called exactly that shape inert in test_markfade.js. Delete the noise leg from demogap.js
 * and section 1 goes red.
 *
 * Run: node test_demogap.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("./demogap.js");

let fails = 0;
function ok(cond, msg) { console.log(`  ${cond ? "ok " : "FAIL"} - ${msg}`); if (!cond) fails++; }

/* ---- 1. end to end, against a fixture whose right answers are known ---- */

const FIXTURE_UI = `"use strict";
const THRESHOLD = 12;
function widen(x) { return x * THRESHOLD; }
module.exports = { widen, THRESHOLD };
`;

/* Written with the assertions on known lines so the expectations below can name them. */
const FIXTURE_TEST = `"use strict";
const fs = require("fs");
const path = require("path");
const T = require("./ui/thing.js");
let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }
const SRC = fs.readFileSync(path.join(__dirname, "ui", "thing.js"), "utf8");
const local = 3;
ok(T.THRESHOLD === 12, "the threshold is twelve");
ok(/const THRESHOLD/.test(SRC), "the threshold is declared");
ok(!/FORBIDDEN/.test(SRC), "no forbidden token in the source");
ok(local * 2 === 6, "twice three is six");
process.exit(fails ? 1 : 0);
`;
const LINE = { reads: 9, declared: 10, negative: 11, constant: 12 };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demogap-test-"));
fs.mkdirSync(path.join(dir, "ui"));
fs.writeFileSync(path.join(dir, "ui", "thing.js"), FIXTURE_UI);
fs.writeFileSync(path.join(dir, "test_fixture.js"), FIXTURE_TEST);

let res;
try {
  res = D.measure(dir, "test_fixture.js", 12);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

ok(!res.unreadable, `the fixture is measurable (${res.unreadable || "hooked"})`);
const state = {};
for (const g of res.guards || []) state[g.line] = g.state;

ok(state[LINE.constant] === "INERT",
   `a constant expression is INERT (got ${state[LINE.constant]})`);
ok(state[LINE.negative] !== "INERT",
   `THE NEGATIVE CONTROL: a sound negative assertion is not indicted (got ${state[LINE.negative]})`);
ok(state[LINE.reads] === "DEMONSTRATED",
   `an assertion on a mutable value is DEMONSTRATED (got ${state[LINE.reads]})`);
ok(state[LINE.declared] === "DEMONSTRATED" || state[LINE.declared] === "COARSE",
   `an assertion on the source text is at least COARSE (got ${state[LINE.declared]})`);

/* ---- 2. the hook must not move a single line ---- */
/* Every recorded guard is a LINE NUMBER in the original file. If instrumentation shifts one
 * line, every number in every report is silently wrong about a real file — a defect that
 * reports itself as data, which is the worst kind this tool can have. */
{
  const src = FIXTURE_TEST;
  const inst = D.instrument(src, "/tmp/rec.json");
  ok(inst !== null, "a standard ok() helper is hookable");
  ok(inst.split("\n").length === src.split("\n").length,
     `hooking adds no lines (${src.split("\n").length} -> ${inst.split("\n").length})`);
  const before = src.split("\n");
  const after = inst.split("\n");
  let moved = 0;
  for (let i = 0; i < before.length; i++) if (i !== 5 && before[i] !== after[i]) moved++;
  ok(moved === 0, `no line but the helper's own definition is touched (${moved} moved)`);
  ok(D.instrument("let x = 1;\nconsole.log(x);\n", "/tmp/r") === null,
     "a file with no ok()/check() helper is not hookable, and says so rather than reporting zero guards");
}

/* ---- 3. mutation sites are never in a comment or a string ---- */
/* The repeated bite in this repo: a lexical tool fooled by a name inside a comment that
 * explains the thing the name identifies. A mutant placed in a comment changes nothing, so it
 * would be scored as "no guard noticed this" — a false clean, in the expensive direction. */
{
  const src = [
    "// the limit is 42 and a === b",
    "/* block: 99 <= 100 */",
    'const s = "text with 7 and >= inside";',
    "const real = 5;",
    "if (real >= 3) { real = real + 1; }",
  ].join("\n");
  const sites = D.sitesIn(src, null);
  const code = require("./covgap.js").lex(src).code;
  let inLiteral = 0;
  for (const s of sites) {
    const span = code.slice(s.start, s.end);
    if (span.trim() === "" && s.op !== "del") inLiteral++;    // blanked = it was comment or string
  }
  ok(sites.length > 0, `sites are found in real code (${sites.length})`);
  ok(inLiteral === 0, `no mutation site lands inside a comment or string literal (${inLiteral} did)`);
  ok(sites.some(s => s.op === "num" && s.why.includes("5")), "the live constant 5 is a site");
  ok(!sites.some(s => s.op === "num" && s.why.startsWith("number 42")), "the 42 in a comment is not");
  ok(!sites.some(s => s.op === "num" && s.why.startsWith("number 7")), "the 7 in a string is not");
}

/* ---- 4. an arrow is not a comparison ---- */
{
  const src = "const f = (a, b) => a >> 1;\nconst g = x => x << 2;\nconst h = (p, q) => p >= q;\n";
  const sites = D.sitesIn(src, null).filter(s => s.op === "cmp");
  ok(sites.length === 1 && sites[0].why === ">= -> <",
     `only the real comparison is flipped, not => or shifts (${sites.map(s => s.why).join(", ") || "none"})`);
}

/* ---- 5. the budget reaches every operator class ---- */
/* Identifiers outnumber comparisons by two orders of magnitude in these files. A flat pick
 * spent the whole budget on renames and never flipped an operator, so a guard that only a
 * flipped comparison could move read UNDEMONSTRATED for a reason that was about the picker. */
{
  const sites = [];
  for (let i = 0; i < 400; i++) sites.push({ op: "ident", i });
  for (let i = 0; i < 3; i++) sites.push({ op: "cmp", i });
  for (let i = 0; i < 2; i++) sites.push({ op: "num", i });
  const got = D.pickBalanced(sites, 12);
  const ops = new Set(got.map(s => s.op));
  ok(ops.has("cmp") && ops.has("num") && ops.has("ident"),
     `every operator class present in the picked set (${[...ops].join(", ")})`);
  ok(got.length <= Math.max(12, 3), `and the budget is respected (${got.length})`);
}

/* ---- 6. picking is deterministic, so a result can be re-derived rather than believed ---- */
{
  const sites = Array.from({ length: 50 }, (_, i) => ({ op: "num", i }));
  const a = D.pick(sites, 7).map(s => s.i).join(",");
  const b = D.pick(sites, 7).map(s => s.i).join(",");
  ok(a === b, `two picks over the same list agree (${a})`);
  ok(D.pick(sites, 100).length === 50, "asking for more than exists returns everything, not a pad");

  /* The header promises that raising --budget can only ADD demonstrations. That is only true if
   * the smaller pick is a subset of the larger one, which an evenly spaced pick is not — a
   * guard demonstrated at budget 20 could then vanish at 40, and nobody would ever check.
   *
   * 7 and 18, NOT 7 and 21. Written first with 21, this assertion passed against the evenly
   * spaced picker it was written to reject: `floor(i*len/n)` DOES nest when the larger budget
   * is a multiple of the smaller, so 21 tested the arithmetic of 3x7 rather than the property.
   * Found by reverting the picker and watching this line stay green — which is the whole
   * procedure this repo now has a tool for. */
  const small = new Set(D.pick(sites, 7).map(s => s.i));
  const large = new Set(D.pick(sites, 18).map(s => s.i));
  const lost = [...small].filter(i => !large.has(i));
  ok(lost.length === 0, `a bigger budget keeps every site the smaller one had (lost ${lost.length})`);
  const spread = D.pick(sites, 7).map(s => s.i);
  ok(Math.max(...spread) - Math.min(...spread) > 30,
     `and the small pick still spans the list rather than clustering (${spread.join(",")})`);
}

/* ---- 7. the referent is ranked, or the budget goes to the wrong files ---- */
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "demogap-ref-"));
  fs.mkdirSync(path.join(d2, "ui"));
  for (const f of ["thing.js", "other.js", "index.html"]) fs.writeFileSync(path.join(d2, "ui", f), "// x\n");
  fs.writeFileSync(path.join(d2, "testenv.js"), "module.exports={};\n");
  fs.writeFileSync(path.join(d2, "test_r.js"),
    'const { uiFunction } = require("./testenv.js");\nconst S = require("fs").readFileSync("ui/thing.js");\nuiFunction("q");\n');
  const ref = D.referentOf(d2, "test_r.js");
  const byRel = Object.fromEntries(ref.map(r => [r.rel, r.rank]));
  fs.rmSync(d2, { recursive: true, force: true });
  ok(byRel["ui/thing.js"] === 0, `a file the test names itself ranks 0 (got ${byRel["ui/thing.js"]})`);
  ok(byRel["ui/other.js"] === 2, `a file pulled in only by the uiSource blanket ranks 2 (got ${byRel["ui/other.js"]})`);
  ok(!("testenv.js" in byRel), "testenv itself is not a referent — mutating the harness proves nothing");
}

/* ---- 8. the saturated leg carries the test's own literals ---- */
/* This is the mechanism that rescues negative assertions, so it gets asserted directly rather
 * than only through section 1's outcome. */
{
  const noise = D.noiseFor("const a = 1;\n", 'ok(!/FORBIDDEN/.test(S), "nope");\n');
  ok(noise.includes("const a = 1;"), "the real source survives in the saturated leg");
  ok(noise.includes("FORBIDDEN"), "and the pattern the test forbids is now present in it");
}

/* ---- 9. flag interactions ---- */
/* covgap's own history: `--files ui/x.js --ref HEAD~1` exited with "no such file: HEAD~1",
 * because --files swallowed the next flag's value. Same parser shape, same trap. */
{
  const o = D.parseArgv(["--files", "test_a.js", "test_b.js", "--ref", "HEAD~2", "--budget", "9"]);
  ok(o.explicit.join(",") === "test_a.js,test_b.js", `--files stops at the next flag (${o.explicit.join(",")})`);
  ok(o.ref === "HEAD~2", `--ref survives after --files (${o.ref})`);
  ok(o.budget === 9, `--budget is read (${o.budget})`);
  ok(D.parseArgv([]).budget === 30, "and has a default rather than zero");
  ok(D.inRanges(5, [[1, 4], [5, 9]]) && !D.inRanges(10, [[1, 4]]), "line scoping is inclusive at both ends");
  ok(D.inRanges(999, null), "a null range means whole-file scope, not empty scope");
}

/* ---- 10. a brand new test file is in scope, and it is the whole point ---- */
/* `git diff` cannot see a file git has never seen. A newly written test is the case this tool
 * exists for — no recorded run in which it fails — and for its whole first life it is
 * untracked. Left out, the default scope printed "no test files in scope", which reads exactly
 * like a clean bill. This file was untracked when it printed that about itself. */
{
  const diff = "--- a/test_old.js\n+++ b/test_old.js\n@@ -3,0 +4,2 @@\n+ok(1);\n+ok(2);\n" +
               "--- a/ui/thing.js\n+++ b/ui/thing.js\n@@ -1,0 +2,1 @@\n+x\n";
  const scope = D.buildScope(diff, "test_brand_new.js\nnotes.md\nui/scratch.js\n");
  ok(scope.has("test_old.js"), "a changed test file is in scope");
  ok(Array.isArray(scope.get("test_old.js")), "with its changed line ranges");
  ok(scope.has("test_brand_new.js"), "AN UNTRACKED TEST FILE IS IN SCOPE");
  ok(scope.get("test_brand_new.js") === null, "and whole-file, since every line of it is new");
  ok(!scope.has("ui/thing.js") && !scope.has("ui/scratch.js") && !scope.has("notes.md"),
     "and nothing that is not a test file is");
  ok(D.buildScope("", "").size === 0, "an empty diff is an empty scope, not a crash");
}

/* ---- 11. the mutant timeout is derived from the baseline, not flat ---- */
/* A flat 300 s let one hung mutant hold an --all run open for five minutes, and the audit ran
 * past twenty-five with no way to tell churning from stuck. */
{
  ok(D.runBudgetMs(400) === 5000, `a fast test still gets a floor, not 4 s (${D.runBudgetMs(400)})`);
  ok(D.runBudgetMs(2000) === 20000, `a slow test gets ten times its own baseline (${D.runBudgetMs(2000)})`);
  ok(D.runBudgetMs(60000) < 700000, "and the scale stays proportional rather than unbounded");
}

console.log(fails ? `test_demogap: ${fails} FAILED` : "test_demogap: all pass");
process.exit(fails ? 1 : 0);

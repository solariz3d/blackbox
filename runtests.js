/* runtests.js — run every test_*.js and fail loudly if any of them do.
 *
 * WHY THIS EXISTS, and it is not tidiness. There was no runner, so checking the suite meant
 * hand-rolling a shell loop each time. On 2026-07-27 one of those loops printed a failure and
 * still exited 0 — `for f in ...; do node $f; done` reports the status of the LAST command,
 * not the worst one — and a commit went out on top of a red test that had been printed to
 * screen and read past. The failure mode was not carelessness that discipline would fix; it
 * was that no single action existed whose result was the answer. So: one action, one answer.
 *
 *   node runtests.js            all tests
 *   node runtests.js glow lamp  only tests whose name contains one of these
 *
 * Exit code IS the verdict: 0 iff every test exited 0. Nothing else is reported as success.
 * Tests that need Assetto Corsa content skip themselves via testenv's `skip()` and exit 0;
 * a skip is reported distinctly so an empty run cannot masquerade as a green one.
 */
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const files = fs.readdirSync(__dirname)
  .filter(n => /^test_.*\.js$/.test(n))
  .filter(n => !args.length || args.some(a => n.includes(a)))
  .sort();

if (!files.length) {
  console.error(args.length ? `no test matches ${args.join(", ")}` : "no tests found");
  process.exit(1);
}

const failed = [], skipped = [];
for (const f of files) {
  let out = "", code = 0;
  try {
    out = execFileSync("node", [path.join(__dirname, f)], { encoding: "utf8", timeout: 300000 });
  } catch (e) {
    code = e.status === undefined ? 1 : e.status;      // timeout/spawn failure counts as failure
    out = (e.stdout || "") + (e.stderr || "");
  }
  const last = out.trim().split("\n").pop() || "";
  if (code !== 0) {
    failed.push({ f, out });
    console.log(`FAIL  ${f}`);
  } else if (/\bskip/i.test(last)) {
    skipped.push(f);
    console.log(`skip  ${f}  ${last.slice(0, 70)}`);
  } else {
    console.log(`ok    ${f}`);
  }
}

console.log(`\n${files.length - failed.length - skipped.length} passed, ` +
            `${skipped.length} skipped, ${failed.length} failed`);

// A failure's output is worth more than its name, so print it rather than making someone
// re-run the one test to find out what happened.
for (const { f, out } of failed) {
  console.log(`\n===== ${f} =====\n${out.trim()}`);
}

process.exit(failed.length ? 1 : 0);

/* test_shadersyntax.js — the shader sources are JS template literals; keep them intact.
 *
 * WHY THIS EXISTS. A comment written inside the GLSL used markdown-style backticks around
 * an identifier. A backtick ENDS the template literal, so everything after it was parsed as
 * JavaScript and glcore.js died with "Unexpected identifier 'soft'". Every script in this
 * app shares one global scope, so that one character stopped the entire startup — and the
 * only visible symptom was the track gallery never opening, four files away, with the app
 * otherwise looking fine. It cost a debugging round to find, and it happened while writing
 * the comment that explained the PREVIOUS breakage of the same file.
 *
 * Two cheap checks, both of which would have caught it before the build:
 *   1. no stray backtick inside a shader template
 *   2. every UI script actually parses as JavaScript
 *
 * Run: node test_shadersyntax.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok " : "FAIL"} - ${m}`); if (!c) fails++; };

console.log("shader templates are unbroken");
{
  const src = fs.readFileSync(path.join(__dirname, "ui", "glcore.js"), "utf8").split("\n");
  let inTpl = false;
  const stray = [];
  src.forEach((ln, i) => {
    if (/const \w+ = `/.test(ln)) { inTpl = true; return; }   // template opens
    if (inTpl && /`;?\s*$/.test(ln)) { inTpl = false; return; }  // and closes
    if (inTpl && ln.includes("`")) stray.push(`${i + 1}: ${ln.trim()}`);
  });
  ok(stray.length === 0,
     stray.length ? `stray backtick inside shader source —\n      ${stray.join("\n      ")}`
                  : "no stray backticks inside any shader template");
  ok(!inTpl, "every shader template that opens also closes");
}

console.log("\nevery UI script parses as JavaScript");
{
  const dir = path.join(__dirname, "ui");
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const code = fs.readFileSync(path.join(dir, f), "utf8");
    let err = null;
    try { new vm.Script(code, { filename: f }); } catch (e) { err = e.message; }
    ok(!err, err ? `${f} — ${err}` : f);
  }
}

/* index.html's remaining inline scripts — the head error reporter and the shared state plus
 * the main loop. Much smaller since the module split moved 5,821 lines out into ui/*.js, but
 * a syntax error in either is still fatal and still silent.
 *
 * This reads index.html DIRECTLY and must keep doing so: it parses the file as HTML to find
 * <script> blocks without a src. Pointing it at the concatenated UI source, which a
 * mechanical repoint briefly did, makes the regex match `<script` occurrences inside JS
 * string literals and then fail to parse them — a failure about the test, not the code. */
console.log("\nthe inline scripts in index.html parse");
{
  const html = fs.readFileSync(path.join(__dirname, "ui", "index.html"), "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    let err = null;
    try { new vm.Script(m[1], { filename: `index.html#${n}` }); } catch (e) { err = e.message; }
    ok(!err, err ? `inline block ${n} — ${err}` : `inline block ${n} (${m[1].split("\n").length} lines)`);
  }
  ok(n > 0, "found at least one inline block");
}

console.log(fails ? `\n${fails} FAILED` : "\nall good");
process.exit(fails ? 1 : 0);

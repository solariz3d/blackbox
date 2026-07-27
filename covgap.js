/* covgap.js — which functions in a change have no test reaching them.
 *
 * WHY THIS EXISTS. `drawCarLights` and `wheelSteerModel` were rewritten on 2026-07-27 and
 * the suite was green the whole time — because nothing in it touched either function. A
 * real defect lived in that gap for an hour. Green meant "you did not break anything else",
 * and there was nothing in the repo that could say so out loud.
 *
 * WHAT IT CLAIMS, EXACTLY. This tool is sound in ONE direction only, and the asymmetry is
 * the whole design:
 *
 *   UNCOVERED  is a real finding. No test file mentions the name anywhere a test could act
 *              on it — not as an identifier, not inside a source-reaching string, not in a
 *              regex. A test cannot be exercising a name it never says. This is close to
 *              proof of absence.
 *
 *   exec/pin   are NOT claims of coverage. They say a test REACHES the function. Whether it
 *              asserts anything worth having about it is a question no lexical tool can
 *              answer, and this one does not pretend to. It narrows where to look; it never
 *              certifies.
 *
 * So: trust the red, verify the green. That is the only honest contract available here, and
 * saying it in the output every run is deliberate.
 *
 * USING vs MENTIONING — the thing this repo keeps getting bitten by. Four separate times a
 * lexical check has been fooled by a name appearing in a comment that EXPLAINS the thing the
 * name identifies (see test_glowpool.js's `decomment`). But the naive fix — strip comments
 * and strings, search what is left — is wrong HERE, and wrong in the expensive direction:
 * `uiFunction("batchGlow")` puts the name in a string literal and is the strongest coverage
 * signal in the codebase. Stripping strings would report every mirror-anchored test as no
 * coverage at all.
 *
 * So the classifier is positional, not textual. Every byte of every test is labelled code /
 * comment / string / template / regex by an actual scanner, and then:
 *
 *   - code position                      -> a use
 *   - string or regex that reaches source -> a use   (uiFunction("N"), "function N", /function\s+N/)
 *   - any other string, any comment       -> a MENTION, and mentions are never coverage
 *
 * MIRRORS COUNT, AND HERE IS THE DEFENCE. Some tests re-implement logic rather than importing
 * it, because the real code lives inside a GL draw call (test_lampglare.js, test_glowpool.js).
 * A free-floating mirror would be worthless — a copy asserting things about itself. These are
 * not free-floating: they read the shipped source back and assert the real function still
 * contains the constants and rules the mirror assumes. That tie is what makes them real. It
 * has a specific, limited strength: a pinned function cannot drift without the test going
 * red, which is exactly the failure mode that let the module split break eight tests at once.
 * It is weaker than execution and it is reported as a separate class, never merged into one
 * "covered" bucket, because the two fail differently and a reader deserves to know which.
 *
 * OVER-REPORTING. A list of 200 uncovered functions gets read once. Default scope is the
 * change, not the repo: only functions whose bodies the diff actually touched. `--all` exists
 * for a deliberate audit and prints its own scale so nobody mistakes it for the change report.
 *
 * ONE SELF-REFERENCE, ON PURPOSE. test_covgap.js names real ui functions as fixtures, and this
 * tool indexes it like any other test — so those names read as MENTION-ONLY forever rather than
 * UNCOVERED. That is not a bug being tolerated: excluding a file by name would make the tool lie
 * about what it read, and MENTION-ONLY is defined as a lead to check by hand, which a reader
 * dismisses in a second on seeing test_covgap.js in the list. The alternative — a magic filename
 * skip — trades an honest second of a reader's time for a rule nobody can see.
 *
 * LIMITS, STATED. Top-level declarations only — the same contract testenv's uiFunction has.
 * A closure inside another function is invisible to this tool (the `push` that used to live
 * inside drawCarLights would not have been listed). Name collisions across ui files are
 * reported against every definition, since nothing here resolves scope. The regex-vs-division
 * disambiguation is the standard previous-token heuristic, not a parse.
 *
 * WHY IT LIVES HERE. Repo root, beside testenv.js: it consumes ui/*.js and test_*.js by the
 * same convention testenv does, the repo's other node tools (extract_bank.js, make_eventmap.js)
 * are at root, and there is no package.json or bin/ to put it in. Run it the way everything
 * else here runs — bare node, no framework, exit code carries the verdict.
 *
 * Run:
 *   node covgap.js                      working-tree diff (staged + unstaged)
 *   node covgap.js --ref HEAD~1         everything since a ref
 *   node covgap.js --files ui/lightfx.js ui/carrender.js
 *   node covgap.js --all                every top-level function in ui/
 *   node covgap.js --json               machine-readable, for a hook
 *   node covgap.js --strict             exit 1 when anything in scope is uncovered
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const UI = path.join(ROOT, "ui");

/* ------------------------------------------------------------------ *
 * 1. the scanner — where in a JS file each byte actually lives
 * ------------------------------------------------------------------ */

/* Returns { code, literals }.
 *
 * `code` is the source with every comment, string, template and regex body overwritten by
 * spaces, newlines preserved, so offsets and line numbers still line up with the original.
 * Searching it finds identifiers in executable position and nothing else.
 *
 * `literals` is every non-code span, each carrying the code that immediately preceded it —
 * which is how a source-reaching call like uiFunction("name") is told from a bare string. */
function lex(src) {
  const n = src.length;
  const code = new Array(n);
  const literals = [];
  // blank a span but keep newlines, so line numbers survive
  const blank = (from, to) => { for (let k = from; k < to; k++) code[k] = src[k] === "\n" ? "\n" : " "; };
  const keep = (from, to) => { for (let k = from; k < to; k++) code[k] = src[k]; };

  // last significant code character, for the regex-vs-division call
  let prev = "";
  let prevWord = "";
  const REGEX_OK_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}",
                                  ";", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
  const REGEX_OK_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete",
                                  "void", "throw", "case", "do", "else", "yield", "await"]);
  const regexAllowed = () => REGEX_OK_AFTER.has(prev) || REGEX_OK_WORDS.has(prevWord);

  const tmplStack = [];        // brace depth inside each open ${ }
  let i = 0;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];

    if (c === "/" && c2 === "/") {
      let j = src.indexOf("\n", i); if (j < 0) j = n;
      literals.push({ kind: "comment", start: i, end: j, text: src.slice(i, j), before: tail(code, i) });
      blank(i, j); i = j; continue;
    }
    if (c === "/" && c2 === "*") {
      let j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2;
      literals.push({ kind: "comment", start: i, end: j, text: src.slice(i, j), before: tail(code, i) });
      blank(i, j); i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === "\\") j++; j++; }
      j = Math.min(n, j + 1);
      literals.push({ kind: "string", start: i, end: j, text: src.slice(i + 1, j - 1), before: tail(code, i) });
      blank(i, j); i = j; continue;
    }
    if (c === "`") {
      // template: ${ } holes are real code and are left as code
      const start = i;
      let j = i + 1;
      let chunk = "";
      blank(i, i + 1);
      while (j < n) {
        if (src[j] === "\\") { chunk += src[j + 1] || ""; blank(j, j + 2); j += 2; continue; }
        if (src[j] === "`") { blank(j, j + 1); j++; break; }
        if (src[j] === "$" && src[j + 1] === "{") {
          keep(j, j + 2);                       // the hole is code
          tmplStack.push(1); j += 2;
          let depth = 1;
          // scan the hole with the main loop by falling through: simplest correct thing is a
          // nested walk, since holes are short in this codebase
          while (j < n && depth > 0) {
            if (src[j] === "{") depth++;
            else if (src[j] === "}") depth--;
            code[j] = src[j];
            j++;
          }
          tmplStack.pop();
          continue;
        }
        chunk += src[j]; blank(j, j + 1); j++;
      }
      literals.push({ kind: "template", start, end: j, text: chunk, before: tail(code, start) });
      i = j; continue;
    }
    if (c === "/" && regexAllowed()) {
      // regex literal — / inside a [...] class does not terminate it
      let j = i + 1, cls = false, ok = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;                      // unterminated: it was division after all
        if (cls) { if (d === "]") cls = false; }
        else if (d === "[") cls = true;
        else if (d === "/") { ok = true; break; }
        j++;
      }
      if (ok) {
        let k = j + 1;
        while (k < n && /[a-z]/.test(src[k])) k++;  // flags
        literals.push({ kind: "regex", start: i, end: k, text: src.slice(i + 1, j), before: tail(code, i) });
        blank(i, k); i = k; continue;
      }
      // fall through: it was a division operator
    }

    code[i] = c;
    if (!/\s/.test(c)) { prev = c; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      for (let k = i; k < j; k++) code[k] = src[k];
      prev = src[j - 1];
      i = j; continue;
    } else if (!/\s/.test(c)) prevWord = "";
    i++;
  }
  for (let k = 0; k < n; k++) if (code[k] === undefined) code[k] = src[k] === "\n" ? "\n" : " ";
  return { code: code.join(""), literals };
}

/* The already-classified code just before an offset — the call context of a literal. 120 is
 * empirical: it has to span `new Function("a", "b", scratch + src + ` back to the callee,
 * and those leading arguments blank to spaces, which costs width. */
function tail(codeArr, at) {
  const from = Math.max(0, at - 120);
  let s = "";
  for (let k = from; k < at; k++) s += codeArr[k] === undefined ? " " : codeArr[k];
  return s;
}

const lineOf = (src, off) => src.slice(0, off).split("\n").length;

/* ------------------------------------------------------------------ *
 * 2. top-level functions in the ui sources
 * ------------------------------------------------------------------ */

/* Declarations at column 0 only — deliberately the same contract testenv.uiFunction has, so
 * "covgap says it exists" and "a test can reach it with uiFunction" never disagree. */
function topLevelFunctions(file) {
  const src = fs.readFileSync(file, "utf8");
  const { code } = lex(src);                 // never match a declaration inside a comment
  const out = [];
  const push = (name, start, end) => out.push({
    name, file: path.relative(ROOT, file).replace(/\\/g, "/"),
    startLine: lineOf(src, start), endLine: lineOf(src, end),
  });

  const decl = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = decl.exec(code))) {
    const brace = code.indexOf("{", m.index + m[0].length - 1);
    if (brace < 0) continue;
    push(m[1], m.index, matchBrace(code, brace));
  }
  // const NAME = (...) => ... / = function ... — the codebase uses both forms at top level
  const arrow = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/gm;
  while ((m = arrow.exec(code))) {
    const eol = code.indexOf("\n", m.index);
    const brace = code.indexOf("{", m.index);
    // a block body starts before this line ends; anything else is an expression body
    const end = brace >= 0 && brace < (eol < 0 ? code.length : eol) ? matchBrace(code, brace)
                                                                   : (eol < 0 ? code.length : eol);
    push(m[1], m.index, end);
  }
  return out;
}

function matchBrace(code, at) {
  let d = 0;
  for (let j = at; j < code.length; j++) {
    if (code[j] === "{") d++;
    else if (code[j] === "}") { d--; if (d === 0) return j + 1; }
  }
  return code.length;
}

/* ------------------------------------------------------------------ *
 * 3. what each test reaches
 * ------------------------------------------------------------------ */

/* A string or regex "reaches source" when it is the argument of a source-extracting helper,
 * or when it spells a declaration the test is about to locate in the shipped text. Those are
 * the two shapes this repo's mirror tests actually use. */
function sourceReaching(lit, name) {
  const t = lit.text;
  if (lit.kind === "comment") return false;
  // uiFunction("name") / uiFunction('name') — including E.uiFunction and destructured
  if (t === name && /\buiFunction\s*\(\s*$/.test(lit.before)) return true;
  // "function name" inside indexOf / includes / a slice of the shipped source
  if (new RegExp("(^|[^\\w$])function\\s+" + esc(name) + "([^\\w$]|$)").test(t)) return true;
  // /function\s+name/ as a regex literal
  if (lit.kind === "regex" && new RegExp("function[\\\\s+]*\\s*" + esc(name) + "\\b").test(t)) return true;
  return false;
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* Source that is about to be RUN, not merely read.
 *
 * Two tests build a callable out of the shipped text — test_glowpool with
 * `new Function(..., scratch + src + "; return wheelSteerModel;")`, test_turbinegate with
 * `vm.runInContext(consts + grab("pathRadius") + ..., sandbox)`. Both name the function inside
 * a string argument to the evaluator, and both then call the real code. That is execution and
 * it must not be filed as a mirror.
 *
 * The rule is deliberately narrow: the name in a literal whose CALL CONTEXT is the evaluator.
 * A file-level "this test uses new Function somewhere" flag was the first version and it was
 * wrong in the expensive direction — it promoted batchGlow, which test_glowpool only regexes,
 * to executed. Proximity is a heuristic; over-claiming coverage is a defect. */
function evaluated(lit, name) {
  if (lit.kind === "comment") return false;
  if (!new RegExp("(^|[^\\w$])" + esc(name) + "(?![\\w$])").test(lit.text)) return false;
  return /\bnew\s+Function\s*\(|\bvm\s*\.\s*runIn|\brunIn(?:New)?Context\s*\(/.test(lit.before);
}

/* One test file, reduced to what classify() needs. Exported so the tests can build an entry
 * the same way the tool does, rather than mirroring this shape and drifting from it. */
function analyzeTest(file, src) {
  const { code, literals } = lex(src);
  const requiredUi = new Set();
  for (const lit of literals) {
    if (lit.kind !== "string" && lit.kind !== "template") continue;
    if (!/\brequire\s*\(\s*$/.test(lit.before)) continue;
    const m = /(?:^|\/)ui\/([\w.-]+\.js)$/.exec(lit.text.replace(/\\/g, "/"));
    if (m) requiredUi.add("ui/" + m[1]);
  }
  return { file, src, code, literals, requiredUi };
}

function indexTests() {
  return fs.readdirSync(ROOT).filter(f => /^test_.*\.js$/.test(f))
           .map(f => analyzeTest(f, fs.readFileSync(path.join(ROOT, f), "utf8")));
}

/* exec > pin > mention. Returns { level, tests: {exec:[], pin:[], mention:[]} }. */
function classify(fn, tests) {
  const word = new RegExp("(^|[^\\w$.])" + esc(fn.name) + "(?![\\w$])");
  const wordAny = new RegExp("(^|[^\\w$])" + esc(fn.name) + "(?![\\w$])");
  const hit = { exec: [], pin: [], mention: [] };

  for (const t of tests) {
    const inCode = wordAny.test(t.code);
    const reaching = t.literals.some(l => sourceReaching(l, fn.name));
    const mentioned = t.literals.some(l => wordAny.test(l.text));

    // executing the real thing: the defining module is loaded, or the source is rebuilt and run
    const loadsModule = t.requiredUi.has(fn.file);
    const runs = t.literals.some(l => evaluated(l, fn.name));
    if (inCode && loadsModule) { hit.exec.push(t.file); continue; }
    if (runs) { hit.exec.push(t.file); continue; }
    if (reaching) { hit.pin.push(t.file); continue; }
    // a bare identifier with no module load and no source anchor is most likely a local of the
    // test's own — recorded, but it is not evidence about the ui function
    if (inCode || mentioned) hit.mention.push(t.file);
  }
  const level = hit.exec.length ? "exec" : hit.pin.length ? "pin"
              : hit.mention.length ? "mention" : "none";
  return { level, hit };
}

/* ------------------------------------------------------------------ *
 * 4. scope — what the change actually touched
 * ------------------------------------------------------------------ */

function git(args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/* Changed line ranges per file, from the post-image side of the diff. */
function changedRanges(ref) {
  const args = ["diff", "--unified=0", "--no-color"];
  if (ref) args.push(ref);
  let out;
  try { out = git(args); }
  catch (e) { throw new Error("git diff failed — is this a git repo? (" + String(e.message).trim() + ")"); }
  const byFile = new Map();
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { cur = f[1]; if (!byFile.has(cur)) byFile.set(cur, []); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const start = +h[1], len = h[2] === undefined ? 1 : +h[2];
      if (len > 0) byFile.get(cur).push([start, start + len - 1]);
    }
  }
  return byFile;
}

const overlaps = (fn, ranges) => ranges.some(([a, b]) => fn.startLine <= b && fn.endLine >= a);

/* ------------------------------------------------------------------ *
 * 5. report
 * ------------------------------------------------------------------ */

/* Printed every run, on purpose. A tool that reports coverage and does not say what it means
 * by the word is how "the suite is green" became load-bearing in the first place. */
const CONTRACT = [
  "UNCOVERED  no test file says this name at all. Nothing in the suite TARGETS it, so no",
  "           failure will point here. It can still run incidentally via a caller that IS",
  "           tested — this reads names, not call graphs.",
  "MENTION    the name appears only in a comment or an inert string. A lead to check by",
  "           hand, not a verdict: a grep would have called it covered.",
  "exec/pin   a test REACHES the function (runs it / anchors on its source text). Neither",
  "           says the assertions are worth anything. Trust the red; verify the green.",
];

function main(argv) {
  const opt = { json: argv.includes("--json"), all: argv.includes("--all"), strict: argv.includes("--strict") };
  const refI = argv.indexOf("--ref");
  const ref = refI >= 0 ? argv[refI + 1] : null;
  const filesI = argv.indexOf("--files");
  const explicit = filesI >= 0 ? argv.slice(filesI + 1).filter(a => !a.startsWith("--")) : null;

  const uiFiles = fs.readdirSync(UI).filter(f => f.endsWith(".js")).map(f => path.join(UI, f));
  const tests = indexTests();

  let scope = [];              // [{fn, changed}]
  let scopeLabel;
  if (opt.all) {
    scopeLabel = "every top-level function in ui/";
    for (const f of uiFiles) for (const fn of topLevelFunctions(f)) scope.push(fn);
  } else if (explicit && explicit.length) {
    scopeLabel = "files: " + explicit.join(", ");
    for (const rel of explicit) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) { console.error("no such file: " + rel); process.exit(2); }
      for (const fn of topLevelFunctions(abs)) scope.push(fn);
    }
  } else {
    scopeLabel = ref ? "changed since " + ref : "working-tree diff";
    const ranges = changedRanges(ref);
    for (const [rel, rr] of ranges) {
      if (!/^ui\/.+\.js$/.test(rel)) continue;
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;                 // deleted in this change
      for (const fn of topLevelFunctions(abs)) if (overlaps(fn, rr)) scope.push(fn);
    }
  }

  const rows = scope.map(fn => ({ ...fn, ...classify(fn, tests) }))
                    .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine));

  if (opt.json) {
    console.log(JSON.stringify({ scope: scopeLabel, contract: CONTRACT, functions: rows }, null, 2));
  } else {
    print(rows, scopeLabel, opt);
  }
  const uncovered = rows.filter(r => r.level === "none" || r.level === "mention");
  if (opt.strict && uncovered.length) process.exit(1);
  process.exit(0);
}

function print(rows, scopeLabel, opt) {
  console.log("covgap — " + scopeLabel);
  if (!rows.length) {
    console.log("\n  no top-level ui functions in scope.");
    console.log("  (a change to inline index.html script or to a closure inside a function is invisible here)");
    return;
  }
  const bad = rows.filter(r => r.level === "none");
  const men = rows.filter(r => r.level === "mention");
  const ok = rows.filter(r => r.level === "exec" || r.level === "pin");

  const byFile = new Map();
  for (const r of rows) { if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push(r); }
  const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));

  console.log("");
  for (const [file, list] of byFile) {
    console.log("  " + file);
    for (const r of list) {
      const span = r.startLine + "-" + r.endLine;
      if (r.level === "none") {
        console.log("    UNCOVERED     " + pad(r.name, 26) + pad(span, 12) + (r.endLine - r.startLine + 1) + " lines");
      } else if (r.level === "mention") {
        console.log("    MENTION-ONLY  " + pad(r.name, 26) + pad(span, 12) + r.hit.mention.join(", "));
      } else if (r.level === "pin") {
        console.log("    pinned        " + pad(r.name, 26) + pad(span, 12) + r.hit.pin.join(", "));
      } else {
        console.log("    exec          " + pad(r.name, 26) + pad(span, 12) + r.hit.exec.join(", "));
      }
    }
  }

  console.log("");
  console.log(`  ${bad.length} uncovered · ${men.length} mention-only · ${ok.length} reached ` +
              `(${rows.filter(r => r.level === "exec").length} exec, ${rows.filter(r => r.level === "pin").length} pinned)` +
              `  of ${rows.length} in scope`);
  if (men.length) {
    console.log("\n  MENTION-ONLY is the one that looks like coverage and is not: the name appears");
    console.log("  only in a comment or an inert string. A grep would call these covered.");
  }
  console.log("\n  " + CONTRACT.join("\n  "));
  if (opt.all) console.log("\n  (--all: a repo audit, not a report about any change)");
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { lex, topLevelFunctions, analyzeTest, indexTests, classify, changedRanges,
                   sourceReaching, evaluated, overlaps, matchBrace };
if (typeof window !== "undefined") window.covgap = module.exports;

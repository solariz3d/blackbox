/* covgap.js — which functions in a change have no test reaching them.
 *
 * WHY THIS EXISTS. `drawCarLights` and `wheelSteerModel` were rewritten on 2026-07-27 and
 * the suite was green the whole time — because nothing in it touched either function. A
 * real defect lived in that gap for an hour. Green meant "you did not break anything else",
 * and there was nothing in the repo that could say so out loud.
 *
 * WHAT IT CLAIMS, EXACTLY. Narrower than the first draft of this header said, and the
 * correction is measured rather than argued:
 *
 *   UNCOVERED  no test file says the name anywhere a test could act on it — not as an
 *              identifier, not in a source-reaching string, not in a regex. So nothing in the
 *              suite TARGETS it, and no failure will ever point here.
 *
 *              It does NOT mean the function never runs under the suite. A reviewer measured
 *              this against the repo: of 178 functions reported UNCOVERED, 22 are called
 *              directly by a function the suite executes. That is one-hop and same-file, so it
 *              is a LOWER BOUND — roughly one in eight is exercised incidentally, through a
 *              caller, with no test naming it. This tool reads names; it does not build a call
 *              graph, and a name-reader cannot see through a caller.
 *
 *   exec/pin   are NOT claims of coverage. They say a test REACHES the function. Whether it
 *              asserts anything worth having about it is a question no lexical tool can
 *              answer, and this one does not pretend to. It narrows where to look; it never
 *              certifies.
 *
 * The header used to say "close to proof of absence" and "trust the red" while the contract
 * printed at the bottom of every run said the honest thing. When a file's headline and its own
 * output disagree, the output is the one people act on and the header is the one people quote
 * — so the header moved, not the contract.
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
 * THE LIMIT THAT LET THIS FILE SHIP WITH NINE DEFECTS. Scope is `ui/*.js`, so covgap cannot see
 * the repo-root tools — including itself. Nobody could have run covgap on covgap, and a reviewer
 * found that three of the nine (the diff default, the --files flag interaction, the arrow-span
 * arithmetic) sat in code this repo's suite never executed a line of. That is precisely the gap
 * this tool exists to name, occurring inside it, undetectable by it. The three are now split
 * into pure functions and asserted; the structural hole is not closed. Widening scope to root
 * `*.js` is a few lines — the tests would need to record `require("./covgap.js")` alongside the
 * ui form — but it changes what every run reports, so it is written down here rather than done
 * quietly.
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
 *   node covgap.js                      everything since HEAD — staged AND unstaged
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
          /* A hole is code, so it gets LEXED as code — recursively, not copied.
           *
           * The first version walked the hole byte by byte tracking brace depth and wrote every
           * byte into the code view. That put a string inside a hole into code position, so the
           * same literal got two different classes depending on where it sat — the positional
           * promise this whole file rests on, failing quietly. Worse, an unbalanced brace inside
           * a string in the hole ("}"), which is legal, walked the depth counter off the end.
           *
           * Recursing costs a pass over a short span and gets both right. The one thing it cannot
           * carry across the boundary is `before`: a literal inside a hole sees only the hole's
           * own code as its call context. Holes in this codebase are short expressions, never a
           * uiFunction() call, so nothing depends on it — stated here rather than discovered. */
          keep(j, j + 2);
          const holeStart = j + 2;
          let depth = 1, k = holeStart;
          const sub = lex(src.slice(holeStart));          // classify first, then trust the classes
          while (k < n && depth > 0) {
            const rel = k - holeStart;
            const inCode = sub.code[rel] === src[k];      // a brace the sub-lexer kept is a real brace
            if (inCode && src[k] === "{") depth++;
            else if (inCode && src[k] === "}") { depth--; if (depth === 0) break; }
            k++;
          }
          const holeEnd = Math.min(k, n);
          for (let q = holeStart; q < holeEnd; q++) code[q] = sub.code[q - holeStart];
          for (const l of sub.literals) {
            if (l.start >= holeEnd - holeStart) break;
            literals.push({ ...l, start: l.start + holeStart, end: l.end + holeStart });
          }
          if (holeEnd < n) keep(holeEnd, holeEnd + 1);    // the closing }
          j = holeEnd + 1;
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
  while ((m = arrow.exec(code))) push(m[1], m.index, valueEnd(code, m.index));
  return out;
}

/* Where a `const NAME = …` value ends.
 *
 * The first version asked whether a `{` appeared before the first newline, and took end-of-line
 * if not. A multi-line parameter list —
 *
 *     const f = (
 *       a, b
 *     ) => { … }
 *
 * — puts the brace on line 3, so the function collapsed to lines 1-1. A change to its body then
 * failed `overlaps()` and the function vanished from the report entirely: not listed as covered,
 * not listed as uncovered, silently absent. That is the false-clean this tool exists to prevent,
 * committed by the tool's own scope arithmetic, and it is invisible because a missing row looks
 * exactly like a row that was never in scope.
 *
 * So find the arrow at bracket depth zero, then take a block body by brace matching and an
 * expression body to its terminating `;`. */
function valueEnd(code, from) {
  let d = 0, i = from;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    else if (d === 0 && c === "=" && code[i + 1] === ">") { i += 2; break; }
    else if (d === 0 && c === ";") return i + 1;          // `= function foo() {}` ends by brace, below
    else if (d === 0 && c === "{" ) break;
  }
  if (i >= code.length) return code.length;
  while (i < code.length && /\s/.test(code[i])) i++;
  if (code[i] === "{") return matchBrace(code, i);
  // expression body: the first `;` outside brackets. A line break alone does not end it —
  // `const f = a =>\n  a + 1;` is one declaration.
  d = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") { if (d === 0) return j; d--; }
    else if (d === 0 && c === ";") return j + 1;
  }
  return code.length;
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
  /* /function\s+name/ as a regex literal. `t` is the regex's SOURCE TEXT, so the whitespace
   * between the keyword and the name is spelled there as the three literal characters \, s, +
   * — not as whitespace. The class below therefore contains a literal backslash (\\), the
   * letters s and S, the quantifiers + * ?, braces and digits for \s{1,3}, and real whitespace.
   *
   * The previous version wrote [\\s+], which in a regex SOURCE is a class of backslash, s and
   * plus — accidentally the right three characters, so it passed on every mirror in the repo
   * and would have failed the moment one was written /function\s*name/ or /function +name/.
   * Right answer, wrong reason, is a defect with a delay on it. */
  if (lit.kind === "regex" &&
      new RegExp("function[\\\\sS+*?{},0-9\\s]*" + esc(name) + "(?![\\w$])").test(t)) return true;
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
  /* What counts as the function appearing in executable position.
   *
   * `bare` excludes a preceding dot, because `results.cullLights = 3` is a property on the
   * test's own object and says nothing about the ui function of that name. But a dot cannot
   * simply be banned: `TL.cullLights([], eye, 4)` after `require("./ui/tracklights.js")` is
   * the PRIMARY execution shape in this repo, and rejecting it would drop most real coverage.
   *
   * The cut is call-vs-access, not dot-vs-no-dot. A dotted CALL is a use; a dotted read or
   * assignment is not. An earlier draft computed the no-dot guard, left it unwired, and used
   * the permissive form for everything — so the dead variable was itself the discrimination
   * that would have prevented the over-claim. */
  const bare = new RegExp("(^|[^\\w$.])" + esc(fn.name) + "(?![\\w$])");
  const dottedCall = new RegExp("\\.\\s*" + esc(fn.name) + "\\s*\\(");
  const wordAny = new RegExp("(^|[^\\w$])" + esc(fn.name) + "(?![\\w$])");
  const hit = { exec: [], pin: [], mention: [] };

  for (const t of tests) {
    const inCode = bare.test(t.code) || dottedCall.test(t.code);
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

/* Changed line ranges per file, from the post-image side of the diff.
 *
 * DEFAULTS TO `HEAD`, NOT TO A BARE `git diff`. Bare `git diff` is unstaged-only, so anyone who
 * had staged their work — which is to say anyone about to commit, the exact moment this tool is
 * for — got "no top-level ui functions in scope" and a clean bill on an unexamined change. The
 * docstring said staged + unstaged and the code delivered neither. Silent empty scope is the
 * worst failure this tool has, because an empty report is indistinguishable from a good one. */
/* Split from the git call so the default can be asserted without a repo. The three CLI defects
 * a reviewer found all lived in code no test ran; the fix is not only to correct them but to
 * make the parts testable, which for a shell-out means separating the argv from the parse. */
function diffArgs(ref) { return ["diff", "--unified=0", "--no-color", ref || "HEAD"]; }

/* Post-image line ranges per file, from unified-diff text. Pure. */
function parseDiff(out) {
  const byFile = new Map();
  let cur = null;
  for (const line of String(out).split(/\r?\n/)) {
    const f = /^\+\+\+ b\/(.+)$/.exec(line);
    if (f) { cur = f[1]; if (!byFile.has(cur)) byFile.set(cur, []); continue; }
    if (/^\+\+\+ \/dev\/null$/.test(line)) { cur = null; continue; }   // file deleted
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && cur) {
      const start = +h[1], len = h[2] === undefined ? 1 : +h[2];
      if (len > 0) byFile.get(cur).push([start, start + len - 1]);
    }
  }
  return byFile;
}

function changedRanges(ref) {
  let out;
  try { out = git(diffArgs(ref)); }
  catch (e) {
    throw new Error("git diff " + (ref || "HEAD") + " failed — is this a git repo with at least " +
                    "one commit? (" + String(e.message).trim() + ")");
  }
  return parseDiff(out);
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

/* Argv, parsed and returned rather than consumed in place — so the flag interactions can be
 * asserted. `--files ui/x.js --ref HEAD~1` used to exit 2 with "no such file: HEAD~1", and no
 * test could have seen it while this lived inside main(). */
function parseArgv(argv) {
  const refI = argv.indexOf("--ref");
  /* --files takes every argument up to the NEXT FLAG, not every non-flag argument anywhere
   * after it. Filtering `--`-prefixed tokens out of the whole tail left the following flag's
   * VALUE behind, stranded where it read as a filename. */
  const filesI = argv.indexOf("--files");
  let explicit = null;
  if (filesI >= 0) {
    explicit = [];
    for (let i = filesI + 1; i < argv.length && !argv[i].startsWith("--"); i++) explicit.push(argv[i]);
  }
  return {
    json: argv.includes("--json"),
    all: argv.includes("--all"),
    strict: argv.includes("--strict"),
    ref: refI >= 0 ? argv[refI + 1] : null,
    explicit,
  };
}

/* The --strict gate, as a predicate: UNCOVERED only. See the note at the call site. */
const strictFailures = rows => rows.filter(r => r.level === "none");

function main(argv) {
  const opt = parseArgv(argv);
  const ref = opt.ref;
  const explicit = opt.explicit;

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
    scopeLabel = "changed since " + (ref || "HEAD") + " (staged and unstaged)";
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
  /* --strict gates on UNCOVERED only. Failing on MENTION-ONLY contradicted the contract this
   * file prints at the end of every run — "a lead to check by hand, not a verdict" — and,
   * combined with the deliberate self-reference in test_covgap.js, made --strict carry a
   * permanent red that no amount of writing tests could clear. A gate nobody can ever get to
   * green is a gate everyone learns to pass with --no-verify. */
  const uncovered = strictFailures(rows);
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

module.exports = { lex, topLevelFunctions, valueEnd, analyzeTest, indexTests, classify,
                   changedRanges, diffArgs, parseDiff, parseArgv, strictFailures,
                   sourceReaching, evaluated, overlaps, matchBrace };
if (typeof window !== "undefined") window.covgap = module.exports;

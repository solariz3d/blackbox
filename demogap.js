/* demogap.js — which assertions in this repo have ever been observed discriminating anything.
 *
 * WHY THIS EXISTS, and it is not the same question covgap answers. covgap answers REACHED:
 * which changed functions no test touches. A function can be reached by six tests that assert
 * nothing about it, and covgap says so in its own contract — "neither says the assertions are
 * worth anything". This answers the next question, DEMONSTRATED: has this assertion ever been
 * seen going red when the code it reads was perturbed?
 *
 * The prompt for it is a specific defect class, and one of them is in this repo's own suite.
 * `test_markfade.js:64` asserts
 *
 *     Math.abs(oldFrames * (1 / 30) - oldFrames * (1 / 90)) > 1
 *
 * with oldFrames a local `const 900`. That is a constant expression. It is true today, it was
 * true before the change it documents, and it will be true after any change to any shipped
 * source file — there is no edit to this repo that can make it fail. It reads as a guard, it
 * counts toward "44 tests pass", and it discriminates nothing. Two of its neighbours are the
 * same shape. Nobody wrote them carelessly; they were written to make a regression visible,
 * and the mirror they were written against drifted free of the source without anything saying
 * so out loud.
 *
 * WHAT IT DOES. Copies the repo to a temp dir (the working tree is never written to — a tool
 * that mutates source must not be able to leave yours mutated), hooks each test's own assertion
 * helper so every call site is recorded pass or fail, then runs the test four ways:
 *
 *   baseline   as-is. Establishes which call sites execute at all.
 *   empty leg  every file the test reads, emptied.
 *   full leg   those same files PLUS every string literal the test itself contains.
 *   mutants    one-point perturbations — a number, a comparison, an identifier, a deleted
 *              statement, a deleted function — placed inside the functions covgap says this
 *              test reaches.
 *
 * TWO REFERENT LEGS, PUSHED IN OPPOSITE DIRECTIONS, and this is the part that took a correction.
 * Emptying is not a neutral probe. It makes every assertion of ABSENCE pass for free, so the
 * first version of this file indicted `test_markfade.js:39` —
 * `ok(!/MARK_FADE_FRAMES/.test(SMOKE))` — which is a sound guard that fires the moment the
 * banned constant comes back. A probe that only pushes one way clears every guard pointing that
 * way while looking like it tested them. So the second leg pushes the other way, and an
 * indictment needs a guard to sit still through both extremes.
 *
 * WHAT THE CLASSES MEAN, EXACTLY. This is the whole contract and it is printed at the end of
 * every run, because a tool that grades checks and does not say what its grades mean is the
 * defect it is looking for, one level up.
 *
 *   DEMONSTRATED    observed going red under a one-point perturbation of code it reads. It
 *                   discriminates SOMETHING. It does NOT say it discriminates the right thing:
 *                   the mutant that fired it is named in the report so you can judge that.
 *   COARSE          never fired on a point mutant, but did fire in one of the two referent legs.
 *                   It depends on the source. Nothing we tried moved it short of demolition.
 *   INERT           ran in BOTH referent legs and passed both times. The strong finding: its
 *                   value survived the code it reads being emptied and being saturated, so it is
 *                   almost certainly not about that code. `test_markfade.js:64` is this. Two
 *                   samples at the extremes, not a proof — and both legs must have actually
 *                   REACHED the guard, since a leg that crashed first does not get a vote.
 *   UNDEMONSTRATED  ran green throughout, and the legs could not reach it (usually the test
 *                   crashed earlier once the source was gone). A FACT ABOUT THIS MUTANT SET,
 *                   not a verdict on the guard — a sound guard whose referent this tool cannot
 *                   perturb lands here too. A lead to look at, never a conviction.
 *   NOT-RUN         never executed in the baseline. Never green, never red, and it is not
 *                   counted as either — an unexecuted assertion is not a passing one.
 *   UNREADABLE      the file's assertion helper could not be hooked, OR hooking it changed the
 *                   test's own output. Those files' guards are not in these numbers at all and
 *                   the count is printed, never omitted.
 *
 * WHAT THE NUMBER DOES NOT MEAN. "n DEMONSTRATED" is not a quality score and must not be read
 * as one. A guard that fires when a number changes has been shown to notice A change; whether
 * it notices the change that matters is exactly the judgement no tool here can make. The
 * useful direction is the other one: INERT is the strongest thing here and still only two
 * samples, COARSE and UNDEMONSTRATED are leads ordered by strength, and DEMONSTRATED only means
 * the call site is wired to something real.
 *
 * MUTANTS THAT CRASH THE TEST ARE NOT DEMONSTRATIONS. Deleting a statement often makes the
 * test throw rather than fail. A throw fires no assertion, so it records nothing, and the
 * crashed count is reported so you can see how much of the budget bought nothing. This is the
 * same rule the room's scoring hygiene states for a different instrument: NOT-RUN is never a
 * green, and a red for the wrong reason is not a red.
 *
 * SCOPE. Default is the change, like covgap: assertion call sites inside lines this diff
 * touched in test_*.js. That is the question the tool is really for — a guard being added
 * right now, with no recorded run in which it fails. `--all` audits the suite and prints its
 * own scale.
 *
 * LIMITS, STATED.
 *   - It hooks a test's own `ok`/`check` helper by name and keys on that helper raising the
 *     file's `fails` counter. A test that asserts some other way is UNREADABLE, not covered.
 *     14 of this repo's 45 test files are UNREADABLE today for that reason.
 *   - The referent of a test is inferred: every local file it requires, plus the whole ui tree
 *     if it uses testenv's uiSource/uiFunction. Data it reads from samples/ is NOT perturbed,
 *     so a guard about replay content will read UNDEMONSTRATED and should.
 *   - Mutant sites are chosen deterministically (bit-reversed order, so every pick is a prefix
 *     of a larger one), which makes two runs of the same tree agree AND makes raising --budget
 *     able only to add demonstrations, never to remove one. Both are asserted in the tests
 *     rather than claimed here: the evenly spaced picker this replaced satisfied the first
 *     property and not the second.
 *   - A mutant is killed at ten times the baseline run of the same test, and the count of runs
 *     that hit that cap is printed. A hung mutant is not a demonstration and must not be able
 *     to hold an audit open for five minutes apiece.
 *
 * Run:
 *   node demogap.js                       guards added or changed since HEAD
 *   node demogap.js --ref HEAD~1
 *   node demogap.js --files test_markfade.js
 *   node demogap.js --all                 every hookable test file (slow — prints its scale)
 *   node demogap.js --budget 60           mutants per test file (default 30)
 *   node demogap.js --json
 *   node demogap.js --strict              exit 1 if anything in scope is INERT
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const cov = require("./covgap.js");

const ROOT = __dirname;

/* ------------------------------------------------------------------ *
 * 1. the working copy — the live tree is read, never written
 * ------------------------------------------------------------------ */

/* Mutation happens on a copy for one reason: a crash, a kill, or a bug in this file must not
 * be able to leave someone's working tree holding a mutated source. Measured at 0.8 s for this
 * repo, once per run, which is cheaper than one test file's worth of doubt. */
function workingCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demogap-"));
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return top !== ".git" && top !== "node_modules" && top !== "src-tauri" && top !== "target";
    },
  });
  return dir;
}

/* ------------------------------------------------------------------ *
 * 2. hooking a test's assertion helper
 * ------------------------------------------------------------------ */

const REC_NAME = ".demogap-rec.json";

/* The wrapper keys on the file's `fails` counter RISING, not on the truthiness of an argument.
 * Three helper shapes live in this suite and they do not agree on argument order —
 * `ok(cond,msg)`, `check(cond,msg)` and `check(name,ok,detail)` — so reading argument 0 would
 * silently invert one of them. Every one of them increments `fails`. The counter is the thing
 * they have in common, so the counter is what gets watched.
 *
 * The wrapper is emitted as ONE line, appended to the line the helper's definition ends on. A
 * newline anywhere in it shifts every call site below and the recorded line numbers stop
 * meaning anything in the original file — which is a defect that reports itself as data. */
function instrument(src, recPath) {
  const shapes = [
    /^(function\s+(ok|check)\s*\([^)]*\)\s*\{)/m,
    /^(const\s+(ok|check)\s*=\s*\([^)]*\)\s*=>\s*\{)/m,
  ];
  let name = null, out = null;
  for (const re of shapes) {
    const m = re.exec(src);
    if (!m) continue;
    name = m[2];
    out = src.replace(re, s => s.replace(name, "__dg0"));
    break;
  }
  if (!name) return null;

  const idx = out.indexOf("__dg0");
  let d = 0, end = -1;
  for (let i = out.indexOf("{", idx); i >= 0 && i < out.length; i++) {
    if (out[i] === "{") d++;
    else if (out[i] === "}") { d--; if (d === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;

  const w = `const __dgrec={};process.on("exit",()=>{try{require("fs").writeFileSync(${JSON.stringify(recPath)},JSON.stringify(__dgrec))}catch(e){}});` +
            `function ${name}(){const b=fails;const r=__dg0.apply(null,arguments);` +
            `const st=(new Error()).stack.split("\\n")[2]||"";const mm=/:(\\d+):\\d+\\)?\\s*$/.exec(st.trim());` +
            `const k=mm?mm[1]:"?";const e=__dgrec[k]||(__dgrec[k]={ran:0,fired:0});e.ran++;if(fails>b)e.fired++;return r;}`;

  let eol = out.indexOf("\n", end);
  if (eol < 0) eol = out.length;
  return out.slice(0, eol) + " " + w + out.slice(eol);
}

/* ------------------------------------------------------------------ *
 * 3. what a test reads — its referent
 * ------------------------------------------------------------------ */

/* Every local .js the test requires, plus the whole ui tree when it goes through testenv's
 * uiSource/uiFunction (those read every ui file, so any of them is fair game as a referent).
 *
 * Deliberately NOT the samples: a replay file is input data, not the code under test, and
 * emptying one would indict every guard that reads a recording for a property of this tool. */
/* Returned RANKED, because the budget has to be spent where the test actually looks. A test
 * that names `smokesim.js` and goes through uiFunction() has two direct referents and
 * twenty-four incidental ones; spreading mutants evenly over all twenty-six put almost none
 * on the two files the assertions are about, and the first run of this tool reported nothing
 * demonstrated in a file whose guards a hand-written mutant had already been seen to fire.
 *
 *   0  the test opens this file itself (require, or names it in a literal)
 *   1  it holds a function covgap says this test reaches
 *   2  it came in only with the uiSource() blanket */
function referentOf(dir, testFile) {
  const src = fs.readFileSync(path.join(dir, testFile), "utf8");
  const { literals } = cov.lex(src);
  const rank = new Map();
  const put = (rel, r) => { if (!rank.has(rel) || rank.get(rel) > r) rank.set(rel, r); };

  for (const lit of literals) {
    if (lit.kind !== "string" && lit.kind !== "template") continue;
    if (!/\brequire\s*\(\s*$/.test(lit.before)) continue;
    const t = lit.text.replace(/\\/g, "/");
    if (!/^\.\.?\//.test(t) || !/\.js$/.test(t)) continue;
    const rel = path.normalize(t).replace(/\\/g, "/").replace(/^\.\//, "");
    if (fs.existsSync(path.join(dir, rel))) put(rel, 0);
  }
  /* A test that reads a ui file directly rather than through testenv. Both spellings in this
   * repo are real and they arrive as different literals: `path.join(__dirname,"ui","smokesim.js")`
   * gives the bare name, `readFileSync("ui/thing.js")` gives the path. Handling only the first
   * is what this tool's own fixture caught — the second ranked 2, so the budget went to the
   * blanket instead of to the one file the test opens. */
  for (const lit of literals) {
    if (lit.kind === "comment") continue;
    const t = String(lit.text).replace(/\\/g, "/").replace(/^\.\//, "");
    if (/^[\w.-]+\.js$/.test(t) && fs.existsSync(path.join(dir, "ui", t))) put("ui/" + t, 0);
    else if (/^ui\/[\w.-]+\.js$/.test(t) && fs.existsSync(path.join(dir, t))) put(t, 0);
  }
  if (/\b(uiSource|uiFunction)\b/.test(src)) {
    const ui = path.join(dir, "ui");
    for (const f of fs.readdirSync(ui)) if (f.endsWith(".js")) put("ui/" + f, 2);
    put("ui/index.html", 2);
  }
  rank.delete("testenv.js");
  return [...rank].map(([rel, r]) => ({ rel, rank: r }));
}

/* The second perturbation, and the reason there are two.
 *
 * Emptying the referent is not a neutral change — it is a directional one, and it makes every
 * NEGATIVE assertion pass for free: `ok(!/MARK_FADE_FRAMES/.test(SMOKE))` is trivially true of
 * an empty file. The first version of this tool called `test_markfade.js:39` INERT on exactly
 * that basis. It is a sound guard, it fires the moment the banned constant comes back, and the
 * instrument indicted it because it only ever pushed in one direction.
 *
 * So the second leg pushes the other way: the source PLUS every literal the test itself
 * contains, appended as a comment-free block. Positive assertions still see the real source
 * and pass; negative ones now find the pattern they forbid and fire. A guard that sits still
 * through both the source vanishing and the source acquiring every string its own test knows
 * about is a much better candidate for inert than one that survived only the empty leg. */
function noiseFor(src, testSrc) {
  const { literals } = cov.lex(testSrc);
  const bits = [];
  for (const lit of literals) {
    if (lit.kind === "comment") continue;
    const t = String(lit.text);
    if (t.length && t.length < 200) bits.push(t);
  }
  /* Appended as a STRING LITERAL, not as raw text, and the reason is measured. Raw text turns
   * the file into a syntax error, so any test that `require`s its referent throws on load, no
   * assertion runs, and the leg votes on nothing — which silently withdraws the whole INERT
   * class from every test that imports rather than greps. A string literal keeps the file
   * loadable AND leaves the tokens where a lexical guard reading the shipped text will find
   * them; `decomment()` strips comments, not strings, so the tokens survive that too.
   *
   * The cost, stated: JSON escaping doubles backslashes, so a guard whose pattern is spelled
   * with them (`/markLoc\.fade,\s*\d/`) will not be matched by this leg and stays
   * UNDEMONSTRATED. Under-claiming, which is the direction to fail in. */
  return src + "\n/* demogap: saturated leg */\nvar __dg_saturate = " + JSON.stringify(bits.join("\n")) + ";\n";
}

/* ------------------------------------------------------------------ *
 * 4. mutation operators
 * ------------------------------------------------------------------ */

const FLIP = { "===": "!==", "!==": "===", "==": "!=", "!=": "==",
               "<=": ">", ">": "<=", ">=": "<", "<": ">=" };

/* Every site is a {start, end, text, why} replacement in ONE file. Sites are found in the
 * lexed code view only, so nothing here ever mutates a comment — a mutant inside a comment
 * changes nothing and would be scored as "no guard noticed", which is a lie about the guard. */
function sitesIn(src, spans) {
  const { code } = cov.lex(src);
  const out = [];
  const inSpan = (i) => !spans || !spans.length || spans.some(([a, b]) => i >= a && i <= b);

  let m;
  const num = /(?<![\w$.])(\d+\.\d+|\d+)(?![\w$.])/g;
  while ((m = num.exec(code))) {
    if (!inSpan(m.index)) continue;
    const v = parseFloat(m[1]);
    const to = m[1].includes(".") ? String(+(v * 2 + 1).toFixed(4)) : String(v + 1);
    out.push({ op: "num", start: m.index, end: m.index + m[1].length, text: to, why: `number ${m[1]}->${to}` });
  }
  const cmp = /===|!==|==|!=|<=|>=|<|>/g;
  while ((m = cmp.exec(code))) {
    if (!inSpan(m.index)) continue;
    // `=>` and `<<`/`>>` are not comparisons
    if (code[m.index + 1] === ">" && m[0] === "=") continue;
    if (m[0] === ">" && (code[m.index + 1] === ">" || code[m.index - 1] === "=" || code[m.index - 1] === ">")) continue;
    if (m[0] === "<" && (code[m.index + 1] === "<" || code[m.index - 1] === "<")) continue;
    out.push({ op: "cmp", start: m.index, end: m.index + m[0].length, text: FLIP[m[0]], why: `${m[0]} -> ${FLIP[m[0]]}` });
  }
  /* Renaming one occurrence of an identifier. The operator that reaches the guards no
   * in-body edit can move: a signature's parameter name, a uniform's name, the argument
   * spelled at a call site. Half of these break the file and the test throws — a throw fires
   * nothing and is counted as a crash, never as a demonstration. */
  const ident = /(?<![\w$.])([A-Za-z_$][\w$]{2,})(?![\w$])/g;
  const KEYWORD = new Set(["const", "let", "var", "function", "return", "for", "while", "if", "else",
                           "new", "this", "null", "true", "false", "undefined", "typeof", "break",
                           "continue", "case", "switch", "default", "throw", "try", "catch", "async",
                           "await", "class", "delete", "void", "instanceof", "module", "require"]);
  while ((m = ident.exec(code))) {
    if (!inSpan(m.index) || KEYWORD.has(m[1])) continue;
    out.push({ op: "ident", start: m.index, end: m.index + m[1].length, text: m[1] + "_x",
               why: `renamed ${m[1]} -> ${m[1]}_x (one occurrence)` });
  }
  // a whole statement line, blanked
  const lines = code.split("\n");
  let off = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 8 && t.endsWith(";") && !/^(const|let|var|import|module|window)\b/.test(t) && inSpan(off)) {
      out.push({ op: "del", start: off + (line.length - line.trimStart().length), end: off + line.length,
                 text: "", why: `deleted: ${t.slice(0, 46)}` });
    }
    off += line.length + 1;
  }
  return out;
}

/* Evenly through EACH operator class, not through the concatenated list. Identifier sites
 * outnumber comparison sites by two orders of magnitude in these files, so one flat pick
 * spends almost the whole budget on renames and never flips an operator. */
function pickBalanced(sites, n) {
  const byOp = new Map();
  for (const s of sites) { if (!byOp.has(s.op)) byOp.set(s.op, []); byOp.get(s.op).push(s); }
  const ops = [...byOp.keys()];
  if (!ops.length) return [];
  const per = Math.max(1, Math.floor(n / ops.length));
  const out = [];
  for (const op of ops) out.push(...pick(byOp.get(op), per));
  return out.slice(0, Math.max(n, ops.length));
}

/* Deleting a whole top-level function: the operator that reaches "is this thing findable at
 * all" guards, which no in-body edit can move. */
function fnDeletionSites(file, src) {
  return cov.topLevelFunctions(file).map(fn => {
    const lines = src.split("\n");
    let start = 0;
    for (let i = 0; i < fn.startLine - 1; i++) start += lines[i].length + 1;
    let end = start;
    for (let i = fn.startLine - 1; i < fn.endLine && i < lines.length; i++) end += lines[i].length + 1;
    return { start, end: Math.min(end, src.length), text: "", why: `deleted function ${fn.name}` };
  });
}

/* Never random: the same tree must give the same answer twice, so a result can be re-derived
 * instead of believed.
 *
 * NESTED, not evenly spaced, and the difference is a claim this file makes about itself. The
 * header says raising --budget can only add demonstrations and never remove one. With an evenly
 * spaced pick — `list[floor(i*len/n)]` — that is simply false: the sites chosen at 20 are not a
 * subset of those chosen at 40, so a guard demonstrated at the smaller budget can vanish at the
 * larger one, which makes the tool's own report unstable in the direction nobody would check.
 *
 * Ordering by bit-reversed index (van der Corput) gives a sequence that is spread at every
 * prefix AND nested by construction, so the first n is always a subset of the first m>n. The
 * claim in the header is now a property of the code, and `test_demogap.js` asserts it. */
function pick(list, n) {
  if (list.length <= n) return list;
  const rev = (x) => {
    let r = 0;
    for (let b = 0; b < 32; b++) { r = (r << 1) | (x & 1); x >>>= 1; }
    return r >>> 0;
  };
  return list.map((_, i) => i).sort((a, b) => rev(a) - rev(b) || a - b)
             .slice(0, n).sort((a, b) => a - b).map(i => list[i]);
}

/* ------------------------------------------------------------------ *
 * 5. running one test file, three ways
 * ------------------------------------------------------------------ */

/* The per-run timeout is DERIVED from the baseline, not a flat number.
 *
 * It used to be a flat 300 s, which is not a timeout so much as a promise never to finish: a
 * mutant that makes a test spin gets five minutes, and an --all run over a suite containing one
 * test that itself spawns processes ran past twenty-five minutes with no way to tell churning
 * from hung. A mutant that takes ten times the baseline is not doing useful work — the baseline
 * is the same test on the same machine, so it is the only honest scale. */
const runBudgetMs = (baselineMs) => Math.max(5000, Math.round(baselineMs * 10));

function runOnce(dir, file, instrumented, timeoutMs) {
  const recPath = path.join(dir, REC_NAME);
  try { fs.unlinkSync(recPath); } catch {}
  const target = instrumented ? ".demogap-run.js" : file;
  let out = "", code = 0;
  const t0 = Date.now();
  try {
    /* stderr piped, not inherited: a mutant that makes the test throw would otherwise dump a
     * stack trace into this tool's own report, which reads as demogap crashing. */
    out = execFileSync("node", [path.join(dir, target)],
                       { encoding: "utf8", cwd: dir, timeout: timeoutMs || 300000,
                         stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status === undefined ? -1 : e.status;
    out = (e.stdout || "") + (e.stderr || "");
  }
  let rec = {};
  if (instrumented) { try { rec = JSON.parse(fs.readFileSync(recPath, "utf8")); } catch {} }
  return { code, out, rec, ms: Date.now() - t0 };
}

/* Hooking a test and then measuring the hooked thing is only honest if the hook changed
 * nothing. The instrumented run must produce byte-identical output and the same exit code as
 * the untouched file; anything else and the file is reported UNREADABLE rather than measured.
 * A tool that quietly measures a test it has altered is the failure it exists to find. */
function prepare(dir, file) {
  const src = fs.readFileSync(path.join(dir, file), "utf8");
  const inst = instrument(src, path.join(dir, REC_NAME));
  if (!inst) return { unreadable: "no hookable ok()/check() helper" };
  fs.writeFileSync(path.join(dir, ".demogap-run.js"), inst);
  const plain = runOnce(dir, file, false);
  const hooked = runOnce(dir, file, true);
  if (plain.code !== hooked.code || plain.out !== hooked.out) {
    return { unreadable: `hooking changed the test's own behaviour (exit ${plain.code} -> ${hooked.code})` };
  }
  if (plain.code !== 0) return { unreadable: `baseline is not green (exit ${plain.code})` };
  if (!Object.keys(hooked.rec).length) return { unreadable: "hooked, but no call site recorded" };
  return { baseline: hooked.rec, src, baselineMs: Math.max(plain.ms, hooked.ms) };
}

function withEdits(dir, edits, fn) {
  const saved = edits.map(([rel]) => [rel, fs.readFileSync(path.join(dir, rel), "utf8")]);
  try {
    for (const [rel, content] of edits) fs.writeFileSync(path.join(dir, rel), content);
    return fn();
  } finally {
    for (const [rel, content] of saved) fs.writeFileSync(path.join(dir, rel), content);
  }
}

/* ------------------------------------------------------------------ *
 * 6. measuring one test file
 * ------------------------------------------------------------------ */

function measure(dir, file, budget) {
  const prep = prepare(dir, file);
  if (prep.unreadable) return { file, unreadable: prep.unreadable };

  const guards = {};
  for (const [line, g] of Object.entries(prep.baseline)) {
    guards[line] = { line: +line, ran: g.ran, fired: g.fired, state: "UNDEMONSTRATED", by: null };
  }

  const referent = referentOf(dir, file);
  const jsRef = referent.filter(r => r.rel.endsWith(".js"));
  let crashed = 0, ran = 0, timedOut = 0;
  const cap = runBudgetMs(prep.baselineMs);
  const runIt = () => runOnce(dir, file, true, cap);

  /* THE TWO REFERENT LEGS, pushed in opposite directions. Neither alone is evidence of inert:
   * empty makes every negative assertion pass, saturated makes every positive one pass. */
  const legs = {};
  if (referent.length) {
    const empty = withEdits(dir, referent.map(r => [r.rel, ""]), runIt);
    ran++;
    legs.empty = empty.rec;
    const noiseEdits = referent.map(r => {
      const src = fs.readFileSync(path.join(dir, r.rel), "utf8");
      return [r.rel, noiseFor(src, prep.src)];
    });
    const noisy = withEdits(dir, noiseEdits, runIt);
    ran++;
    legs.noise = noisy.rec;

    for (const line of Object.keys(guards)) {
      const e = legs.empty[line], n = legs.noise[line];
      if ((e && e.fired) || (n && n.fired)) {
        guards[line].state = "COARSE";
        guards[line].by = e && e.fired ? "fired with its referent emptied" : "fired with its referent saturated";
      } else if (e && e.ran && !e.fired && n && n.ran && !n.fired) {
        /* Both legs RAN it and neither moved it. Requiring both is what keeps a sound negative
         * assertion out of this class, and it is conservative in the right direction: a leg
         * that crashed before reaching the guard proves nothing, so it does not get to vote. */
        guards[line].state = "INERT";
        guards[line].by = "passed with its referent emptied AND saturated";
      }
    }
  }

  /* the mutant leg — one point change at a time, spent where this test actually looks */
  const tests = [cov.analyzeTest(file, prep.src)];
  const perFile = [];
  for (const { rel, rank } of jsRef) {
    const abs = path.join(dir, rel);
    const src = fs.readFileSync(abs, "utf8");
    let spans = [];
    try {
      const lines = src.split("\n");
      const at = (ln) => lines.slice(0, ln - 1).reduce((a, l) => a + l.length + 1, 0);
      for (const fn of cov.topLevelFunctions(abs)) {
        const c = cov.classify(fn, tests);
        if (c.level === "exec" || c.level === "pin") spans.push([at(fn.startLine), at(fn.endLine + 1)]);
      }
    } catch { spans = []; }
    const sites = [...sitesIn(src, spans.length ? spans : null),
                   ...fnDeletionSites(abs, src).map(s => ({ op: "fn", ...s }))];
    // a file only pulled in by the uiSource() blanket, with nothing reached in it, is rank 2
    perFile.push({ rel, src, rank: spans.length ? Math.min(rank, 1) : rank, sites });
  }

  /* 60/25/15 across the three ranks, unspent share carried down. The exact split is a
   * judgement, not a measurement; what it is FOR is measured — evenly spreading the budget
   * over a 26-file referent put almost no mutants on the two files the test names. */
  const chosen = [];
  let purse = budget;
  for (const [r, share] of [[0, 0.6], [1, 0.25], [2, 0.15]]) {
    const group = perFile.filter(f => f.rank === r && f.sites.length);
    if (!group.length) continue;
    const isLast = r === 2 || !perFile.some(f => f.rank > r && f.sites.length);
    const allot = isLast ? purse : Math.min(purse, Math.round(budget * share));
    const per = Math.max(1, Math.floor(allot / group.length));
    for (const f of group) for (const s of pickBalanced(f.sites, per)) chosen.push({ rel: f.rel, src: f.src, ...s });
    purse = Math.max(0, purse - allot);
  }

  /* The budget is a real cap, not a target the allocation drifts past. Rank order is already
   * baked into `chosen`, so truncating spends what is left on the files the test names and
   * drops the incidental tail — which is the right thing to lose. */
  chosen.length = Math.min(chosen.length, budget);

  for (const s of chosen) {
    const mutated = s.src.slice(0, s.start) + s.text + s.src.slice(s.end);
    const r = withEdits(dir, [[s.rel, mutated]], runIt);
    ran++;
    let anyFired = false;
    for (const [line, g] of Object.entries(r.rec)) {
      if (!guards[line] || !g.fired) continue;
      anyFired = true;
      if (guards[line].state !== "DEMONSTRATED") {
        guards[line].state = "DEMONSTRATED";
        guards[line].by = `${s.rel}: ${s.why}`;
      }
    }
    if (r.ms >= cap) timedOut++;
    if (!anyFired && r.code !== 0) crashed++;
  }

  for (const g of Object.values(guards)) if (!g.ran) g.state = "NOT-RUN";
  return { file, referent: referent.map(r => r.rel),
           guards: Object.values(guards).sort((a, b) => a.line - b.line),
           mutants: chosen.length, crashed, timedOut, capMs: cap, runs: ran };
}

/* ------------------------------------------------------------------ *
 * 7. scope
 * ------------------------------------------------------------------ */

function changedTestLines(ref) {
  let out;
  try {
    out = execFileSync("git", ["-C", ROOT, ...cov.diffArgs(ref)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error("git diff " + (ref || "HEAD") + " failed — is this a git repo with at least one commit? (" +
                    String(e.message).trim() + ")");
  }
  let untracked = "";
  try {
    untracked = execFileSync("git", ["-C", ROOT, "ls-files", "--others", "--exclude-standard"],
                             { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch { untracked = ""; }
  return buildScope(out, untracked);
}

/* Pure, and split out for the reason covgap's own header gives: for a shell-out, the way to
 * make the behaviour testable is to separate the parse from the call.
 *
 * UNTRACKED TEST FILES COUNT, and leaving them out made the default scope useless for the very
 * case this tool exists for. `git diff` cannot see a file git has never seen, so a brand new
 * test — the one with no recorded run in which it fails, exactly what the trigger is about —
 * reported "no test files in scope", which reads precisely like a clean bill. This tool's own
 * test file was untracked when it printed that. Whole file, not a range: every line of a new
 * file is new. */
function buildScope(diffOut, untrackedOut) {
  const scope = new Map();
  for (const [rel, ranges] of cov.parseDiff(diffOut)) {
    if (/^test_[\w.-]+\.js$/.test(rel)) scope.set(rel, ranges);
  }
  for (const line of String(untrackedOut || "").split(/\r?\n/)) {
    const rel = line.trim();
    if (/^test_[\w.-]+\.js$/.test(rel)) scope.set(rel, null);
  }
  return scope;
}

function parseArgv(argv) {
  const refI = argv.indexOf("--ref");
  const budI = argv.indexOf("--budget");
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
    budget: budI >= 0 ? Math.max(1, parseInt(argv[budI + 1], 10) || 30) : 30,
    explicit,
  };
}

const inRanges = (line, ranges) => !ranges || ranges.some(([a, b]) => line >= a && line <= b);

/* ------------------------------------------------------------------ *
 * 8. report
 * ------------------------------------------------------------------ */

const CONTRACT = [
  "DEMONSTRATED   seen going red under a one-point change to code it reads. It discriminates",
  "               SOMETHING; whether it discriminates the RIGHT thing is not measured here —",
  "               the mutant that fired it is printed so you can judge that yourself.",
  "COARSE         only fired when its referent was emptied entirely. It reads the source; no",
  "               realistic change we tried moved it.",
  "INERT          ran with its referent emptied and passed. Its value does not depend on the",
  "               shipped source at all. This is the one close to a proof.",
  "UNDEMONSTRATED ran green throughout and the blank leg could not reach it. A fact about THIS",
  "               mutant set, not a verdict: a sound guard we cannot perturb lands here too.",
  "NOT-RUN        never executed in the baseline. Not counted as passing.",
  "UNREADABLE     helper not hookable, or hooking changed the test's output. Not in the numbers.",
];

const RANK = { INERT: 0, COARSE: 1, UNDEMONSTRATED: 2, "NOT-RUN": 3, DEMONSTRATED: 4 };

function main(argv) {
  const opt = parseArgv(argv);
  let scope;                                   // Map<testfile, ranges|null>
  let scopeLabel;
  if (opt.all) {
    scopeLabel = "every hookable test file in the repo";
    scope = new Map(fs.readdirSync(ROOT).filter(f => /^test_.*\.js$/.test(f)).sort().map(f => [f, null]));
  } else if (opt.explicit && opt.explicit.length) {
    scopeLabel = "files: " + opt.explicit.join(", ");
    scope = new Map(opt.explicit.map(f => [f, null]));
  } else {
    scopeLabel = "assertions changed since " + (opt.ref || "HEAD") + " (staged and unstaged)";
    scope = changedTestLines(opt.ref);
  }

  if (!scope.size) {
    console.log("demogap — " + scopeLabel);
    console.log("\n  no test files in scope.");
    console.log("  (a change that touches only ui/ is invisible here — this tool is about the guards,");
    console.log("   not the code. `node covgap.js` is the one that reads a ui change.)");
    process.exit(0);
  }

  const dir = workingCopy();
  /* An --all run is minutes long and gets interrupted, and `finally` does not run on a signal —
   * the first two interrupted runs each left a 50 MB copy of the repo in the temp directory.
   * Cleaning on the signals we can see is not complete (SIGKILL is not catchable) but it covers
   * ctrl-C and a terminated background job, which is how this actually gets stopped. */
  const sweep = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => { sweep(); process.exit(130); });
  const results = [];
  try {
    /* Progress on stderr, so --json stdout stays machine-readable. An --all run over this suite
     * is minutes long and the report only exists at the end; a silent tool that takes fifteen
     * minutes is one people kill at ten and assume is broken. */
    const files = [...scope.keys()];
    files.forEach((file, i) => {
      process.stderr.write(`  [${i + 1}/${files.length}] ${file}\r`);
      if (!fs.existsSync(path.join(dir, file))) { results.push({ file, unreadable: "no such test file" }); return; }
      results.push(measure(dir, file, opt.budget));
    });
    process.stderr.write(" ".repeat(60) + "\r");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // filter each file's guards to the lines actually in scope
  for (const r of results) {
    if (!r.guards) continue;
    r.guards = r.guards.filter(g => inRanges(g.line, scope.get(r.file)));
  }

  if (opt.json) {
    console.log(JSON.stringify({ scope: scopeLabel, contract: CONTRACT, budget: opt.budget, files: results }, null, 2));
  } else {
    print(results, scopeLabel, opt);
  }

  const inert = results.flatMap(r => (r.guards || []).filter(g => g.state === "INERT"));
  process.exit(opt.strict && inert.length ? 1 : 0);
}

function print(results, scopeLabel, opt) {
  const lines = new Map();
  const textOf = (file, line) => {
    if (!lines.has(file)) {
      try { lines.set(file, fs.readFileSync(path.join(ROOT, file), "utf8").split("\n")); }
      catch { lines.set(file, []); }
    }
    return (lines.get(file)[line - 1] || "").trim();
  };

  console.log("demogap — " + scopeLabel);
  console.log("  (" + opt.budget + " mutants per file, chosen deterministically; the working tree is never written to)\n");

  const tally = { DEMONSTRATED: 0, COARSE: 0, INERT: 0, UNDEMONSTRATED: 0, "NOT-RUN": 0 };
  const unreadable = [];
  for (const r of results) {
    if (r.unreadable) { unreadable.push(r); continue; }
    if (!r.guards.length) continue;
    console.log("  " + r.file + "   " + r.mutants + " mutants" +
                (r.crashed ? `, ${r.crashed} crashed the test (bought nothing)` : "") +
                (r.timedOut ? `, ${r.timedOut} killed at the ${(r.capMs / 1000).toFixed(1)}s cap` : ""));
    const sorted = [...r.guards].sort((a, b) => (RANK[a.state] - RANK[b.state]) || (a.line - b.line));
    for (const g of sorted) {
      tally[g.state]++;
      const head = "    " + g.state.padEnd(15) + (r.file + ":" + g.line).padEnd(30);
      if (g.state === "DEMONSTRATED") console.log(head + "by " + g.by);
      else console.log(head + textOf(r.file, g.line).slice(0, 76));
    }
    console.log("");
  }

  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log("  " + Object.entries(tally).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(" · ") +
              `   of ${total} guards in scope`);
  if (unreadable.length) {
    console.log(`\n  ${unreadable.length} file(s) UNREADABLE — their guards are in no number above:`);
    for (const u of unreadable) console.log("    " + u.file.padEnd(28) + u.unreadable);
  }
  if (tally.INERT) {
    console.log("\n  INERT is the finding, and here is its exact strength: those assertions ran with the");
    console.log("  code they read emptied out AND with it saturated, and did not move either time. That");
    console.log("  is two samples, not a proof — but they are the two extremes, and a guard that sits");
    console.log("  still through both is almost certainly not about the source. Read the line.");
  }
  console.log("\n  " + CONTRACT.join("\n  "));
  if (opt.all) console.log("\n  (--all: an audit of the suite, not a report about any change)");
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { instrument, referentOf, noiseFor, sitesIn, fnDeletionSites, pick, pickBalanced,
                   parseArgv, changedTestLines, buildScope, inRanges, measure, workingCopy,
                   runBudgetMs, FLIP, CONTRACT, RANK };

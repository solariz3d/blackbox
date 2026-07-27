/* test_covgap.js — the discriminations covgap.js is only worth having if it gets right.
 *
 * WHY THIS EXISTS. covgap exists because a change to drawCarLights and wheelSteerModel shipped
 * a defect under a fully green suite. A tool that answers "is this change covered" is worse
 * than nothing if its answer is wrong, and there is exactly one way for it to be wrong in the
 * expensive direction: calling something covered that is not. So the assertions below are
 * weighted that way. Under-claiming is a missed opportunity; over-claiming is the failure the
 * tool was built to prevent, committed by the tool itself.
 *
 * THE CENTRAL HAZARD, both ways. This repo has been bitten four times by lexical checks that
 * cannot tell using a name from mentioning it. covgap has to cut it in BOTH directions and the
 * two halves pull against each other:
 *
 *   a name in a comment that EXPLAINS the function      -> not coverage    (the classic trap)
 *   a name in a string, as uiFunction("name")           -> IS coverage     (the reverse trap)
 *
 * A naive strip-the-strings fix gets the first right and the second catastrophically wrong —
 * every mirror-anchored test in the repo would read as no coverage at all. Both directions are
 * pinned below, and both are pinned against the REAL repo as well as synthetic input, because
 * a synthetic fixture can be made to agree with a wrong rule.
 *
 * Two of these assertions caught real defects during development and are kept as regressions:
 *   - batchGlow was reported `exec` because its test used `new Function` SOMEWHERE in the file.
 *     A file-level flag is not evidence about a particular function. (over-claim)
 *   - pathRadius/turbineGate were reported mention-only although test_turbinegate genuinely
 *     runs them through vm.runInContext, via a local helper that is not uiFunction. (miss)
 *
 * Run: node test_covgap.js
 */
"use strict";
const C = require("./covgap.js");

let fails = 0;
function ok(cond, msg) { if (!cond) { console.log("  FAIL " + msg); fails++; } }

/* A synthetic ui function, so classify() can be asked about a name under our control. */
const fn = (name, file) => ({ name, file: file || "ui/fake.js", startLine: 1, endLine: 9 });
const level = (name, testSrc, opts) =>
  C.classify(fn(name, opts && opts.file), [C.analyzeTest("test_fake.js", testSrc)]).level;

/* ---------- 1. the scanner: where a byte actually lives ---------- */

console.log("the scanner separates code from everything that only looks like it");
{
  const { code } = C.lex(`const a = 1; // drawCarLights\nconst b = 2;`);
  ok(!/drawCarLights/.test(code), "a name in a line comment is not in code position");
  ok(/const b = 2;/.test(code), "and the code after it survives");

  const blk = C.lex(`/* drawCarLights is the bug */\nlet x = 1;`);
  ok(!/drawCarLights/.test(blk.code), "nor in a block comment");

  const str = C.lex(`const s = "drawCarLights";`);
  ok(!/drawCarLights/.test(str.code), "a name inside a string is not in code position either");
  ok(str.literals.some(l => l.kind === "string" && l.text === "drawCarLights"),
     "but the string is captured as a literal, so a rule can still act on it");
}

console.log("line numbers survive blanking — a report that points at the wrong line is noise");
{
  const src = `/* one\n   two\n   three */\nfunction f() {}\n`;
  const { code } = C.lex(src);
  ok(code.length === src.length, "the code view is the same length as the source");
  ok(code.split("\n").length === src.split("\n").length, "and has the same number of lines");
  ok(/^function f/m.test(code), "the declaration after a multi-line comment is still at column 0");
}

console.log("regex literals vs division — the classic place a hand-rolled scanner dies");
{
  const re = C.lex(`const m = /drawCarLights/.test(s);`);
  ok(!/drawCarLights/.test(re.code), "a name inside a regex literal is not code");
  ok(re.literals.some(l => l.kind === "regex"), "it is recorded as a regex literal");

  const div = C.lex(`const r = total / count; const q = a / b;`);
  ok(/total \/ count/.test(div.code), "division is left alone, not swallowed as a regex");
  ok(!div.literals.some(l => l.kind === "regex"), "and no phantom regex literal is produced");

  // a slash after a close-paren is division; after `(` or `=` it opens a regex
  const mixed = C.lex(`f(a) / 2; g(/x/);`);
  ok(/f\(a\) \/ 2/.test(mixed.code), "slash after ) is division");
  ok(mixed.literals.some(l => l.kind === "regex" && l.text === "x"), "slash after ( is a regex");

  const cls = C.lex(`const m = /[/]a/.test(s);`);
  ok(cls.literals.some(l => l.kind === "regex"), "a / inside a character class does not end the regex");
}

console.log("template literals — body inert, ${} hole live");
{
  const t = C.lex("const s = `name is ${drawCarLights(x)} here`;");
  ok(/drawCarLights\(x\)/.test(t.code), "code inside a ${} hole stays code");
  ok(!/name is/.test(t.code), "the literal text around it does not");
}

console.log("boundary conditions");
{
  ok(C.lex("").code === "", "empty source");
  ok(C.lex("const s = 'unterminated").code.length === "const s = 'unterminated".length,
     "an unterminated string does not lose or gain bytes");
  ok(C.lex("//").code === "  ", "a bare comment marker");
  ok(C.matchBrace("{}", 0) === 2, "matchBrace on an empty body");
  ok(C.matchBrace("{ { } }", 0) === 7, "matchBrace nests");
  ok(C.matchBrace("{ unclosed", 0) === 10, "an unclosed body ends at EOF rather than throwing");
}

/* ---------- 2. using vs mentioning, in both directions ---------- */

console.log("a mention is not coverage — the trap this repo has hit four times");
{
  ok(level("drawCarLights", `// drawCarLights was converted to pooled staging\nconst x = 1;`)
     === "mention", "a name in a comment explaining it is MENTION, not coverage");

  ok(level("drawCarLights", `ok(true, "drawCarLights should be fast");`)
     === "mention", "a name in an assertion MESSAGE is a mention — the message is not the test");

  ok(level("batchGlow", `const src = "";\nconst y = 2;`)
     === "none", "a name that appears nowhere is UNCOVERED");
}

console.log("a name in a string CAN be coverage — the reverse trap a strip-strings fix breaks");
{
  ok(level("batchGlow", `const { uiFunction } = require("./testenv.js");\nconst b = uiFunction("batchGlow");`)
     === "pin", "uiFunction(\"name\") is a source anchor, not a mention");

  ok(level("drawTrackLampGlare", `const i = src.indexOf("function drawTrackLampGlare");`)
     === "pin", "locating \"function name\" in the shipped source is a source anchor");

  ok(level("drawThruster", `ok(/function\\s+drawThruster/.test(src), "present");`)
     === "pin", "and so is a regex that matches the declaration");
}

console.log("execution outranks anchoring, and the two are never merged");
{
  ok(level("cullLights", `const TL = require("./ui/fake.js");\nTL.cullLights([], [0,0,0], 4);`)
     === "exec", "requiring the defining module and naming it is execution");

  ok(level("cullLights", `const TL = require("./ui/other.js");\nTL.cullLights([], [], 4);`)
     === "mention", "requiring a DIFFERENT module is not evidence about this one");

  ok(level("wheelSteerModel", `const src = uiFunction("wheelSteerModel");\n` +
                              `const make = new Function("mMul", src + "; return wheelSteerModel;");`)
     === "exec", "rebuilding the real source into a callable is execution, not a mirror");

  ok(level("pathRadius", `vm.runInContext(consts + grab("pathRadius"), sandbox);\nsandbox.pathRadius(p, 200);`)
     === "exec", "and so is evaluating it into a vm sandbox — even via a local extract helper");
}

console.log("the over-claim that a file-level flag caused — kept as a regression");
{
  /* The first version set one `evaluatesSource` flag per FILE, so any test that called
   * new Function anywhere promoted every function it merely regexed to `exec`. That is the
   * tool committing the exact error it exists to catch. The call context must be the
   * evaluator, not the file. */
  const src = `const b = uiFunction("batchGlow");\n` +
              `ok(/drawArrays/.test(b));\n` +
              `const make = new Function("mMul", other + "; return wheelSteerModel;");`;
  ok(level("batchGlow", src) === "pin",
     "a function that is only regexed stays pinned even when the file evaluates something else");
  ok(level("wheelSteerModel", src) === "exec",
     "while the one actually built into a callable is exec — same file, different answers");
}

/* ---------- 3. scope arithmetic ---------- */

console.log("a function is in scope when the change touches any of its lines");
{
  const f = { startLine: 10, endLine: 20 };
  ok(C.overlaps(f, [[10, 10]]) === true, "first line touched");
  ok(C.overlaps(f, [[20, 20]]) === true, "last line touched");
  ok(C.overlaps(f, [[15, 15]]) === true, "a line in the middle");
  ok(C.overlaps(f, [[1, 9]]) === false, "a hunk entirely above it is out of scope");
  ok(C.overlaps(f, [[21, 40]]) === false, "and one entirely below");
  ok(C.overlaps(f, [[5, 30]]) === true, "a hunk that spans it");
  ok(C.overlaps(f, []) === false, "no hunks, no scope");
}

/* ---------- 4. declaration finding ---------- */

console.log("top-level declarations only — the same contract testenv.uiFunction has");
{
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covgap-"));
  const file = path.join(dir, "sample.js");
  fs.writeFileSync(file, [
    "function outer() {",
    "  function inner() { return 1; }",
    "  return inner();",
    "}",
    "/* function ghost() {} */",
    "const arrowOne = (a) => a + 1;",
    "const arrowBlock = (a) => {",
    "  return a;",
    "};",
    "function last() {}",
  ].join("\n"));
  const found = C.topLevelFunctions(file).map(f => f.name);
  ok(found.includes("outer"), "a top-level function is found");
  ok(!found.includes("inner"), "a nested one is NOT — stated limit, asserted rather than assumed");
  ok(!found.includes("ghost"), "a declaration inside a comment is not a declaration");
  ok(found.includes("arrowOne") && found.includes("arrowBlock"), "both arrow-const forms are found");
  ok(found.includes("last"), "and the scan reaches the end of the file");

  const blockFn = C.topLevelFunctions(file).find(f => f.name === "arrowBlock");
  ok(blockFn.startLine === 7 && blockFn.endLine === 9, "an arrow with a block body spans its braces");
  const oneFn = C.topLevelFunctions(file).find(f => f.name === "arrowOne");
  ok(oneFn.startLine === 6 && oneFn.endLine === 6, "an expression-bodied arrow is one line");
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- 5. against the real repo, where a wrong rule cannot be talked into agreeing ---------- */

console.log("the real repo — every class present, each one checked against what the test does");
{
  const tests = C.indexTests();
  const at = (name, file) => C.classify(fn(name, file), tests).level;

  // MENTION-ONLY: test_glowpool names drawCarLights only in its header comment, explaining the
  // incident. This is the exact pair that motivated the tool, and it must not read as covered.
  ok(at("drawCarLights", "ui/lightfx.js") === "mention",
     "drawCarLights is named in a test comment and reached by nothing — still uncovered");
  ok(at("pushGlow", "ui/lightfx.js") === "mention",
     "pushGlow likewise: discussed in prose, exercised by nothing");

  // pinned: uiFunction + regex, no execution
  ok(at("batchGlow", "ui/lightfx.js") === "pin",
     "batchGlow is anchored to its source text by test_glowpool but never run");
  ok(at("drawTrackLampGlare", "ui/lightfx.js") === "pin",
     "drawTrackLampGlare is anchored by test_lampglare's mirror");

  // exec via require
  ok(at("driverSeatedPose", "ui/carrender.js") === "exec",
     "driverSeatedPose is imported and called by test_gripreach");
  ok(at("mMulInto", "ui/mathutil.js") === "exec",
     "mMulInto is imported and called by test_glowpool");

  // exec via source evaluation — the miss that this test now pins
  ok(at("wheelSteerModel", "ui/carrender.js") === "exec",
     "wheelSteerModel is rebuilt with new Function and called — execution, not a mirror");
  ok(at("turbineGate", "ui/lightfx.js") === "exec",
     "turbineGate is evaluated into a vm sandbox by test_turbinegate and called there");

  /* And that UNCOVERED is genuinely reachable on this repo — asserted as a property, not
   * against a named function, for two reasons. It stays true as tests get written, and more
   * to the point: writing a live function name here would create a mention of it IN THIS
   * FILE, which the tool then indexes, permanently downgrading that function from UNCOVERED
   * to MENTION-ONLY. The first draft did exactly that and this assertion caught it. */
  const fs = require("fs"), path = require("path");
  const all = [];
  for (const f of fs.readdirSync(path.join(__dirname, "ui")).filter(x => x.endsWith(".js")))
    for (const g of C.topLevelFunctions(path.join(__dirname, "ui", f))) all.push(g);
  const byLevel = { none: 0, mention: 0, pin: 0, exec: 0 };
  for (const g of all) byLevel[C.classify(g, tests).level]++;
  ok(all.length > 100, "the repo really does have a lot of top-level ui functions: " + all.length);
  ok(byLevel.none > 0, "some are named by no test at all — UNCOVERED is reachable");
  ok(byLevel.exec > 0, "some are genuinely executed — the tool is not simply calling everything uncovered");
  ok(byLevel.none < all.length,
     `the classes discriminate: ${byLevel.none} none / ${byLevel.mention} mention / ` +
     `${byLevel.pin} pin / ${byLevel.exec} exec`);
}

console.log("the tool does not report a function as covered by a test that merely shares a word");
{
  const tests = C.indexTests();
  // `push` is a local helper in test_glowpool AND a common identifier; a ui function of that
  // name must not inherit coverage from an unrelated local of the same name.
  ok(C.classify(fn("push", "ui/nonexistent.js"), tests).level !== "exec",
     "a name colliding with a test's own local is never reported as executed");
}

console.log(fails ? `test_covgap: ${fails} FAILED` : "test_covgap: all pass");
process.exit(fails ? 1 : 0);

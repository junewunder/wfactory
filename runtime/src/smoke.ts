// smoke.sh: the install's smoke test, a toy factory of five small units worked by one lane.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initCli } from "./init.ts";
import { profileProblems } from "./profile.ts";
import { shq } from "./sys.ts";

export const HELP = `smoke.sh — the install's smoke test: a toy factory of five small units,
each with a real mechanical check, worked by one lane until they're done.

It scaffolds the toy with init.sh (so the profile must be complete), writes
its spec, its oracle (a test script per unit, committed before any unit is
worked) and its units, then runs \`just loop\` on this machine: one fresh
agent session per unit. A unit is done only when its test passes; nobody
marks it. At the end it prints \`just status\`. \`just view\` in the toy's
folder opens the tracker's page.

This runs real agent sessions, with the permissions the loop gives them
(\`--permission-mode auto\`), inside the toy's folder. Five small units cost
a few minutes and a little usage.

Usage:
  scripts/smoke.sh [<dir>]     the toy goes in <dir> (default ~/wfactory-smoke);
                               refuses if it exists

Environment: SMOKE_MODEL (the model for the sessions, default sonnet),
SMOKE_HOURS (the lane's time budget, default 1).`;

const SPEC = `# The smoke-test factory

A toy that checks the factory works on this machine. Delete it afterwards.

## Goal

Five tiny shell functions, one per unit, each in \`src/<name>.sh\`.

**Worth the tokens because:** it proves the loop, the oracle and the tracker
work here before a real factory spends anything.

## The unit

One function: write \`src/<name>.sh\` so that \`bash tests/<name>.sh\` passes.
The test says what the function must do. One unit is a few minutes.

**How "done" is decided:** computed. Each unit's probe is its test.
**Inputs it may read:** \`tests/\`.
**What it produces, and where:** \`src/<name>.sh\`, committed.

## The oracle

- **\`just check\` runs:** every test whose \`src/\` file exists, then
  \`just rebuildable\`.
- **Beyond \`just check\`:** nothing.
- **Known noise:** none.
- **Lanes share \`work/\`:** it never looks at \`work/\`.

**Independent check:** mechanical.

**Never make the oracle pass by changing the oracle.** \`tests/\` is the
oracle: never edit it. A test that looks wrong is a question (\`just ask\`).

## What must never be lost

- **Written, so in git:** \`src/\` and \`tests/\`.
- **Derived, so rebuilt:** nothing.
- **\`just rebuildable\`** lists untracked files in \`src/\` and \`tests/\`.

## Done and stopping

- **The factory is done when:** every unit is done.
- **Stop and report when:** a unit fails its test twice in a row.

## The loop

1. **Orient.** \`just status\`.
2. **Pick and claim.** The loop has already done this.
4. **Do** the unit: write \`src/<name>.sh\`, defining the function the test
   sources and calls.
5. **Check.** \`bash tests/<name>.sh\`, then \`just check\`.
6. **Record.** Computed: the loop runs the probe. Add a note only if the
   next attempt needs it.
7. **Commit:** \`git add src/<name>.sh && git commit -m "<id>: <what>" -- src/<name>.sh\`.
8. **Stop** after this one unit.

## Resources

- **Memory:** nothing heavy.
- **CPU:** nothing heavy.
- **Shared resources:** none.
- **Display, devices, shared state:** none.
- **GUI:** none.
- **Tidy:** nothing.
- **Long jobs:** none.
`;

const JUSTFILE = `set dotenv-load

import 'factory/factory.just'

# The oracle: the test of every function written so far, then rebuildable.
check:
    #!/usr/bin/env bash
    set -u; rc=0
    for s in src/*.sh; do [ -e "$s" ] || continue; n=$(basename "$s" .sh); bash "tests/$n.sh" || rc=1; done
    just rebuildable || rc=1
    exit $rc

# Files with no copy in git: untracked files in src/ and tests/.
rebuildable:
    #!/usr/bin/env bash
    left=$(git ls-files --others --exclude-standard -- src tests)
    [ -z "$left" ] || { echo "not in git: $left"; exit 1; }
`;

// The oracle for one unit: a test script that sources src/<name>.sh and checks each call's output.
function oracle(name: string, cases: [string, string][]) {
  const lines = [
    `# The oracle for ${name}: don't edit. src/${name}.sh defines the function.`,
    `set -u; . "$(dirname "$0")/../src/${name}.sh" || exit 1; fail=0`,
    ...cases.map(([call, want]) => `got=$(${call}); [ "$got" = ${shq(want)} ] || { echo "FAIL: ${call} gave \\"$got\\", wanted ${shq(want)}"; fail=1; }`),
    "exit $fail",
  ];
  fs.writeFileSync(`tests/${name}.sh`, lines.join("\n") + "\n");
}

const UNITS: [string, string, [string, string][]][] = [
  ["reverse", "Reverse a string", [["reverse hello", "olleh"], ['reverse "a b"', "b a"], ['reverse ""', ""]]],
  ["vowels", "Count the vowels in a word", [["vowels banana", "3"], ["vowels rhythm", "0"], ["vowels AEIOU", "5"]]],
  ["fizzbuzz", "FizzBuzz for one number", [["fizzbuzz 3", "Fizz"], ["fizzbuzz 10", "Buzz"], ["fizzbuzz 15", "FizzBuzz"], ["fizzbuzz 7", "7"]]],
  ["palindrome", "Tell whether a phrase is a palindrome", [["palindrome racecar", "yes"], ['palindrome "Never odd or even"', "yes"], ["palindrome banana", "no"]]],
  ["words", "Count the words in a line", [['words "one two  three"', "3"], ['words ""', "0"], ['words "  x  "', "1"]]],
];

// A command in the toy's folder; false (it said why) if it failed.
function run(argv: string[], quiet = false): boolean {
  const r = spawnSync(argv[0], argv.slice(1), { stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"] });
  return r.status === 0;
}

export function smokeCli(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  if (args[0] === "-h" || args[0] === "--help") { console.log(HELP); return 0; }
  const dir = path.resolve(args[0] ?? path.join(env.HOME ?? os.homedir(), "wfactory-smoke"));
  if (fs.existsSync(dir)) { console.error(`smoke: ${dir} already exists; remove it or name another folder`); return 2; }
  const problems = profileProblems(env);
  if (problems.length) { for (const l of problems) console.error(l); return 2; }

  // init.sh's report isn't for the smoke test's reader.
  const out = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let c: number;
  try { c = initCli([path.basename(dir), "--dir", path.dirname(dir)], env); } finally { process.stdout.write = out; }
  if (c !== 0) return c;
  process.chdir(dir);
  env.PWD = dir;

  // ---- the spec, and the oracle: one test per unit, written first
  fs.writeFileSync("docs/factory.md", SPEC);
  fs.mkdirSync("src", { recursive: true });
  fs.mkdirSync("tests", { recursive: true });
  for (const [name, , cases] of UNITS) oracle(name, cases);
  fs.writeFileSync("justfile", JUSTFILE);
  if (!run(["git", "add", "-A"]) || !run(["git", "commit", "-qm", "Smoke-test factory: spec, oracle, recipes"])) return 1;

  // ---- the units: the toy has no opening (its oracle is written above), so its gate is passed
  if (!run(["factory/tracker", "pass", "opening/ready"], true)) return 1;
  if (!run(["factory/tracker", "add-group", "toy", "--title", "Toy shell functions"], true)) return 1;
  for (const [name, title] of UNITS) {
    if (!run(["factory/tracker", "add-unit", `toy/${name}`, "--title", title, "--probe-cmd", `bash tests/${name}.sh`, "--inputs", `src/${name}.sh,tests/${name}.sh`], true)) return 1;
  }
  if (!run(["git", "add", "-A"]) || !run(["git", "commit", "-qm", "Smoke-test factory: five units"])) return 1;

  console.log(`smoke: the toy factory is in ${dir}; running one lane until its units are done`);
  run(["just", "loop", "--model", env.SMOKE_MODEL || "sonnet", "--hours", env.SMOKE_HOURS || "1", "--max", "10"]);
  console.log();
  run(["just", "status"]);
  console.log();
  console.log(`smoke: \`cd ${dir} && just view\` opens the tracker's page; \`just runs\` lists each session's turns and cost.`);
  return 0;
}

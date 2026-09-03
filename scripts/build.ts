/**
 * One-command top-level build for the whole repo, with a Maven-style reactor
 * log: modules run in order, each prints its goals, and a summary table at the
 * end says what passed, what failed, and what never ran.
 *
 *   bun run scripts/build.ts [--docker] [--skip-tests] [-pl <module,...>]
 *
 * The two backends have no build step — they ship as source and run under Bun —
 * so their modules exist to run the checks that would otherwise never run at
 * all: the zero-dependency constraint and the regression suite in `tests/`.
 * That makes this script the only thing standing between a broken
 * `server-core.ts` and production. Don't "optimise" the backend modules away.
 *
 * A failed build leaves any previously built `sites/*\/dist/` in place; not
 * deploying after a red build is the operator's call, not this script's.
 * Deployment is Ansible (`deploy/deploy.yml`) and stays a separate step.
 *
 * Dev-only tooling: nothing here is deployed.
 */

const VERSION = "0.1.0";
const GROUP = "dev.stubbase";
const WIDTH = 72;

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(
    [
      "Usage: bun run scripts/build.ts [options]",
      "",
      "  --docker          build the frontends in `docker` mode (*.localhost URLs)",
      "  --skip-tests      skip the test goals (they still show as SKIPPED)",
      "  -pl <modules>     build only these modules (comma-separated)",
      "  -h, --help        show this message",
      "",
      "Modules: core, dashboard-api, landing, dashboard",
    ].join("\n"),
  );
  process.exit(0);
}

const DOCKER = args.has("--docker");
const SKIP_TESTS = args.has("--skip-tests");

const plFlag = process.argv.indexOf("-pl");
const only =
  plFlag !== -1 && process.argv[plFlag + 1]
    ? new Set(process.argv[plFlag + 1].split(",").map((s) => s.trim()))
    : null;

const COLOR = Bun.enableANSIColors && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);

const info = (line = "") => console.log(`[INFO] ${line}`);
const error = (line = "") => console.log(`${paint("31", "[ERROR]")} ${line}`);
const rule = () => info("-".repeat(WIDTH));

/** `--------< dev.stubbase:stubbase-core >--------`, centred and padded to WIDTH. */
function banner(text: string, fill: string) {
  const pad = WIDTH - text.length;
  const left = Math.max(0, Math.floor(pad / 2));
  const right = Math.max(0, pad - left);
  info(`${fill.repeat(left)}${text}${fill.repeat(right)}`);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

/** Local time with UTC offset, the way Maven stamps the end of a build. */
function finishedAt(date: Date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

type Goal = {
  /** Maven-ish `plugin:goal (execution-id)` label. */
  label: string;
  run: () => Promise<GoalResult>;
};

type GoalResult = { ok: boolean; skipped?: boolean; reason?: string; hint?: string };

type Module = {
  id: string;
  artifact: string;
  packaging: string;
  dir: string;
  goals: Goal[];
};

/** Line-buffers a child stream so the [INFO] prefix never splits mid-line. */
async function pump(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`[INFO] ${line}\n`);
  }
  if (buffer.length > 0) process.stdout.write(`[INFO] ${buffer}\n`);
}

/** Runs a child process, streaming its output indented under [INFO]. */
async function exec(cmd: string[], cwd: string, hint: string): Promise<GoalResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, FORCE_COLOR: COLOR ? "1" : "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  return code === 0
    ? { ok: true }
    : { ok: false, reason: `${cmd[0]} exited with code ${code}`, hint };
}

/**
 * The backends must stay at zero npm dependencies (they run straight off Bun's
 * stdlib on a 1GB VPS). Nothing else enforces this — a stray `bun add` would
 * otherwise only surface as a missing module in production.
 */
async function verifyZeroDeps(dir: string): Promise<GoalResult> {
  const manifest = await Bun.file(`${dir}/package.json`).json();
  const found = ["dependencies", "devDependencies", "peerDependencies"].filter(
    (field) => manifest[field] && Object.keys(manifest[field]).length > 0,
  );
  if (found.length > 0) {
    return {
      ok: false,
      reason: `${dir}/package.json declares ${found.join(", ")} — the backends must stay dependency-free`,
      hint: `remove the dependency, or reconsider: CLAUDE.md makes this a hard constraint`,
    };
  }
  info(`no npm dependencies declared — OK`);
  return { ok: true };
}

/**
 * Per-module slice of the top-level `tests/` suite. Missing suites report
 * SKIPPED rather than failing, so this script works before the tests exist;
 * `bun test` itself exits 1 when it matches no files.
 */
function testGoal(file: string): Goal {
  return {
    label: `test:bun (default-test) @ ${file}`,
    run: async () => {
      if (SKIP_TESTS) return { ok: true, skipped: true, reason: "--skip-tests" };
      if (!(await Bun.file(`${import.meta.dir}/../${file}`).exists()))
        return { ok: true, skipped: true, reason: `${file} not present` };
      return exec(["bun", "test", file], `${import.meta.dir}/..`, `bun test ${file}`);
    },
  };
}

const root = `${import.meta.dir}/..`;
const buildScript = DOCKER ? "build:docker" : "build";

const modules: Module[] = [
  {
    id: "core",
    artifact: "stubbase-core",
    packaging: "bun",
    dir: `${root}/apps/core`,
    goals: [
      {
        label: "deps:verify (zero-dependency-check) @ stubbase-core",
        run: () => verifyZeroDeps(`${root}/apps/core`),
      },
      testGoal("tests/core.test.ts"),
    ],
  },
  {
    id: "dashboard-api",
    artifact: "stubbase-dashboard-api",
    packaging: "bun",
    dir: `${root}/apps/dashboard-api`,
    goals: [
      {
        label: "deps:verify (zero-dependency-check) @ stubbase-dashboard-api",
        run: () => verifyZeroDeps(`${root}/apps/dashboard-api`),
      },
      testGoal("tests/dashboard-api.test.ts"),
      testGoal("tests/dashboard-api.auth.test.ts"),
    ],
  },
  {
    id: "landing",
    artifact: "stubbase-landing",
    packaging: "astro",
    dir: `${root}/sites/landing`,
    goals: [
      {
        label: `build:astro (${buildScript}) @ stubbase-landing`,
        run: () =>
          exec(
            ["bun", "run", buildScript],
            `${root}/sites/landing`,
            `cd sites/landing && bun run ${buildScript}`,
          ),
      },
    ],
  },
  {
    id: "dashboard",
    artifact: "stubbase-dashboard",
    packaging: "vite",
    dir: `${root}/sites/dashboard`,
    goals: [
      {
        // `bun run build` is `tsc -b && vite build`, so the typecheck rides along.
        label: `build:vite (${buildScript}) @ stubbase-dashboard`,
        run: () =>
          exec(
            ["bun", "run", buildScript],
            `${root}/sites/dashboard`,
            `cd sites/dashboard && bun run ${buildScript}`,
          ),
      },
      // Checks the starter examples this SPA ships against a real core, so a
      // card cannot advertise a query its seed data does not answer.
      testGoal("tests/starters.test.ts"),
    ],
  },
];

const reactor = only ? modules.filter((m) => only.has(m.id)) : modules;

if (reactor.length === 0) {
  error(`-pl matched no modules (known: ${modules.map((m) => m.id).join(", ")})`);
  process.exit(1);
}

// ── Reactor ────────────────────────────────────────────────────────────────

type Outcome = { module: Module; status: "SUCCESS" | "FAILURE" | "SKIPPED"; ms: number };

const started = Date.now();
const outcomes: Outcome[] = [];
let failure: { module: Module; goal: string; reason: string; hint?: string } | null = null;

info("Scanning for projects...");
rule();
info("Reactor Build Order:");
info();
const artifactWidth = Math.max(...reactor.map((m) => m.artifact.length));
for (const m of reactor)
  info(`${m.artifact.padEnd(artifactWidth + 2)}[${m.packaging}]`);
info();
if (DOCKER) info(`Frontend build mode: ${yellow("docker")} (*.localhost URLs)`);
if (SKIP_TESTS) info(`Test goals: ${yellow("SKIPPED")} (--skip-tests)`);
if (DOCKER || SKIP_TESTS) info();

for (const [index, module] of reactor.entries()) {
  if (failure) {
    outcomes.push({ module, status: "SKIPPED", ms: 0 });
    continue;
  }

  rule();
  banner(`< ${GROUP}:${module.artifact} >`, "-");
  const counter = `[${index + 1}/${reactor.length}]`;
  info(`Building ${module.artifact} ${VERSION}`.padEnd(WIDTH - counter.length) + counter);
  banner(`[ ${module.packaging} ]`, "-");

  const moduleStart = Date.now();
  let status: Outcome["status"] = "SUCCESS";

  for (const goal of module.goals) {
    info();
    info(`--- ${goal.label} ---`);
    const result = await goal.run();

    if (result.skipped) {
      info(`Skipped: ${result.reason}`);
      continue;
    }
    if (!result.ok) {
      status = "FAILURE";
      failure = {
        module,
        goal: goal.label,
        reason: result.reason ?? "goal failed",
        hint: result.hint,
      };
      break;
    }
  }

  outcomes.push({ module, status, ms: Date.now() - moduleStart });
  info();
}

// ── Summary ────────────────────────────────────────────────────────────────

rule();
info(`Reactor Summary for stubbase ${VERSION}:`);
info();

const dotWidth = artifactWidth + 8;
for (const { module, status, ms } of outcomes) {
  const dots = ".".repeat(Math.max(3, dotWidth - module.artifact.length));
  const timing = status === "SKIPPED" ? "" : ` [${seconds(ms).padStart(9)}]`;
  const label =
    status === "SUCCESS" ? green(status) : status === "FAILURE" ? red(status) : yellow(status);
  info(`${module.artifact} ${dots} ${label}${timing}`);
}

rule();
info(failure ? red("BUILD FAILURE") : green("BUILD SUCCESS"));
rule();
info(`Total time:  ${seconds(Date.now() - started)}`);
info(`Finished at: ${finishedAt(new Date())}`);
rule();

if (failure) {
  error(`Failed to execute goal ${failure.goal}`);
  error(`  ${failure.reason}`);
  if (failure.hint) {
    error();
    error(`Re-run just this goal with:`);
    error(`  ${failure.hint}`);
  }
  process.exit(1);
}

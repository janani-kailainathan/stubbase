/**
 * One-command local dev stack: both Bun backends (hot-reloading via --watch)
 * plus both frontend dev servers, with interleaved prefixed output and a single
 * Ctrl-C teardown.
 *
 *   bun run scripts/dev.ts [--reseed]
 *
 * This file owns the dev ports. The cross-link URLs the frontends bake in are
 * committed in each site's `.env.development` and must match the constants
 * below — ports are checked up front so a busy port fails loudly instead of
 * silently moving a dev server and breaking those links.
 *
 * Dev-only tooling: nothing here is deployed. Production runs the same two
 * entrypoints under systemd, and the local production-shaped stack is
 * `docker compose up --build` (see BUILD.md).
 */
import { seedPublicTenant } from "./seed-public-tenant.ts";

const CORE_PORT = 3000;
const APP_PORT = 3001;
const DASHBOARD_PORT = 5173;
const LANDING_PORT = 4321;

// One source of truth for both backends: a mismatch silently breaks admin auth
// and the per-tenant JWT keys derived from it.
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "dev";

const COLOR = Bun.enableANSIColors && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint("2", s);

type Service = {
  name: string;
  color: string;
  port: number;
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
};

const services: Service[] = [
  {
    name: "core",
    color: "36", // cyan
    port: CORE_PORT,
    cmd: ["bun", "--watch", "run", "server-core.ts"],
    cwd: "apps/core",
    env: {
      PORT: String(CORE_PORT),
      ADMIN_SECRET,
      TENANTS_DIR: "../../tenants",
      // Same wiring as docker-compose: usage counters flush to the dashboard
      // API, which owns the SQLite file.
      USAGE_SINK_URL: `http://127.0.0.1:${APP_PORT}/_internal/usage`,
    },
  },
  {
    name: "app",
    color: "35", // magenta
    port: APP_PORT,
    cmd: ["bun", "--watch", "run", "server-app.ts"],
    cwd: "apps/dashboard-api",
    env: {
      PORT: String(APP_PORT),
      ADMIN_SECRET,
      CORE_API_URL: `http://127.0.0.1:${CORE_PORT}`,
      DB_PATH: "../../app.sqlite",
      // The SPA is same-origin through the Vite proxy, so CORS is unused here;
      // allow-list the dev server anyway for direct-from-browser testing.
      ALLOWED_ORIGINS: `http://localhost:${DASHBOARD_PORT}`,
      // So displayed endpoints (and the ones the AI Co-Pilot quotes) are URLs
      // that actually resolve on this machine.
      PUBLIC_API_BASE: `http://localhost:${CORE_PORT}`,
      // OAuth sign-in bounces the browser back here when it finishes. The
      // callback base points at the *Vite proxy* rather than this service, so
      // the whole flow stays on one origin and a provider console needs a
      // single dev redirect URI. DASHBOARD_GOOGLE_* / DASHBOARD_GITHUB_*
      // credentials ride in from the repo-root .env; without them the login
      // page simply shows no provider buttons.
      DASHBOARD_URL: `http://localhost:${DASHBOARD_PORT}`,
      OAUTH_CALLBACK_BASE: `http://localhost:${DASHBOARD_PORT}/api/app`,
    },
  },
  {
    name: "dashboard",
    color: "32", // green
    port: DASHBOARD_PORT,
    cmd: ["bunx", "vite", "--port", String(DASHBOARD_PORT), "--strictPort"],
    cwd: "sites/dashboard",
  },
  {
    name: "landing",
    color: "33", // yellow
    port: LANDING_PORT,
    cmd: ["bunx", "astro", "dev", "--port", String(LANDING_PORT)],
    cwd: "sites/landing",
    // Astro 7 daemonizes itself when it detects an agentic environment, which
    // would orphan the server and trip the fail-fast below. This flag is how
    // Astro marks a dev server that already has a supervising parent — which is
    // exactly what this script is — so it stays in the foreground either way.
    env: { ASTRO_DEV_BACKGROUND: "1" },
  },
];

const width = Math.max(...services.map((s) => s.name.length));
const tag = (s: Service) => paint(s.color, `[${s.name.padEnd(width)}]`);

/**
 * Probes by connecting, not by binding: BSD lets a 127.0.0.1 bind succeed while
 * something else holds the same port on a wildcard address, so a bind test
 * reports "free" for a port the dev servers can't actually own.
 */
async function portInUse(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

const inUse = await Promise.all(services.map((s) => portInUse(s.port)));
const busy = services.filter((_, i) => inUse[i]);
if (busy.length > 0) {
  console.error(
    `[dev] port${busy.length > 1 ? "s" : ""} already in use: ` +
      busy.map((s) => `${s.port} (${s.name})`).join(", ") +
      "\n[dev] stop the other process — the committed sites/*/.env.development " +
      "cross-links assume these exact ports.",
  );
  process.exit(1);
}

if (await seedPublicTenant(process.argv.includes("--reseed"))) {
  console.log(dim("[dev] seeded the `public` demo tenant (tenants/public)"));
}

/** Line-buffers a child stream so prefixes never split mid-line. */
async function pump(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`${prefix} ${line}\n`);
  }
  if (buffer.length > 0) process.stdout.write(`${prefix} ${buffer}\n`);
}

let stopping = false;

const children = services.map((service) => {
  const proc = Bun.spawn(service.cmd, {
    cwd: service.cwd,
    // Inherits the shell env plus the repo-root .env Bun loaded for this
    // process — that's how GOOGLE_AI_API_KEY reaches the dashboard API.
    env: { ...process.env, ...service.env, FORCE_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  void pump(proc.stdout, tag(service));
  void pump(proc.stderr, tag(service));

  // A dev server that exits on its own means something is actually broken
  // (--watch and Vite both survive crashes), so take the rest down with it.
  void proc.exited.then((code) => {
    if (stopping) return;
    console.error(`\n[dev] ${service.name} exited (code ${code}) — stopping the stack`);
    void shutdown(1);
  });

  return proc;
});

async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  const timeout = new Promise((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([Promise.all(children.map((c) => c.exited)), timeout]);
  for (const child of children) child.kill("SIGKILL");
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

console.log(
  [
    "",
    `  dashboard   http://localhost:${DASHBOARD_PORT}   ${dim("← start here")}`,
    `  landing     http://localhost:${LANDING_PORT}`,
    `  core API    http://127.0.0.1:${CORE_PORT}        ${dim("try /public/users/1")}`,
    `  app API     http://127.0.0.1:${APP_PORT}`,
    "",
    dim(`  ADMIN_SECRET=${ADMIN_SECRET} · data in ./tenants and ./app.sqlite · Ctrl-C to stop`),
    "",
  ].join("\n"),
);

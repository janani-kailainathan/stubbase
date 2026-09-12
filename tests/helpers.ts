/**
 * Shared harness for the black-box backend suites.
 *
 * Both backends are spawned as real processes against scratch state and driven
 * over HTTP — no test imports server internals, so refactors don't break the
 * suites. Not a test file itself: the name is outside bun test's glob on
 * purpose.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const ADMIN_SECRET = "test-admin-secret";
export const adminAuth = { authorization: `Bearer ${ADMIN_SECRET}` };

const APPS = join(import.meta.dir, "../apps");

export interface Service {
  /** http://127.0.0.1:<port> */
  base: string;
  /** Scratch state this instance owns (tenants dir for core, db dir for app). */
  dir: string;
  proc: Bun.Subprocess;
  /** Everything the service has written to stdout, as it arrives. */
  output: string[];
}

/** Drains a child stream forever so a full pipe can never block the server. */
async function drain(stream: ReadableStream<Uint8Array>, sink?: string[]) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (sink) sink.push(text);
  }
}

/**
 * Boots a backend on an OS-assigned port. PORT=0 lets the kernel choose and
 * the real port is read back from the service's own startup line, so there is
 * no "find a free port and hope nothing takes it" race.
 */
async function spawnService(
  label: string,
  cwd: string,
  entry: string,
  dir: string,
  env: Record<string, string>,
): Promise<Service> {
  const proc = Bun.spawn(["bun", "run", entry], {
    cwd,
    env: { ...process.env, PORT: "0", ADMIN_SECRET, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const logs: string[] = [];
  void drain(proc.stderr as ReadableStream<Uint8Array>, logs);

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let port = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const match = buffered.match(/listening on :(\d+)/);
    if (match) {
      port = Number(match[1]);
      break;
    }
  }
  reader.releaseLock();
  const output = [buffered];
  void drain(proc.stdout as ReadableStream<Uint8Array>, output);

  if (!port)
    throw new Error(`${label} never reported a port.\nstdout: ${buffered}\nstderr: ${logs.join("")}`);

  return { base: `http://127.0.0.1:${port}`, dir, proc, output };
}

/** Core Tenant Engine against a scratch TENANTS_DIR. */
export async function startCore(
  root: string,
  name: string,
  env: Record<string, string> = {},
): Promise<Service> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return spawnService(`core "${name}"`, join(APPS, "core"), "server-core.ts", dir, {
    TENANTS_DIR: dir,
    ...env,
  });
}

/**
 * Dashboard API against a scratch SQLite file.
 *
 * The repo-root .env is auto-loaded into this process, so anything a developer
 * keeps there would otherwise reach the service under test. Two families are
 * cleared explicitly: AI, so a real key can never turn a test run into a billed
 * provider call, and the dashboard's OAuth credentials, so whether a suite sees
 * Google and GitHub sign-in configured is decided by the test rather than by
 * whose machine it runs on.
 */
export async function startApp(
  root: string,
  name: string,
  env: Record<string, string> = {},
): Promise<Service> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return spawnService(`app "${name}"`, join(APPS, "dashboard-api"), "server-app.ts", dir, {
    DB_PATH: join(dir, "app.sqlite"),
    GOOGLE_AI_API_KEY: "",
    DASHBOARD_GOOGLE_CLIENT_ID: "",
    DASHBOARD_GOOGLE_SECRET: "",
    DASHBOARD_GITHUB_CLIENT_ID: "",
    DASHBOARD_GITHUB_SECRET: "",
    ...env,
  });
}

export async function stopServices(services: Service[]): Promise<void> {
  for (const s of services) s.proc.kill();
  await Promise.all(services.map((s) => s.proc.exited));
}

/**
 * Where the core keeps a file addressed by name, exactly as its `_admin/files`
 * plane resolves it: config and its draft in system/, everything else in data/.
 */
export const tenantFilePath = (core: Service, tenant: string, name: string) =>
  join(
    core.dir,
    tenant,
    name === "config" || name === "draft_config" ? "system" : "data",
    `${name}.json`,
  );

/** A feature-owned system file (users, reset-password) — unreachable by name through the files plane. */
export const systemFilePath = (core: Service, tenant: string, name: string) =>
  join(core.dir, tenant, "system", `${name}.json`);

/**
 * Writes a tenant folder straight to disk — exercises the core's lazy-load path.
 * Names resolve like `tenantFilePath`; feature files go through `seedSystemFile`.
 */
export async function seedTenant(core: Service, tenant: string, files: Record<string, unknown>) {
  await mkdir(join(core.dir, tenant), { recursive: true });
  for (const [name, contents] of Object.entries(files))
    await Bun.write(tenantFilePath(core, tenant, name), JSON.stringify(contents, null, 2));
}

export async function seedSystemFile(core: Service, tenant: string, name: string, rows: unknown[]) {
  await Bun.write(systemFilePath(core, tenant, name), JSON.stringify(rows, null, 2));
}

/** Writes a tenant's system/status.json, as the Start/Stop button would. */
export async function seedStatus(core: Service, tenant: string, status: string) {
  await Bun.write(systemFilePath(core, tenant, "status"), JSON.stringify({ status }, null, 2));
}

export const tenantFile = (core: Service, tenant: string, name: string) =>
  Bun.file(tenantFilePath(core, tenant, name)).json();

export const systemFile = (core: Service, tenant: string, name: string) =>
  Bun.file(systemFilePath(core, tenant, name)).json();

export async function waitFor(condition: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

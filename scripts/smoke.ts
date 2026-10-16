/**
 * Runs an app the way Hata installs it and waits for its web page to answer.
 *
 *   bun scripts/smoke.ts <app> [<app> …] [--keep]
 *
 * Run from the store's folder on a machine with Docker. Each app gets a folder of its own under
 * /var/tmp/hata-smoke: a data folder, the app's folder inside it owned by 1000:1000 as Hata makes it,
 * an `.env` with Hata's variables and every setting filled (a free port, a made-up secret), then
 * `docker compose up -d`. Afterwards the app is taken down with its volumes and the folder removed,
 * unless --keep. Images stay: `docker image prune -a` is yours.
 */
import { chownSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { bindMounts, fill, isObject, mountKind, type Obj, services, splitVolume } from "./lib.ts";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const ids = args.filter((a) => !a.startsWith("--"));
if (!ids.length) throw new Error("usage: bun scripts/smoke.ts <app> [<app> …] [--keep]");

const WAIT_MS = 6 * 60_000;

const free = (port: number) =>
  new Promise<boolean>((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, () => s.close(() => done(true)));
  });

async function freePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p++) if (await free(p)) return p;
  throw new Error(`no free port from ${from}`);
}

function secret(length: number, kind?: string): string {
  const chars = kind === "hex" ? "0123456789abcdef" : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => chars[b % chars.length]).join("");
}

function compose(dir: string, project: string, ...cmd: string[]) {
  return Bun.spawnSync(["docker", "compose", "-p", project, ...cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" });
}

/** The host port a service publishes its container port at, with the .env filled in */
function hostPort(def: Obj, target: number, env: Record<string, string>): number {
  if (def.network_mode === "host") return target;
  for (const p of Array.isArray(def.ports) ? def.ports : []) {
    if (typeof p === "string" || typeof p === "number") {
      const parts = splitVolume(fill(String(p), env).split("/")[0]!);
      if (Number(parts.at(-1)) === target && parts.length > 1) return Number(parts.at(-2));
    } else if (isObject(p) && Number(p.target) === target) return Number(fill(String(p.published), env));
  }
  throw new Error(`port ${target} is not published`);
}

/** The user a service runs as, by number, from the compose file or the image; null — root, or unknown */
function imageUser(def: Obj, env: Record<string, string>): { uid: number; gid: number } | null {
  const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const given = def.user != null ? fill(String(def.user), env) : run(["docker", "image", "inspect", "-f", "{{.Config.User}}", String(def.image)]);
  if (!given) return null;
  const [u = "", g = ""] = given.split(":");
  const file = (path: string) => {
    const id = run(["docker", "create", "--entrypoint", "/nonexistent", String(def.image)]);
    if (!id) return "";
    const text = run(["sh", "-c", `docker cp ${id}:${path} - 2>/dev/null | tar -xO 2>/dev/null`]);
    run(["docker", "rm", "-f", id]);
    return text;
  };
  const field = (text: string, name: string, n: number) => text.split("\n").map((l) => l.split(":")).find((p) => p[0] === name)?.[n];
  const passwd = /^\d+$/.test(u) ? "" : file("/etc/passwd");
  const uid = /^\d+$/.test(u) ? Number(u) : Number(field(passwd, u, 2) ?? NaN);
  if (!Number.isInteger(uid) || uid === 0) return null;
  const gid = /^\d+$/.test(g) ? Number(g) : g ? Number(field(file("/etc/group"), g, 2) ?? uid) : Number(field(passwd, u, 3) ?? uid);
  return { uid, gid: Number.isInteger(gid) ? gid : uid };
}

async function smoke(id: string): Promise<boolean> {
  const source = join(ROOT, "apps", id);
  const hata = Bun.YAML.parse(readFileSync(join(source, "hata.yml"), "utf8")) as Obj;
  const file = Bun.YAML.parse(readFileSync(join(source, "compose.yml"), "utf8")) as Obj;
  // an app for an NVIDIA card cannot start where there is none: said, and not counted as a failure
  const gpu = Object.values(services(file)).some((d) => d.runtime === "nvidia" || JSON.stringify(d.deploy ?? {}).includes('"nvidia"'));
  if (gpu && !existsSync("/dev/nvidiactl")) {
    console.log(`== ${id}: needs an NVIDIA card, not started here`);
    return true;
  }
  const base = join("/var/tmp/hata-smoke", id);
  rmSync(base, { recursive: true, force: true });
  const dataRoot = join(base, "data");
  const appDir = join(base, "app");
  const appData = join(dataRoot, "AppData", id);
  mkdirSync(appDir, { recursive: true });
  mkdirSync(appData, { recursive: true });
  chownSync(appData, 1000, 1000);
  // the compose file and the app's other files, as Hata puts them in the app's folder
  cpSync(source, appDir, { recursive: true, filter: (from) => !/\/(hata\.yml|screenshots)$/.test(from) });

  const env: Record<string, string> = { APP_DATA: appData, PUID: "1000", PGID: "1000", TZ: "Europe/Kyiv" };
  const known = { ...env, DATA_ROOT: dataRoot };
  for (const s of hata.settings ?? []) {
    // what the person would type: a password made up, a required field without a default filled
    if (s.type === "secret" || s.type === "password") env[s.name] = secret(s.length ?? 32, s.chars);
    else if (s.type === "port") env[s.name] = String(await freePort(Number(s.default ?? 8000)));
    else if (s.default !== undefined) env[s.name] = fill(String(s.default), known);
    else if (s.required) env[s.name] = "smoke";
  }
  if (hata.web) {
    const port = hostPort(services(file)[hata.web.service]!, hata.web.port, env);
    env.APP_HOST = "127.0.0.1";
    env.APP_URL = `${hata.web.scheme ?? "http"}://127.0.0.1:${port}`;
  }
  writeFileSync(join(appDir, ".env"), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""));

  const project = `smoke-${id}`;
  // as Hata does it: the devices this machine has not are left out by an override, read with the
  // variables filled in (a device the person chooses is a setting)
  const gone: string[] = [];
  const kept: string[] = [];
  for (const [name, def] of Object.entries(services(file))) {
    if (!Array.isArray(def.devices)) continue;
    const devices = def.devices.map((d: unknown) => (typeof d === "string" ? fill(d, env) : isObject(d) ? { ...d, source: fill(String(d.source ?? ""), env) } : d));
    const host = (d: unknown) => (typeof d === "string" ? d.split(":")[0]! : isObject(d) ? String(d.source ?? "") : "");
    const missing = devices.filter((d: unknown) => host(d).startsWith("/") && !existsSync(host(d)));
    if (!missing.length) continue;
    gone.push(...missing.map(host));
    kept.push(`  ${JSON.stringify(name)}:\n    devices: !override ${JSON.stringify(devices.filter((d: unknown) => !missing.includes(d)))}`);
  }
  if (kept.length) {
    writeFileSync(join(appDir, "compose.override.yml"), `services:\n${kept.join("\n")}\n`);
    console.log(`   left out, not on this machine: ${gone.join(", ")}`);
  }
  console.log(`== ${id}: pull`);
  const pulled = compose(appDir, project, "pull", "-q");
  if (pulled.exitCode !== 0) console.log(pulled.stderr.toString().trim());

  // the folders Hata makes for the app before the first start: the user apps run as, or the one the
  // service's image runs as when it has its own
  const folders = (hata.settings ?? []).filter((s: Obj) => s.type === "folder").map((s: Obj) => s.name);
  for (const m of bindMounts(file)) {
    if (mountKind(m, folders) !== "own" || /^[./]/.test(m.source)) continue;
    const path = fill(m.source, env);
    if (existsSync(path)) continue;
    mkdirSync(path, { recursive: true });
    const who = imageUser(services(file)[m.service] ?? {}, env);
    chownSync(path, who?.uid ?? 1000, who?.gid ?? 1000);
    if (who) console.log(`   ${m.source} given to ${who.uid}:${who.gid}`);
  }

  console.log(`== ${id}: up (${Object.entries(env).filter(([k]) => k.endsWith("PORT")).map(([k, v]) => `${k}=${v}`).join(" ")})`);
  const pull = Date.now();
  const up = compose(appDir, project, "up", "-d");
  let ok = up.exitCode === 0;
  if (!ok) console.log(up.stderr.toString());
  // the wait starts once the images are there: pulling a few gigabytes is not the app's slowness
  const started = Date.now();
  console.log(`   up in ${Math.round((started - pull) / 1000)} s`);

  if (ok && hata.web) {
    const url = `${env.APP_URL}${hata.web.path ?? "/"}`;
    let answer = "";
    while (Date.now() - started < WAIT_MS) {
      try {
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000), tls: { rejectUnauthorized: false } });
        if (res.status < 500) {
          answer = `${res.status}`;
          break;
        }
      } catch {}
      await Bun.sleep(3000);
    }
    ok = !!answer;
    console.log(ok ? `   ${url} answered ${answer} after ${Math.round((Date.now() - started) / 1000)} s` : `   ${url} did not answer in ${WAIT_MS / 60_000} min`);
  }
  // a container that keeps restarting is a failure even when the page answers
  // a container that keeps restarting, or ended with an error, is a failure even when the page answers;
  // one that did its work and ended (exit 0) is not
  const ps = compose(appDir, project, "ps", "-a", "--format", "{{.Service}} {{.State}} {{.ExitCode}} {{.Status}}").stdout.toString().trim();
  console.log(ps.replace(/^/gm, "   "));
  for (const line of ps.split("\n")) {
    const [, state, code] = line.split(" ");
    if (state === "restarting" || (state === "exited" && code !== "0") || state === "dead") ok = false;
  }
  if (!ok) console.log(compose(appDir, project, "logs", "--tail", "30").stdout.toString());

  if (!keep) {
    compose(appDir, project, "down", "-v");
    rmSync(base, { recursive: true, force: true });
  }
  return ok;
}

let failed = 0;
for (const id of ids) if (!(await smoke(id))) failed++;
console.log(failed ? `${failed} of ${ids.length} failed` : `${ids.length} answered`);
process.exit(failed ? 1 : 0);

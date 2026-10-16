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

function secret(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
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

async function smoke(id: string): Promise<boolean> {
  const source = join(ROOT, "apps", id);
  const hata = Bun.YAML.parse(readFileSync(join(source, "hata.yml"), "utf8")) as Obj;
  const file = Bun.YAML.parse(readFileSync(join(source, "compose.yml"), "utf8")) as Obj;
  const base = join("/var/tmp/hata-smoke", id);
  rmSync(base, { recursive: true, force: true });
  const dataRoot = join(base, "data");
  const appDir = join(base, "app");
  const appData = join(dataRoot, "AppData", id);
  mkdirSync(appDir, { recursive: true });
  mkdirSync(appData, { recursive: true });
  chownSync(appData, 1000, 1000);
  cpSync(join(source, "compose.yml"), join(appDir, "compose.yml"));

  const env: Record<string, string> = { APP_DATA: appData, PUID: "1000", PGID: "1000", TZ: "Europe/Kyiv" };
  const known = { ...env, DATA_ROOT: dataRoot };
  for (const s of hata.settings ?? []) {
    if (s.type === "secret") env[s.name] = secret(s.length ?? 32);
    else if (s.type === "port") env[s.name] = String(await freePort(Number(s.default ?? 8000)));
    else if (s.default !== undefined) env[s.name] = fill(String(s.default), known);
  }
  writeFileSync(join(appDir, ".env"), Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""));

  // the folders Hata makes for the app before the first start, owned by the user it runs apps as
  const folders = (hata.settings ?? []).filter((s: Obj) => s.type === "folder").map((s: Obj) => s.name);
  for (const m of bindMounts(file)) {
    if (mountKind(m, folders) !== "own" || m.source.startsWith("/")) continue;
    const path = fill(m.source, env);
    if (existsSync(path)) continue;
    mkdirSync(path, { recursive: true });
    chownSync(path, 1000, 1000);
  }

  const project = `smoke-${id}`;
  console.log(`== ${id}: up (${Object.entries(env).filter(([k]) => k.endsWith("PORT")).map(([k, v]) => `${k}=${v}`).join(" ")})`);
  const pull = Date.now();
  const up = compose(appDir, project, "up", "-d");
  let ok = up.exitCode === 0;
  if (!ok) console.log(up.stderr.toString());
  // the wait starts once the images are there: pulling a few gigabytes is not the app's slowness
  const started = Date.now();
  console.log(`   up in ${Math.round((started - pull) / 1000)} s`);

  if (ok && hata.web) {
    const def = services(file)[hata.web.service]!;
    const url = `${hata.web.scheme ?? "http"}://127.0.0.1:${hostPort(def, hata.web.port, env)}${hata.web.path ?? "/"}`;
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
  const ps = compose(appDir, project, "ps", "-a", "--format", "{{.Service}} {{.State}} {{.Status}}").stdout.toString().trim();
  console.log(ps.replace(/^/gm, "   "));
  if (/restarting|exited/i.test(ps)) ok = false;
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

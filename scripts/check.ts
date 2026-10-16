/**
 * Checks the whole store and, with `--index <file>`, writes the index Hata downloads.
 *
 *   bun scripts/check.ts                  every rule, the registries asked for architectures
 *   bun scripts/check.ts --offline        without the registries (and without an index)
 *   bun scripts/check.ts --index out.json
 *
 * When `docker` is on the PATH, every compose file also goes through `docker compose config`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ID_RE, type AppFiles, checkCompose, checkHata, checkShipped, checkStore, type Shipped, textOf, common, isObject, type Obj, platformsOf, type Problem, parseImage, services,
} from "./lib.ts";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const indexAt = args.includes("--index") ? args[args.indexOf("--index") + 1] : "";
if (offline && indexAt) throw new Error("--index needs the registries");

const problems: Problem[] = [];

function readYaml(path: string): unknown {
  const file = path.slice(ROOT.length + 1);
  try {
    return Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    problems.push({ file, text: `is not valid YAML: ${e instanceof Error ? e.message : e}` });
    return null;
  }
}

const appsDir = join(ROOT, "apps");
const ids = existsSync(appsDir) ? readdirSync(appsDir).filter((n) => statSync(join(appsDir, n)).isDirectory()).sort() : [];
const store = readYaml(join(ROOT, "store.yml"));
problems.push(...checkStore(store, ids));

interface App {
  id: string;
  hata: Obj;
  composeText: string;
  compose: Obj;
  /** The other files of the app, by their path in its folder */
  files: Record<string, string>;
}
const apps: App[] = [];

for (const id of ids) {
  const dir = join(appsDir, id);
  if (!APP_ID_RE.test(id)) problems.push({ file: `apps/${id}`, text: "a folder name is lowercase letters, digits and dashes, up to 40" });
  const shipped: Shipped[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (!rel && ["compose.yml", "hata.yml", "screenshots"].includes(name)) continue;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else shipped.push({ name: path, link: stat.isSymbolicLink(), bytes: stat.isSymbolicLink() ? new Uint8Array() : readFileSync(join(dir, path)) });
    }
  };
  walk("");
  if (!existsSync(join(dir, "compose.yml"))) {
    problems.push({ file: `apps/${id}`, text: "has no compose.yml" });
    continue;
  }
  if (!existsSync(join(dir, "hata.yml"))) {
    problems.push({ file: `apps/${id}`, text: "has no hata.yml" });
    continue;
  }
  const composeText = readFileSync(join(dir, "compose.yml"), "utf8");
  const compose = readYaml(join(dir, "compose.yml"));
  const hata = readYaml(join(dir, "hata.yml"));
  const pictures: AppFiles = { id, screenshots: new Map() };
  const shots = join(dir, "screenshots");
  if (existsSync(shots)) {
    for (const name of readdirSync(shots)) {
      const bytes = readFileSync(join(shots, name));
      pictures.screenshots.set(name, { head: bytes.subarray(0, 512), size: bytes.length });
    }
  }
  problems.push(...checkHata(pictures, hata, isObject(store) ? store : {}));
  problems.push(...checkCompose(id, compose, isObject(hata) ? hata : null, shipped.map((f) => f.name)));
  problems.push(...checkShipped(id, shipped, compose));
  const files = Object.fromEntries(shipped.map((f) => [f.name, textOf(f.bytes) ?? ""]));
  if (isObject(compose) && isObject(hata)) apps.push({ id, hata, composeText, compose, files });
}

// docker compose reads the file the way Hata will run it: every setting at its default, secrets made up
if (Bun.which("docker")) {
  for (const app of apps) {
    const env: Record<string, string> = { APP_DATA: "/tmp/app", APP_URL: "http://localhost", APP_HOST: "localhost", PUID: "1000", PGID: "1000", TZ: "UTC" };
    for (const s of app.hata.settings ?? []) {
      // what the person would type: a password, a required field without a default
      if (s.type === "secret" || s.type === "password") env[s.name] = "x".repeat(32);
      else if (s.default === undefined && s.required) env[s.name] = "x";
      else env[s.name] = String(s.default ?? "").replaceAll("${DATA_ROOT}", "/tmp/data").replaceAll("${APP_DATA}", "/tmp/app");
    }
    const run = Bun.spawnSync(["docker", "compose", "-p", app.id, "-f", "-", "config", "-q"], {
      stdin: new TextEncoder().encode(app.composeText),
      env: { ...process.env, ...env },
      cwd: join(appsDir, app.id),
    });
    if (run.exitCode !== 0) problems.push({ file: `apps/${app.id}/compose.yml`, text: `docker compose config: ${run.stderr.toString().trim()}` });
  }
}

const architectures = new Map<string, string[]>();
if (!offline) {
  const cache = new Map<string, Promise<string[]>>();
  for (const app of apps) {
    const lists: string[][] = [];
    for (const [name, def] of Object.entries(services(app.compose))) {
      if (typeof def.image !== "string") continue;
      if (!cache.has(def.image)) cache.set(def.image, platformsOf(def.image));
      try {
        lists.push(await cache.get(def.image)!);
      } catch (e) {
        problems.push({ file: `apps/${app.id}/compose.yml`, text: `service ${name}: ${e instanceof Error ? e.message : e}` });
      }
    }
    const archs = common(lists).filter((a) => a !== "unknown");
    if (!archs.length) problems.push({ file: `apps/${app.id}/compose.yml`, text: "its images share no architecture" });
    architectures.set(app.id, archs);
  }
}

for (const p of problems) console.log(`${p.file}: ${p.text}`);
if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`${apps.length} apps, all well${offline ? " (registries not asked)" : ""}`);

if (indexAt) {
  const commit = process.env.GITHUB_SHA || Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT }).stdout.toString().trim();
  const index = {
    format: 1,
    commit,
    built: new Date().toISOString(),
    store,
    apps: apps.map((app) => {
      const main = services(app.compose)[app.hata.web?.service] ?? Object.values(services(app.compose))[0]!;
      const ref = parseImage(main.image);
      return {
        id: app.id,
        ...app.hata,
        screenshots: (app.hata.screenshots ?? []).map((n: string) => `apps/${app.id}/screenshots/${n}`),
        version: ref.tag || ref.digest.slice(0, 19),
        architectures: architectures.get(app.id),
        images: Object.values(services(app.compose)).map((d) => d.image),
        compose: app.composeText,
        files: app.files,
      };
    }),
  };
  writeFileSync(indexAt, JSON.stringify(index));
  console.log(`index written to ${indexAt}`);
}

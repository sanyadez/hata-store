/**
 * Brings the apps of a store in the CasaOS format into this one.
 *
 *   bun scripts/from-casaos.ts <the store's folder> [<app> …] [--force] [--marks <folder>]
 *
 * For each `Apps/<Name>/docker-compose.yml` it writes `apps/<id>/compose.yml` and `hata.yml`:
 *
 * - `/DATA/AppData/$AppID/…` becomes `${APP_DATA:-.}/…`; another folder under `/DATA` becomes a setting
 *   of type folder (`/DATA/Media` → `MEDIA_DIR`, offered as the data folder's `Media`);
 * - every published port becomes a setting of type port, the web page's one `WEB_PORT`;
 * - a variable the store described becomes a setting; a password that two services share (an app and its
 *   database) becomes a secret Hata makes;
 * - `$PUID`, `$PGID`, `$TZ` get defaults, `$AppID` is written out;
 * - `container_name` goes (another service that called it by that name finds it by a network alias), so
 *   do `name` and the `x-casaos` blocks;
 * - an image on a moving tag is pinned: to the version tag of the same image, else to its digest;
 * - the texts keep every language, `en_US` becoming `en`; paragraphs about the store's own devices go;
 * - what the compose file asks of the host is explained by what it asks for (devices, paths, rights).
 *
 * An app whose folder is here already is left alone unless --force; one made here by hand (not listed
 * in `--marks`) never. Icons and screenshots are not written: `<marks>/<id>.json` says where they lie,
 * for the step that turns them into WebP.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { floating, hubTag, isObject, type Obj, parseImage, registryGet, MANIFEST_TYPES, splitVolume } from "./lib.ts";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
if (!source) throw new Error("usage: bun scripts/from-casaos.ts <the store's folder> [<app> …] [--force]");
const force = args.includes("--force");
/** A folder outside the store for what the conversion found: where each app's pictures lie */
const marks = args.includes("--marks") ? args[args.indexOf("--marks") + 1]! : "/var/tmp/hata-casaos";
mkdirSync(marks, { recursive: true });
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--marks").slice(1);

/** Apps of this store made by hand: never written over */
const OURS = new Set(readdirSync(join(ROOT, "apps")).filter((n) => !existsSync(join(marks, `${n}.json`))));
/** The CasaOS name of an app that is here under another id */
const SAME = new Map([["homeassistant", "home-assistant"], ["uptimekuma", "uptime-kuma"]]);

const CATEGORY: Record<string, string> = {
  Media: "media",
  Productivity: "productivity",
  Home: "home",
  Networking: "network",
  AI: "ai",
  Finance: "finance",
  Social: "social",
  Developer: "development",
};

const HATA_NAMES = new Set(["APP_DATA", "APP_URL", "APP_HOST", "PUID", "PGID", "TZ", "DATA_ROOT"]);
const PASSWORDISH = /PASS|SECRET|TOKEN|_KEY$|^KEY$/i;

type Text = Record<string, string>;

/** `{ en_US: …, uk_UA: … }` → `{ en: …, uk: … }`; the first of a language wins */
function text(value: unknown, clean = (s: string) => s): Text | null {
  if (typeof value === "string") return value.trim() ? { en: clean(value) } : null;
  if (!isObject(value)) return null;
  const out: Text = {};
  const keys = Object.keys(value).sort((a, b) => (a === "en_US" ? -1 : b === "en_US" ? 1 : 0));
  for (const key of keys) {
    const v = value[key];
    const lang = key.split(/[_-]/)[0]!.toLowerCase();
    // the store's Ukrainian is a machine's; this store writes its own
    if (typeof v !== "string" || !/^[a-z]{2}$/.test(lang) || lang in out || lang === "uk") continue;
    const t = clean(v);
    if (t.trim()) out[lang] = t;
  }
  return out.en ? out : null;
}

/** Paragraphs joined where the store broke lines for itself; a paragraph about its devices goes */
function prose(s: string): string {
  return s
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/\b(ZimaOS|ZimaCube|ZimaBoard|Zima|CasaOS|IceWhale)\b/i.test(p))
    .map((p) => p.split("\n").reduce((acc, line) => (acc && !/^\s*([-*#>]|\d+\.)/.test(line) ? `${acc} ${line.trim()}` : acc ? `${acc}\n${line.trim()}` : line.trim()), ""))
    .join("\n\n");
}

/** The store named itself in some texts: "for CasaOS", "on CasaOS", "CasaOS's reverse proxy" */
const unstore = (s: string) => s.replace(/\s+(?:for|on|in)\s+(?:CasaOS|ZimaOS)\b/g, "").replace(/\b(?:CasaOS|ZimaOS)'s\s+/g, "the ").replace(/\b(?:CasaOS|ZimaOS)\s+/g, "");
const short = (s: string) => unstore(s.replace(/\s+/g, " ").trim());

/** A tagline is one line: the first sentence, and no more than the store takes */
function tagline(s: string): string {
  let t = short(s);
  if (t.length > 120) t = t.split(/(?<=[.!?。])\s/)[0]!;
  if (t.length > 120) t = t.slice(0, 118).replace(/\s+\S*$/, "") + "…";
  return t;
}

function described(service: Obj, kind: "ports" | "volumes" | "envs", container: string): Text | null {
  const list = isObject(service["x-casaos"]) ? service["x-casaos"][kind] : null;
  const hit = Array.isArray(list) ? list.find((i: Obj) => isObject(i) && String(i.container) === container) : null;
  return hit ? text(hit.description, short) : null;
}

/** A field's label: the store's description when it is short; else the description is the hint */
function labelled(service: Obj, kind: "ports" | "volumes" | "envs", container: string, name: string): { label: Text; hint?: Text } | null {
  const t = described(service, kind, container);
  if (!t) return null;
  const whole = t.en!.replace(/\.$/, "");
  if (whole.length <= 60 && !/[.!?]\s/.test(whole)) {
    for (const k of Object.keys(t)) t[k] = t[k]!.replace(/[.。]$/, "");
    return { label: t };
  }
  const words = name.replace(/_/g, " ").toLowerCase();
  return { label: { en: words[0]!.toUpperCase() + words.slice(1) }, hint: t };
}

/** `$PUID` and friends with defaults, `$AppID` written out */
function ownVars(s: string, id: string): string {
  return s
    .replace(/\$\{AppID\}|\$AppID(?![A-Za-z0-9_])/g, id)
    .replace(/\$\{PUID\}|\$PUID(?![A-Za-z0-9_])/g, "${PUID:-1000}")
    .replace(/\$\{PGID\}|\$PGID(?![A-Za-z0-9_])/g, "${PGID:-1000}")
    .replace(/\$\{TZ\}|\$TZ(?![A-Za-z0-9_])/g, "${TZ:-UTC}");
}

function walk(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, f));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)]));
  return v;
}

// --- Images -------------------------------------------------------------------------------------------

const semverish = (t: string) => /^v?\d+(\.\d+)+/.test(t);

/** lscr.io serves the images of ghcr.io and answers 429 soon: ask ghcr.io */
const asked = (image: string) => image.replace(/^lscr\.io\//, "ghcr.io/");

async function digestOf(image: string): Promise<string> {
  const ref = parseImage(asked(image));
  if (ref.registry === "docker.io") {
    const tag = await hubTag(ref);
    if (!tag) throw new Error(`${image}: no such tag`);
    return tag.digest;
  }
  // HEAD: Docker Hub does not count it against the pulls an address may make
  const res = await registryGet(ref, `manifests/${ref.tag || "latest"}`, MANIFEST_TYPES, "HEAD");
  if (!res.ok) throw new Error(`${image}: ${res.status}`);
  return res.headers.get("docker-content-digest") ?? "";
}

/** What was found before, so that a run again asks the registries only about what failed */
const pinsFile = join(marks, "..", "hata-casaos-pins.json");
const pins: Record<string, { image: string; how: string }> = existsSync(pinsFile) ? JSON.parse(readFileSync(pinsFile, "utf8")) : {};

/** The image on a version tag that is the same image as the moving one, else on its digest */
async function pin(image: string): Promise<{ image: string; how: string }> {
  if (!floating(image)) return { image, how: "" };
  if (pins[image]) return pins[image]!;
  const found = await findPin(image);
  pins[image] = found;
  writeFileSync(pinsFile, JSON.stringify(pins, null, 1));
  return found;
}

async function findPin(image: string): Promise<{ image: string; how: string }> {
  const ref = parseImage(asked(image));
  const tag = ref.tag || "latest";
  const digest = await digestOf(image);
  const name = image.replace(/:[^/:@]+$/, "");
  if (ref.registry === "docker.io") {
    const res = await fetch(`https://hub.docker.com/v2/repositories/${ref.repo}/tags?page_size=100&ordering=last_updated`, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const tags = ((await res.json()) as Obj).results as Obj[];
      const same = tags.filter((t) => t.name !== tag && t.digest === digest && semverish(t.name)).map((t) => t.name as string);
      // the most precise version: 1.2.3 over 1.2 over 1
      same.sort((a, b) => b.split(/[.-]/).length - a.split(/[.-]/).length || b.length - a.length);
      if (same[0]) return { image: `${name}:${same[0]}`, how: `${tag} is ${same[0]}` };
    }
  } else {
    const res = await registryGet(ref, "tags/list?n=1000", "application/json");
    if (res.ok) {
      const all = (((await res.json()) as Obj).tags ?? []) as string[];
      const order = (a: string, b: string) => {
        try {
          return Bun.semver.order(b.replace(/^v/, "").replace(/-.*/, ""), a.replace(/^v/, "").replace(/-.*/, ""));
        } catch {
          return 0;
        }
      };
      const candidates = all.filter((t) => semverish(t) && !/sig$|att$|sbom$/.test(t)).sort((a, b) => order(a, b) || b.length - a.length).slice(0, 25);
      for (const t of candidates) {
        try {
          if ((await digestOf(`${name}:${t}`)) === digest) return { image: `${name}:${t}`, how: `${tag} is ${t}` };
        } catch {}
      }
    }
  }
  return { image: `${name}:${tag}@${digest}`, how: `${tag} pinned by its digest` };
}

// --- One app ------------------------------------------------------------------------------------------

interface Report {
  id: string;
  from: string;
  notes: string[];
}

const label = (en: string, uk: string): Text => ({ en, uk });

/** The data folder's usual folders by name */
const FOLDERS: Record<string, string> = { Media: "Медіа", Downloads: "Завантаження", Gallery: "Галерея", Documents: "Документи", Music: "Музика", Movies: "Фільми", TV: "Серіали", "TV Shows": "Серіали", Books: "Книжки", Photos: "Фото", Pictures: "Зображення", Videos: "Відео", Backup: "Резервні копії", Backups: "Резервні копії", Games: "Ігри", Podcasts: "Подкасти", Audiobooks: "Аудіокнижки", Comics: "Комікси", ROMs: "ROM-и" };
const folderName = (rest: string): Text => ({ en: rest, uk: rest.split("/").map((p) => FOLDERS[p] ?? p).join("/") });

async function convert(dir: string): Promise<Report | null> {
  const file = join(source!, "Apps", dir, "docker-compose.yml");
  const c = Bun.YAML.parse(readFileSync(file, "utf8")) as Obj;
  const x: Obj = isObject(c["x-casaos"]) ? c["x-casaos"] : {};
  const casaosName = String(c.name ?? dir).toLowerCase();
  const id = SAME.get(casaosName) ?? casaosName.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (only.length && !only.includes(id) && !only.includes(dir)) return null;
  const report: Report = { id, from: dir, notes: [] };
  const target = join(ROOT, "apps", id);
  if (OURS.has(id) || (existsSync(target) && !force)) return null;

  const services: Record<string, Obj> = isObject(c.services) ? c.services : {};
  const main = typeof x.main === "string" && services[x.main] ? x.main : Object.keys(services)[0]!;
  const settings: Obj[] = [];
  const named = new Map<string, Obj>();
  const add = (s: Obj) => {
    let name = s.name as string;
    for (let n = 2; named.has(name) || HATA_NAMES.has(name); n++) name = `${s.name}_${n}`;
    s.name = name;
    named.set(name, s);
    settings.push(s);
    return name;
  };

  // container names other services call it by
  const allText = JSON.stringify(services);
  const aliases = new Map<string, string>();
  for (const [name, s] of Object.entries(services)) {
    const cn = typeof s.container_name === "string" ? s.container_name : "";
    if (cn && cn !== name && allText.split(cn).length > 2) aliases.set(name, cn);
  }

  // passwords two services share: one secret
  const shared = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  for (const [sname, s] of Object.entries(services)) {
    const env = isObject(s.environment) ? s.environment : Array.isArray(s.environment) ? Object.fromEntries(s.environment.map((e: string) => [e.split("=")[0], e.split("=").slice(1).join("=")])) : {};
    for (const [k, v] of Object.entries(env)) {
      if (!PASSWORDISH.test(k) || typeof v !== "string" || !v || v.includes("$")) continue;
      if (!seen.has(v)) seen.set(v, new Set());
      seen.get(v)!.add(sname);
    }
  }
  for (const [value, users] of seen) if (users.size > 1) shared.set(value, "");

  const ports = new Map<string, string>();
  const folders = new Map<string, string>();
  let webPort = 0;
  const portMap = String(x.port_map ?? "");

  for (const [sname, s] of Object.entries(services)) {
    // the descriptions of its ports, folders and variables, before the block goes
    const xs = { "x-casaos": s["x-casaos"] };
    delete s.container_name;
    delete s["x-casaos"];
    if (!["unless-stopped", "always", "on-failure"].includes(s.restart) && s.restart !== "no") s.restart = "unless-stopped";
    if (s.network_mode === "bridge") delete s.network_mode;
    // the store's own tile data in labels
    if (isObject(s.labels)) {
      delete s.labels.icon;
      if (!Object.keys(s.labels).length) delete s.labels;
    }

    // ports
    if (Array.isArray(s.ports)) {
      s.ports = s.ports.map((p: unknown) => {
        let target = "", published = "", protocol = "tcp", ip = "";
        if (isObject(p)) {
          target = String(p.target ?? "");
          published = String(p.published ?? "");
          protocol = String(p.protocol ?? "tcp");
          ip = String(p.host_ip ?? "");
        } else {
          const m = /^(?:(\d+\.\d+\.\d+\.\d+):)?(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/.exec(String(p));
          if (!m) {
            report.notes.push(`port ${p} kept as written`);
            return p;
          }
          [ip, published, target, protocol] = [m[1] ?? "", m[2] ?? "", m[3]!, m[4] ?? "tcp"];
        }
        if (!published || !/^\d+$/.test(published) || !/^\d+$/.test(target)) return p;
        const key = `${sname}:${target}:${published}`;
        let name = ports.get(key);
        if (!name) {
          const web = sname === main && published === portMap && protocol === "tcp" && !webPort;
          if (web) webPort = Number(target);
          const desc = labelled(xs, "ports", target, `port ${target}`);
          name = add({
            name: web ? "WEB_PORT" : `${sname === main ? "" : sname.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_"}PORT_${target}`,
            type: "port",
            default: Number(published),
            label: web ? label("Web port", "Порт вебінтерфейсу") : (desc?.label ?? label(`Port ${target}`, `Порт ${target}`)),
            ...(!web && desc?.hint ? { hint: desc.hint } : {}),
            ...(web ? {} : { advanced: true }),
          });
          ports.set(key, name);
        }
        return `${ip ? ip + ":" : ""}\${${name}:-${published}}:${target}${protocol === "udp" ? "/udp" : ""}`;
      });
    }
    if (sname === main && !webPort && s.network_mode === "host" && /^\d+$/.test(portMap)) webPort = Number(portMap);

    // folders
    if (Array.isArray(s.volumes)) {
      s.volumes = s.volumes.map((v: unknown) => {
        const long = isObject(v);
        const parts = long ? null : splitVolume(String(v));
        // the store's own devices keep data on a disk of theirs: it is the data folder here
        const src = (long ? String((v as Obj).source ?? "") : parts!.length > 1 ? parts![0]! : "").replace(/^\/media\/ZimaOS-HD(?=\/|$)/, "/DATA");
        if (!src.startsWith("/")) return v;
        const dst = long ? String((v as Obj).target ?? "") : parts![1]!;
        let next = src;
        const own = /^\/DATA\/AppData\/(?:\$\{?AppID\}?|[^/]+)(\/.*)?$/.exec(src);
        if (own) next = `\${APP_DATA:-.}${own[1] ?? ""}`;
        else if (/^\/DATA\/.+/.test(src)) {
          const rest = src.slice("/DATA/".length).replace(/\/+$/, "");
          let name = folders.get(rest);
          if (!name) {
            const base = rest.split("/").pop()!.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DATA";
            name = add({
              name: `${base}_DIR`,
              type: "folder",
              default: `\${DATA_ROOT}/${rest}`,
              label: labelled(xs, "volumes", dst, rest.split("/").pop()!)?.label ?? folderName(rest),
              hint: labelled(xs, "volumes", dst, rest)?.hint ?? label(`Inside the app it is ${dst}`, `У застосунку вона — ${dst}`),
            });
            folders.set(rest, name);
          }
          next = `\${${name}:-./${rest}}`;
        } else if (src === "/DATA") {
          next = "${DATA_DIR:-./data}";
          if (!named.has("DATA_DIR")) add({ name: "DATA_DIR", type: "folder", default: "${DATA_ROOT}", label: label("Data folder", "Тека даних") });
        }
        if (long) return { ...(v as Obj), source: next };
        return [next, ...parts!.slice(1)].join(":");
      });
    }

    // variables
    const envList = Array.isArray(s.environment);
    const env: Obj = envList ? Object.fromEntries(s.environment.map((e: string) => { const i = String(e).indexOf("="); return i < 0 ? [e, null] : [String(e).slice(0, i), String(e).slice(i + 1)]; })) : isObject(s.environment) ? s.environment : {};
    for (const [k, raw] of Object.entries(env)) {
      if (raw === null || typeof raw === "object") continue;
      const value = String(raw);
      if (/^\$\{?(PUID|PGID|TZ|AppID)\}?$/.test(value)) continue;
      if (k === "TZ") {
        env[k] = "${TZ:-UTC}";
        continue;
      }
      if (shared.has(value) && PASSWORDISH.test(k)) {
        let name = shared.get(value);
        if (!name) {
          name = add({ name: "DB_PASSWORD", type: "secret", label: label("Password between its services", "Пароль між його сервісами") });
          shared.set(value, name);
        }
        env[k] = `\${${name}:?set ${name}}`;
        continue;
      }
      let desc = labelled(xs, "envs", k, k);
      // a key or a token of the app's own (one the store wrote a value for) is made by Hata, as long as
      // the one written; one given by another service (left empty) is typed by the person, hidden
      if (/SECRET|TOKEN|_KEY$|^KEY$/i.test(k) && !/PASS/i.test(k) && /^[A-Za-z0-9_+/=.-]*$/.test(value)) {
        const name = add(value
          ? { name: k.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), type: "secret", ...(value.length >= 12 && value.length <= 128 && value.length !== 32 ? { length: value.length } : {}), label: desc?.label ?? { en: k } }
          : { name: k.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), type: "password", label: desc?.label ?? { en: k }, ...(desc?.hint ? { hint: desc.hint } : {}) });
        env[k] = value ? `\${${name}:?set ${name}}` : `\${${name}:-}`;
        continue;
      }
      // a password written into the file: a database's own is made by Hata, one to sign in with is the
      // person's to choose at install (the store's "casaos" is everybody's)
      if (/PASS/i.test(k) && value && /^[A-Za-z0-9_+/=.@-]*$/.test(value)) {
        const internal = /ROOT|DB|POSTGRES|MYSQL|MARIADB|REDIS|MONGO|DATABASE/i.test(k);
        const name = add(internal
          ? { name: k.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), type: "secret", label: desc?.label ?? { en: k } }
          : { name: k.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), type: "password", required: true, label: desc?.label ?? (k.toUpperCase() === "PASSWORD" ? label("Password", "Пароль") : { en: k }), ...(desc?.hint ? { hint: desc.hint } : {}) });
        env[k] = `\${${name}:?set ${name}}`;
        continue;
      }
      // the store's own name as a user's or a database's: a user to sign in as is shown, as "admin"
      if (/^(casaos|zimaos)$/i.test(value)) {
        if (/USER|LOGIN/i.test(k)) {
          const name = add({ name: k.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), type: "text", default: "admin", required: true, label: desc?.label ?? label("User name", "Ім'я користувача"), ...(desc?.hint ? { hint: desc.hint } : {}) });
          env[k] = `\${${name}:-admin}`;
        } else env[k] = desc ? `\${${add({ name: k.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), type: "text", default: "hata", label: desc.label, ...(desc.hint ? { hint: desc.hint } : {}) })}:-hata}` : "hata";
        continue;
      }
      if (!desc || /[$}\n'"]/.test(value) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      const name = add({ name: k.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[^A-Z]+/, "") || "SETTING", type: "text", ...(value ? { default: value } : {}), label: desc.label, ...(desc.hint ? { hint: desc.hint } : {}) });
      env[k] = `\${${name}:-${value}}`;
    }
    if (Object.keys(env).length) s.environment = env;

    // a name another service calls it by
    const alias = aliases.get(sname);
    if (alias && s.network_mode === undefined) {
      if (Array.isArray(s.networks)) s.networks = Object.fromEntries(s.networks.map((n: string) => [n, { aliases: [alias] }]));
      else if (isObject(s.networks)) for (const n of Object.keys(s.networks)) s.networks[n] = { ...(isObject(s.networks[n]) ? s.networks[n] : {}), aliases: [alias] };
      else s.networks = { default: { aliases: [alias] } };
    }

    // images
    if (typeof s.image === "string") {
      try {
        const pinned = await pin(s.image);
        if (pinned.how) report.notes.push(`${s.image}: ${pinned.how}`);
        s.image = pinned.image;
      } catch (e) {
        report.notes.push(`image ${s.image} not pinned: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  let compose: Obj = walk({ services }, (str) => ownVars(str, id).replace(/^(Zima|ZimaOS|CasaOS)$/, "hata").replace(/\s(?:on|for) CasaOS\b/g, "")) as Obj;
  // a variable the store left for its install form to fill: a setting, empty unless given
  const unknown = new Set<string>();
  walk(compose, (str) => {
    for (const m of str.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      const name = m[1] ?? m[2]!;
      if (!HATA_NAMES.has(name) && !named.has(name) && !/^\$\$/.test(m[0])) unknown.add(name);
    }
    return str;
  });
  for (const name of unknown) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      report.notes.push(`variable ${name} left as written`);
      continue;
    }
    add({ name, type: PASSWORDISH.test(name) ? "password" : "text", label: { en: name } });
    report.notes.push(`variable ${name} made a setting`);
    compose = walk(compose, (str) => str.replace(new RegExp(`\\$\\{${name}\\}|\\$${name}(?![A-Za-z0-9_])`, "g"), `\${${name}:-}`)) as Obj;
  }
  for (const key of ["volumes", "networks", "configs", "secrets"]) if (c[key] !== undefined) compose[key] = c[key];

  // what it asks of the host, said by what it asks for
  const permissions: Obj = {};
  const devices = new Set<string>(), paths = new Set<string>(), caps = new Set<string>();
  for (const s of Object.values(compose.services as Record<string, Obj>)) {
    if (s.network_mode === "host") permissions["host-network"] = label("Its authors run it on the server's own network: it reaches the devices of the home network, and its ports are the server's", "Автори запускають його в мережі самого сервера: він бачить пристрої домашньої мережі, а його порти — порти сервера");
    if (s.pid === "host") permissions["host-pid"] = label("It sees the processes of the server", "Він бачить процеси сервера");
    if (s.privileged === true) permissions.privileged = label("Its authors run it with full access to the server", "Автори запускають його з повним доступом до сервера");
    for (const d of Array.isArray(s.devices) ? s.devices : []) devices.add(String(isObject(d) ? d.source : d).split(":")[0]!);
    for (const cap of Array.isArray(s.cap_add) ? s.cap_add : []) caps.add(String(cap));
    for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
      const src = isObject(v) ? String(v.source ?? "") : splitVolume(String(v))[0]!;
      if (/^\/(var\/)?run\/docker\.sock$/.test(src)) permissions.docker = label("It controls the server's Docker: it sees and manages the containers", "Він керує Docker сервера: бачить контейнери й керує ними");
      else if (src.startsWith("/") && !["/etc/localtime", "/etc/timezone"].includes(src)) paths.add(src);
      else if ((src === "/etc/localtime" || src === "/etc/timezone") && !(isObject(v) ? v.read_only === true : /:ro\b/.test(String(v)))) paths.add(src);
    }
  }
  if (devices.size) permissions.devices = label(`It uses devices of the server: ${[...devices].join(", ")}`, `Він користується пристроями сервера: ${[...devices].join(", ")}`);
  if (caps.size) permissions.capabilities = label(`It asks for extra rights of the system: ${[...caps].join(", ")}`, `Він просить додаткових прав у системі: ${[...caps].join(", ")}`);
  if (paths.size) permissions["host-files"] = label(`It reaches these places of the system: ${[...paths].join(", ")}`, `Він має доступ до цих місць системи: ${[...paths].join(", ")}`);

  const hata: Obj = {
    title: text(x.title, short) ?? { en: dir },
    tagline: text(x.tagline, tagline) ?? text(x.title, short) ?? { en: dir },
    description: text(x.description, prose) ?? text(x.tagline, short) ?? { en: dir },
  };
  const notes = isObject(x.tips) ? text(x.tips.before_install, prose) : null;
  if (notes) hata.notes = notes;
  hata.category = CATEGORY[x.category] ?? "utilities";
  // the store's own team packed many apps; the developer is then the one the image belongs to
  const packer = /Zima|IceWhale|CasaOS/i;
  const owner = parseImage(String(services[main]?.image ?? "")).repo.split("/")[0]!;
  hata.developer = [x.developer, x.author].find((d) => typeof d === "string" && d.trim() && !packer.test(d)) ?? (owner && owner !== "library" ? owner : x.title?.en_US ?? dir);
  const https = (u: unknown) => (typeof u === "string" && /^https:\/\/\S+$/.test(u.trim()) ? u.trim() : "");
  hata.website = https(x.website) || https(x.repo) || `https://hub.docker.com/`;
  if (https(x.repo)) hata.source = https(x.repo);
  hata.icon = "ICON";
  if (webPort) hata.web = { service: main, port: webPort, ...(typeof x.index === "string" && x.index && x.index !== "/" ? { path: x.index.startsWith("/") ? x.index : "/" + x.index } : {}), ...(x.scheme === "https" ? { scheme: "https" } : {}) };
  else report.notes.push("no web page found");
  if (settings.length) hata.settings = settings;
  if (Object.keys(permissions).length) hata.permissions = permissions;

  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "compose.yml"), Bun.YAML.stringify(compose, null, 2).replace(/[ \t]+$/gm, "") + "\n");
  writeFileSync(join(target, "hata.yml"), Bun.YAML.stringify(hata, null, 2).replace(/[ \t]+$/gm, "") + "\n");
  // where the pictures lie, for the step that makes WebP of them
  const folder = join(source!, "Apps", dir);
  const files = readdirSync(folder);
  writeFileSync(
    join(marks, `${id}.json`),
    JSON.stringify({ from: dir, icon: files.includes("icon.svg") ? join(folder, "icon.svg") : files.includes("icon.png") ? join(folder, "icon.png") : "", screenshots: files.filter((f) => /^screenshot-\d+\.(png|jpe?g|webp)$/.test(f)).sort().map((f) => join(folder, f)), notes: report.notes }, null, 2),
  );
  return report;
}

const reports: Report[] = [];
for (const dir of readdirSync(join(source, "Apps")).sort()) {
  try {
    const r = await convert(dir);
    if (r) reports.push(r);
  } catch (e) {
    console.log(`${dir}: ${e instanceof Error ? e.message : e}`);
  }
}
for (const r of reports) if (r.notes.length) console.log(`${r.id}: ${r.notes.join("; ")}`);
console.log(`${reports.length} apps written`);

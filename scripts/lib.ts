/**
 * The rules of the store: what an app folder holds and what its files may say. Pure functions apart from
 * `platformsOf` (asks a registry) — `check.ts` and `smoke.ts` are the commands.
 */

export type Obj = Record<string, any>;

export const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Variables Hata writes into every app's `.env` */
export const HATA_VARS = ["APP_DATA", "APP_URL", "APP_HOST", "PUID", "PGID", "TZ"] as const;
/** Variables a default value in `hata.yml` may name, besides the ones above */
export const DEFAULT_VARS = [...HATA_VARS, "DATA_ROOT"] as const;

export const APP_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const VAR_RE = /^[A-Z][A-Z0-9_]*$/;
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const URL_RE = /^https:\/\/[^\s]+$/;

export const SETTING_TYPES = ["text", "number", "port", "folder", "secret", "password", "choice", "switch", "url"] as const;
export const PERMISSIONS = ["host-network", "host-pid", "privileged", "devices", "capabilities", "docker", "host-files"] as const;

export const MAX_ICON = 32 * 1024;
export const MAX_SCREENSHOT = 600 * 1024;
export const MAX_SCREENSHOTS = 8;
/** All the other files of an app together */
export const MAX_SHIPPED = 256 * 1024;

/** Names in an app's folder that are not the store's to ship: Hata writes them */
const RESERVED = new Set([".env", "compose.override.yml", "compose.override.yaml", "docker-compose.override.yml"]);

/** Tags that move by themselves: an app pinned to one of them updates without the store knowing */
const FLOATING = new Set(["latest", "stable", "release", "main", "master", "nightly", "edge", "dev", "develop", "beta", "unstable", "testing", "next", "preview"]);

/** Files read without a word: the time zone of the host, read-only */
const HARMLESS = new Set(["/etc/localtime", "/etc/timezone"]);

const HATA_KEYS = ["title", "tagline", "description", "category", "developer", "website", "source", "icon", "screenshots", "web", "settings", "permissions", "notes"];

export interface Problem {
  /** `apps/<id>/hata.yml` and the like */
  file: string;
  text: string;
}

// --- Variables ----------------------------------------------------------------------------------------

export interface VarUse {
  name: string;
  /** "" — no operator: `${X}` or `$X` */
  op: "" | "-" | ":-" | "?" | ":?" | "+" | ":+";
  arg: string;
}

const USE_RE = /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** The variables a string of a compose file names, the way `docker compose` reads them (`$$` is a dollar) */
export function varsIn(text: string): VarUse[] {
  const out: VarUse[] = [];
  for (const m of text.matchAll(USE_RE)) {
    if (m[0] === "$$") continue;
    out.push({ name: m[1] ?? m[4]!, op: (m[2] ?? "") as VarUse["op"], arg: m[3] ?? "" });
  }
  return out;
}

/** Fills the variables of a string as `docker compose` does; an unknown one without a default becomes "" */
export function fill(text: string, env: Record<string, string>): string {
  return text.replace(USE_RE, (all, braced?: string, op?: string, arg?: string, bare?: string) => {
    if (all === "$$") return "$";
    const set = env[(braced ?? bare)!];
    if (!op) return set ?? "";
    const present = op.startsWith(":") ? !!set : set !== undefined;
    if (op.endsWith("+")) return present ? arg! : "";
    return present ? set! : op.endsWith("-") ? arg! : "";
  });
}

/** Every string anywhere in a parsed YAML value, keys included */
function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) {
    yield k;
    yield* strings(v);
  }
}

// --- Images -------------------------------------------------------------------------------------------

export interface ImageRef {
  registry: string;
  repo: string;
  tag: string;
  digest: string;
}

/** `nginx:1.27` → docker.io/library/nginx, tag 1.27 */
export function parseImage(image: string): ImageRef {
  let rest = image;
  let digest = "";
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = "";
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const parts = rest.split("/");
  let registry = "docker.io";
  if (parts.length > 1 && (/[.:]/.test(parts[0]!) || parts[0] === "localhost")) registry = parts.shift()!;
  if (registry === "docker.io" && parts.length === 1) parts.unshift("library");
  return { registry, repo: parts.join("/"), tag, digest };
}

/** Why an image reference is not pinned, or "" */
export function floating(image: string): string {
  const ref = parseImage(image);
  if (ref.digest) return "";
  if (!ref.tag) return "has no tag";
  if (FLOATING.has(ref.tag.toLowerCase())) return `uses the moving tag "${ref.tag}"`;
  return "";
}

// --- The compose file ---------------------------------------------------------------------------------

export interface Mount {
  service: string;
  source: string;
  target: string;
  readOnly: boolean;
}

/** Host folders and files the services mount (named volumes left out) */
export function bindMounts(compose: Obj): Mount[] {
  const out: Mount[] = [];
  for (const [service, def] of Object.entries(services(compose))) {
    for (const v of Array.isArray(def.volumes) ? def.volumes : []) {
      if (typeof v === "string") {
        const parts = splitVolume(v);
        const source = parts[0]!;
        if (parts.length < 2 || !/^[/.~$]/.test(source)) continue;
        out.push({ service, source, target: parts[1]!, readOnly: (parts[2] ?? "").split(",").includes("ro") });
      } else if (isObject(v) && v.type === "bind") {
        out.push({ service, source: String(v.source ?? ""), target: String(v.target ?? ""), readOnly: v.read_only === true });
      }
    }
  }
  return out;
}

/** `src:dst:mode` split at the colons outside `${…}` */
export function splitVolume(v: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === "$" && v[i + 1] === "{") depth++;
    else if (c === "}" && depth) depth--;
    if (c === ":" && !depth) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

export const services = (compose: Obj): Record<string, Obj> => (isObject(compose.services) ? compose.services : {});

/** What a compose file asks of the host beyond its own folders and ports */
export function permissionsOf(compose: Obj, folders: string[], shipped: string[] = []): Set<string> {
  const out = new Set<string>();
  for (const def of Object.values(services(compose))) {
    if (def.network_mode === "host") out.add("host-network");
    if (def.pid === "host") out.add("host-pid");
    if (def.privileged === true) out.add("privileged");
    if (Array.isArray(def.devices) && def.devices.length) out.add("devices");
    if (Array.isArray(def.cap_add) && def.cap_add.length) out.add("capabilities");
  }
  for (const m of bindMounts(compose)) {
    const kind = mountKind(m, folders, shipped);
    if (kind !== "own") out.add(kind);
  }
  return out;
}

/** "own" — the app's folder or a folder the person picks; else the permission it needs */
export function mountKind(m: Mount, folders: string[], shipped: string[] = []): "own" | "docker" | "host-files" {
  // a relative path is the app's own file, or an error of its own (data goes to APP_DATA)
  if (shippedPath(m.source, shipped) || /^\.{1,2}(\/|$)/.test(m.source)) return "own";
  const use = varsIn(m.source)[0];
  if (use && m.source.startsWith("${") && (use.name === "APP_DATA" || folders.includes(use.name))) return "own";
  if (/^\/(var\/)?run\/docker\.sock$/.test(m.source)) return "docker";
  if (HARMLESS.has(m.source) && m.readOnly) return "own";
  return "host-files";
}

/** `./nginx.conf` or `./conf` when the app's folder has that file, or files in that folder */
export function shippedPath(source: string, shipped: string[]): boolean {
  if (!source.startsWith("./")) return false;
  const path = source.slice(2).replace(/\/+$/, "");
  if (!path || path.split("/").includes("..")) return false;
  return shipped.some((f) => f === path || f.startsWith(`${path}/`));
}

/** The container ports a service publishes, as numbers */
export function publishedTargets(def: Obj): number[] {
  const out: number[] = [];
  for (const p of Array.isArray(def.ports) ? def.ports : []) {
    if (typeof p === "string" || typeof p === "number") {
      const target = String(p).split("/")[0]!.split(":").pop()!;
      if (/^\d+$/.test(target)) out.push(Number(target));
    } else if (isObject(p) && p.target !== undefined) out.push(Number(p.target));
  }
  return out;
}

export function checkCompose(id: string, compose: unknown, hata: Obj | null, shipped: string[] = []): Problem[] {
  const file = `apps/${id}/compose.yml`;
  const problems: Problem[] = [];
  const say = (text: string) => problems.push({ file, text });
  if (!isObject(compose) || !isObject(compose.services) || !Object.keys(compose.services).length) {
    say("has no services");
    return problems;
  }
  if (compose.name !== undefined && compose.name !== id) say(`name "${compose.name}" is not the folder's name "${id}" (better leave it out)`);
  for (const key of Object.keys(compose)) if (key.startsWith("x-")) say(`${key}: what Hata needs goes into hata.yml`);

  for (const [name, def] of Object.entries(services(compose))) {
    if (!isObject(def)) {
      say(`service ${name} is not a mapping`);
      continue;
    }
    if (def.build !== undefined) say(`service ${name} builds an image; the store takes published images only`);
    if (typeof def.image !== "string" || !def.image) say(`service ${name} has no image`);
    else {
      const why = floating(def.image);
      if (why) say(`service ${name}: image ${def.image} ${why}`);
      if (def.image.includes("$")) say(`service ${name}: the image must be written out, not made of variables`);
    }
    if (def.container_name !== undefined) say(`service ${name} sets container_name; names come from the project, so an app can be installed twice`);
    if (def.env_file !== undefined) say(`service ${name} reads env_file; name the variables in environment instead (.env is Hata's)`);
    if (!["unless-stopped", "always", "on-failure"].includes(def.restart)) say(`service ${name} needs restart: unless-stopped (or always), or it stays down after a reboot`);
  }

  const settings: Obj[] = Array.isArray(hata?.settings) ? hata!.settings.filter(isObject) : [];
  const declared = new Set(settings.map((s) => s.name));
  const used = new Set<string>();
  for (const text of strings(compose)) {
    for (const v of varsIn(text)) {
      used.add(v.name);
      if (!(HATA_VARS as readonly string[]).includes(v.name) && !declared.has(v.name)) say(`\${${v.name}} is neither Hata's (${HATA_VARS.join(", ")}) nor in settings of hata.yml`);
      if (v.op === "") say(`\${${v.name}} has no default: write \${${v.name}:-…}, or \${${v.name}:?why} when there is none`);
      if (v.arg.includes("$")) say(`\${${v.name}}: a default must not name another variable`);
    }
  }
  for (const s of settings) if (typeof s.name === "string" && !used.has(s.name)) say(`setting ${s.name} is not used in the compose file`);

  const folders = settings.filter((s) => s.type === "folder").map((s) => String(s.name));
  for (const m of bindMounts(compose)) {
    if (/^[.~]/.test(m.source) && !shippedPath(m.source, shipped)) say(`service ${m.service} mounts ${m.source}, which is not a file of the app: data goes to \${APP_DATA:-.}/…`);
  }

  if (hata) {
    const wanted = permissionsOf(compose, folders, shipped);
    const given = isObject(hata.permissions) ? Object.keys(hata.permissions) : [];
    for (const p of wanted) if (!given.includes(p)) say(`needs the permission "${p}": say why in permissions of hata.yml`);
    for (const p of given) if (!wanted.has(p)) problems.push({ file: `apps/${id}/hata.yml`, text: `permission "${p}" is not needed by the compose file` });

    if (isObject(hata.web)) {
      const def = services(compose)[hata.web.service];
      if (!def) problems.push({ file: `apps/${id}/hata.yml`, text: `web.service "${hata.web.service}" is not a service of the compose file` });
      else if (def.network_mode !== "host" && !publishedTargets(def).includes(Number(hata.web.port))) {
        problems.push({ file: `apps/${id}/hata.yml`, text: `web.port ${hata.web.port} is not published by service ${hata.web.service}` });
      }
    }
  }
  return problems;
}

// --- hata.yml -----------------------------------------------------------------------------------------

/** A text in several languages: a plain string is English */
/** A line broken inside a paragraph: the page would show the break (a list item may start a line) */
export const brokenLine = (text: string): boolean => /[^\n]\n(?![\n\-*#>]|\d+\.)/.test(text.trimEnd());

function checkText(value: unknown, what: string, say: (t: string) => void, max = 0): void {
  if (typeof value === "string") {
    if (!value.trim()) say(`${what} is empty`);
    else if (max && value.length > max) say(`${what} is longer than ${max} characters`);
    else if (brokenLine(value)) say(`${what} breaks a line inside a paragraph: write it as a folded block (>)`);
    return;
  }
  if (!isObject(value)) return say(`${what} must be a text or { en: …, uk: … }`);
  if (typeof value.en !== "string" || !value.en.trim()) say(`${what} has no English (en)`);
  for (const [lang, text] of Object.entries(value)) {
    if (!LANG_RE.test(lang)) say(`${what}: "${lang}" is not a language code`);
    if (typeof text !== "string" || !text.trim()) say(`${what}.${lang} is empty`);
    else if (max && text.length > max) say(`${what}.${lang} is longer than ${max} characters`);
    else if (brokenLine(text)) say(`${what}.${lang} breaks a line inside a paragraph: write it as a folded block (>)`);
  }
}

/** The file's real type by its first bytes */
export function sniff(bytes: Uint8Array): "png" | "jpeg" | "webp" | "svg" | "" {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head)) return "svg";
  return "";
}

/** What makes an SVG more than a picture */
export function svgDanger(svg: string): string {
  if (/<script[\s>]/i.test(svg)) return "a script";
  if (/<foreignObject[\s>]/i.test(svg)) return "foreignObject";
  if (/\son[a-z]+\s*=/i.test(svg)) return "an event handler";
  for (const m of svg.matchAll(/\b(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) if (!m[1]!.startsWith("#")) return `a link to ${m[1]}`;
  if (/url\(\s*["']?(?!#)/i.test(svg)) return "an outside url()";
  return "";
}

export function checkIcon(icon: unknown, say: (t: string) => void): void {
  if (typeof icon !== "string") return say("icon is missing: a data: URI of an SVG, PNG or WebP");
  const m = /^data:image\/(svg\+xml|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(icon);
  if (!m) return say("icon must be data:image/(svg+xml|png|webp);base64,…");
  if (icon.length > MAX_ICON) say(`icon is ${icon.length} bytes, more than ${MAX_ICON}`);
  const bytes = Buffer.from(m[2]!, "base64");
  const real = sniff(bytes);
  const claimed = m[1] === "svg+xml" ? "svg" : m[1];
  if (real !== claimed) return say(`icon says ${m[1]} but holds ${real || "something else"}`);
  if (real === "svg") {
    const danger = svgDanger(bytes.toString("utf8"));
    if (danger) say(`icon: the SVG has ${danger}`);
  }
}

export interface AppFiles {
  id: string;
  /** Names of the files in `screenshots/` with their first bytes and size */
  screenshots: Map<string, { head: Uint8Array; size: number }>;
}

export function checkHata(app: AppFiles, hata: unknown, store: Obj): Problem[] {
  const file = `apps/${app.id}/hata.yml`;
  const problems: Problem[] = [];
  const say = (text: string) => problems.push({ file, text });
  if (!isObject(hata)) {
    say("is not a mapping");
    return problems;
  }
  for (const key of Object.keys(hata)) if (!HATA_KEYS.includes(key)) say(`unknown key "${key}"`);

  checkText(hata.title, "title", say, 40);
  checkText(hata.tagline, "tagline", say, 90);
  checkText(hata.description, "description", say);
  if (hata.notes !== undefined) checkText(hata.notes, "notes", say);
  const categories = isObject(store.categories) ? Object.keys(store.categories) : [];
  if (!categories.includes(hata.category)) say(`category "${hata.category}" is not in store.yml (${categories.join(", ")})`);
  if (typeof hata.developer !== "string" || !hata.developer.trim()) say("developer is missing");
  for (const key of ["website", "source"]) {
    if (hata[key] !== undefined && (typeof hata[key] !== "string" || !URL_RE.test(hata[key]))) say(`${key} must be an https:// address`);
  }
  if (typeof hata.website !== "string") say("website is missing");
  checkIcon(hata.icon, say);

  if (hata.screenshots !== undefined) {
    if (!Array.isArray(hata.screenshots)) say("screenshots must be a list of file names");
    else {
      if (hata.screenshots.length > MAX_SCREENSHOTS) say(`more than ${MAX_SCREENSHOTS} screenshots`);
      for (const name of hata.screenshots) {
        const shot = typeof name === "string" ? app.screenshots.get(name) : undefined;
        if (!shot) {
          say(`screenshot ${name} is not in screenshots/`);
          continue;
        }
        const kind = sniff(shot.head);
        if (!["png", "jpeg", "webp"].includes(kind)) say(`screenshot ${name} is not a PNG, JPEG or WebP`);
        if (shot.size > MAX_SCREENSHOT) say(`screenshot ${name} is ${Math.round(shot.size / 1024)} KB, more than ${MAX_SCREENSHOT / 1024}`);
      }
    }
  }
  const listed = new Set(Array.isArray(hata.screenshots) ? hata.screenshots : []);
  for (const name of app.screenshots.keys()) if (!listed.has(name)) say(`screenshots/${name} is not listed in screenshots`);

  if (hata.web !== undefined) {
    const web = hata.web;
    if (!isObject(web)) say("web must be { service, port, path }");
    else {
      for (const key of Object.keys(web)) if (!["service", "port", "path", "scheme"].includes(key)) say(`web: unknown key "${key}"`);
      if (typeof web.service !== "string") say("web.service is missing");
      if (!Number.isInteger(web.port) || web.port < 1 || web.port > 65535) say("web.port must be the container's port, a number");
      if (web.path !== undefined && (typeof web.path !== "string" || !web.path.startsWith("/"))) say("web.path must start with /");
      if (web.scheme !== undefined && !["http", "https"].includes(web.scheme)) say("web.scheme is http or https");
    }
  }

  if (hata.settings !== undefined) {
    if (!Array.isArray(hata.settings)) say("settings must be a list");
    else {
      const seen = new Set<string>();
      hata.settings.forEach((s: unknown, i: number) => {
        const at = `settings[${i}]`;
        if (!isObject(s)) return say(`${at} is not a mapping`);
        const name = typeof s.name === "string" ? s.name : "";
        const where = name || at;
        for (const key of Object.keys(s)) if (!["name", "type", "label", "hint", "default", "required", "options", "length", "advanced"].includes(key)) say(`${where}: unknown key "${key}"`);
        if (!VAR_RE.test(name)) say(`${at}: name must be like WEB_PORT`);
        if ((DEFAULT_VARS as readonly string[]).includes(name)) say(`${where}: ${name} is Hata's own variable`);
        if (seen.has(name)) say(`${where} is listed twice`);
        seen.add(name);
        if (!SETTING_TYPES.includes(s.type)) say(`${where}: type must be one of ${SETTING_TYPES.join(", ")}`);
        checkText(s.label, `${where}.label`, say, 60);
        if (s.hint !== undefined) checkText(s.hint, `${where}.hint`, say);
        for (const key of ["required", "advanced"]) if (s[key] !== undefined && typeof s[key] !== "boolean") say(`${where}.${key} is true or false`);
        if (s.default !== undefined) {
          if (!["string", "number", "boolean"].includes(typeof s.default)) say(`${where}.default must be a plain value`);
          for (const v of varsIn(String(s.default))) if (!(DEFAULT_VARS as readonly string[]).includes(v.name)) say(`${where}.default names \${${v.name}}; only ${DEFAULT_VARS.join(", ")} can be used there`);
        }
        if (s.type === "secret") {
          if (s.default !== undefined) say(`${where}: a secret is made at install, it has no default`);
          if (s.length !== undefined && (!Number.isInteger(s.length) || s.length < 12 || s.length > 128)) say(`${where}.length is 12…128`);
        } else if (s.length !== undefined) say(`${where}.length is for secrets`);
        if (s.type === "port" && s.default !== undefined && !(Number.isInteger(Number(s.default)) && Number(s.default) > 0 && Number(s.default) < 65536)) say(`${where}.default is not a port`);
        if (s.type === "switch" && s.default !== undefined && typeof s.default !== "boolean") say(`${where}.default of a switch is true or false`);
        if (s.type === "choice") {
          if (!Array.isArray(s.options) || !s.options.length) say(`${where}: a choice needs options`);
          else {
            for (const o of s.options) {
              if (!isObject(o) || !["string", "number"].includes(typeof o.value)) say(`${where}: an option is { value, label }`);
              else checkText(o.label, `${where} option ${o.value}`, say, 60);
            }
            if (s.default !== undefined && !s.options.some((o: Obj) => isObject(o) && String(o.value) === String(s.default))) say(`${where}.default is not one of the options`);
          }
        } else if (s.options !== undefined) say(`${where}.options are for a choice`);
      });
    }
  }

  if (hata.permissions !== undefined) {
    if (!isObject(hata.permissions)) say("permissions must be { <permission>: why }");
    else for (const [p, why] of Object.entries(hata.permissions)) {
      if (!(PERMISSIONS as readonly string[]).includes(p)) say(`permission "${p}" is not one of ${PERMISSIONS.join(", ")}`);
      checkText(why, `permissions.${p}`, say);
    }
  }
  return problems;
}

export interface Shipped {
  /** Relative to the app's folder */
  name: string;
  bytes: Uint8Array;
  link: boolean;
}

/** The app's other files: configs it mounts, `.env.example` for those who run it without Hata */
export function checkShipped(id: string, files: Shipped[], compose: unknown): Problem[] {
  const problems: Problem[] = [];
  let total = 0;
  for (const f of files) {
    const say = (text: string) => problems.push({ file: `apps/${id}/${f.name}`, text });
    total += f.bytes.length;
    if (f.link) say("is a link; a file of the app is a plain file");
    if (RESERVED.has(f.name)) say("is written by Hata and cannot come from the store");
    if (!f.link && textOf(f.bytes) === null) say("is not text (UTF-8): only text files go with an app");
    if (f.name === ".env.example" && isObject(compose)) {
      const used = new Set<string>();
      for (const text of strings(compose)) for (const v of varsIn(text)) used.add(v.name);
      for (const line of textOf(f.bytes)?.split("\n") ?? []) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (m && !used.has(m[1]!)) say(`${m[1]} is not a variable of the compose file`);
      }
    }
  }
  if (total > MAX_SHIPPED) problems.push({ file: `apps/${id}`, text: `its other files are ${Math.round(total / 1024)} KB together, more than ${MAX_SHIPPED / 1024}` });
  return problems;
}

/** The text of a file, or null when it is not UTF-8 text */
export function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function checkStore(store: unknown, apps: string[]): Problem[] {
  const problems: Problem[] = [];
  const say = (text: string) => problems.push({ file: "store.yml", text });
  if (!isObject(store)) {
    say("is not a mapping");
    return problems;
  }
  checkText(store.name, "name", say, 40);
  if (!isObject(store.categories) || !Object.keys(store.categories).length) say("categories are missing");
  else for (const [id, name] of Object.entries(store.categories)) {
    if (!APP_ID_RE.test(id)) say(`category "${id}" must be lowercase letters, digits and dashes`);
    checkText(name, `categories.${id}`, say, 30);
  }
  if (store.recommended !== undefined) {
    if (!Array.isArray(store.recommended)) say("recommended must be a list of apps");
    else for (const id of store.recommended) if (!apps.includes(id)) say(`recommended app "${id}" is not in apps/`);
  }
  return problems;
}

// --- Registries ---------------------------------------------------------------------------------------

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** A GET against a registry, with the anonymous token it asks for */
async function registryGet(ref: ImageRef, path: string, accept: string): Promise<Response> {
  const host = ref.registry === "docker.io" ? "registry-1.docker.io" : ref.registry;
  const url = `https://${host}/v2/${ref.repo}/${path}`;
  let res = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    const param = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(challenge)?.[1];
    const realm = param("realm");
    if (!realm) return res;
    const q = new URLSearchParams();
    const service = param("service");
    if (service) q.set("service", service);
    q.set("scope", param("scope") ?? `repository:${ref.repo}:pull`);
    const t = await fetch(`${realm}?${q}`, { signal: AbortSignal.timeout(20_000) });
    if (!t.ok) return t;
    const body = (await t.json()) as { token?: string; access_token?: string };
    res = await fetch(url, { headers: { accept, authorization: `Bearer ${body.token ?? body.access_token}` }, signal: AbortSignal.timeout(20_000) });
  }
  return res;
}

/** `arm64/v8` is plain arm64: the variant is the only one there is */
const platformName = (p: Obj) => (p.variant && !(p.architecture === "arm64" && p.variant === "v8") ? `${p.architecture}/${p.variant}` : String(p.architecture));

/** The Linux architectures an image is published for (`amd64`, `arm64`, `arm/v7`, …) */
export async function platformsOf(image: string): Promise<string[]> {
  const ref = parseImage(image);
  const res = await registryGet(ref, `manifests/${ref.digest || ref.tag || "latest"}`, MANIFEST_TYPES);
  if (!res.ok) throw new Error(`${image}: the registry answered ${res.status}`);
  const manifest = (await res.json()) as Obj;
  if (Array.isArray(manifest.manifests)) {
    const out = manifest.manifests
      .map((m: Obj) => m.platform)
      .filter((p: Obj | undefined) => p && p.os === "linux" && p.architecture !== "unknown")
      .map(platformName);
    return [...new Set<string>(out)].sort();
  }
  const digest = manifest.config?.digest;
  if (!digest) throw new Error(`${image}: the manifest names no config`);
  const config = await registryGet(ref, `blobs/${digest}`, "application/json");
  if (!config.ok) throw new Error(`${image}: the registry answered ${config.status} for the config`);
  return [platformName((await config.json()) as Obj)];
}

/** Architectures every image of the app has */
export function common(lists: string[][]): string[] {
  if (!lists.length) return [];
  return lists.reduce((a, b) => a.filter((x) => b.includes(x))).sort();
}

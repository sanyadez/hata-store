import { describe, expect, test } from "bun:test";
import { bindMounts, brokenLine, checkCompose, checkHata, checkIcon, checkShipped, common, fill, floating, parseImage, permissionsOf, shippedPath, splitVolume, svgDanger, varsIn } from "../scripts/lib.ts";

const svg = (body: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`).toString("base64")}`;
const store = { categories: { media: { en: "Media" } } };
const app = { id: "demo", screenshots: new Map() };
const hata = (extra: object = {}) => ({
  title: "Demo", tagline: "Shows things", description: "A demo.", category: "media", developer: "Me",
  website: "https://example.org", icon: svg("<circle r='1'/>"), ...extra,
});
const compose = (service: object, top: object = {}) => ({ services: { demo: { image: "nginx:1.27", restart: "unless-stopped", ...service } }, ...top });
const texts = (p: { text: string }[]) => p.map((x) => x.text);

describe("variables", () => {
  test("are read with their operators, $$ is a dollar", () => {
    expect(varsIn("${A:-x}/$B ${C:?why} $$D ${E}")).toEqual([
      { name: "A", op: ":-", arg: "x" }, { name: "B", op: "", arg: "" }, { name: "C", op: ":?", arg: "why" }, { name: "E", op: "", arg: "" },
    ]);
  });
  test("are filled as docker compose does", () => {
    expect(fill("${A:-.}/x", {})).toBe("./x");
    expect(fill("${A:-.}/x", { A: "/data" })).toBe("/data/x");
    expect(fill("${A-z}", { A: "" })).toBe("");
    expect(fill("$$HOME", {})).toBe("$HOME");
  });
  test("a volume splits outside ${…}", () => {
    expect(splitVolume("${APP_DATA:-.}/c:/config:ro")).toEqual(["${APP_DATA:-.}/c", "/config", "ro"]);
  });
});

describe("images", () => {
  test("references", () => {
    expect(parseImage("nginx")).toEqual({ registry: "docker.io", repo: "library/nginx", tag: "", digest: "" });
    expect(parseImage("ghcr.io/a/b:1.2@sha256:ff")).toEqual({ registry: "ghcr.io", repo: "a/b", tag: "1.2", digest: "sha256:ff" });
    expect(parseImage("localhost:5000/x:3").registry).toBe("localhost:5000");
    expect(parseImage("me/app:2").repo).toBe("me/app");
  });
  test("moving tags", () => {
    expect(floating("nginx")).toContain("no tag");
    expect(floating("nginx:latest")).toContain("latest");
    expect(floating("nginx:1.27")).toBe("");
    expect(floating("valkey:9@sha256:ff")).toBe("");
  });
  test("common architectures", () => {
    expect(common([["amd64", "arm64"], ["arm64", "amd64", "arm/v7"]])).toEqual(["amd64", "arm64"]);
  });
});

describe("the compose file", () => {
  test("a good one", () => {
    const c = compose({ ports: ["${WEB_PORT:-80}:80"], volumes: ["${APP_DATA:-.}/data:/data"] });
    expect(texts(checkCompose("demo", c, hata({ web: { service: "demo", port: 80 }, settings: [{ name: "WEB_PORT", type: "port", label: "Port" }] })))).toEqual([]);
  });
  test("what it may not do", () => {
    const c = compose({ image: "nginx:latest", container_name: "x", env_file: ".env", restart: "no", volumes: ["./data:/data"], environment: { A: "${UNKNOWN}" } }, { "x-casaos": {} });
    const got = texts(checkCompose("demo", c, hata())).join("\n");
    for (const part of ["moving tag", "container_name", "env_file", "restart", "./data", "UNKNOWN} is neither", "UNKNOWN} has no default", "x-casaos"]) expect(got).toContain(part);
  });
  test("a setting nobody uses, a web port nobody publishes", () => {
    const got = texts(checkCompose("demo", compose({}), hata({ web: { service: "demo", port: 80 }, settings: [{ name: "X", type: "text", label: "X" }] })));
    expect(got).toContain("setting X is not used in the compose file");
    expect(got).toContain("web.port 80 is not published by service demo");
  });
  test("permissions are what the file does", () => {
    const c = compose({ network_mode: "host", volumes: ["/var/run/docker.sock:/var/run/docker.sock", "/etc/localtime:/etc/localtime:ro", "/srv:/srv", "${MEDIA:-./m}:/media"] });
    expect([...permissionsOf(c, ["MEDIA"])].sort()).toEqual(["docker", "host-files", "host-network"]);
    expect(bindMounts(c)).toHaveLength(4);
    const got = texts(checkCompose("demo", c, hata({ permissions: { privileged: "why" }, settings: [{ name: "MEDIA", type: "folder", label: "M" }] })));
    expect(got).toContain('needs the permission "docker": say why in permissions of hata.yml');
    expect(got).toContain('permission "privileged" is not needed by the compose file');
  });
});

describe("hata.yml", () => {
  test("a good one", () => expect(texts(checkHata(app, hata(), store))).toEqual([]));
  test("texts need English", () => {
    expect(texts(checkHata(app, hata({ title: { uk: "Демо" } }), store))).toContain("title has no English (en)");
  });
  test("settings", () => {
    const got = texts(checkHata(app, hata({ settings: [
      { name: "lower", type: "text", label: "L" },
      { name: "S", type: "secret", label: "S", default: "x" },
      { name: "C", type: "choice", label: "C", default: "z", options: [{ value: "a", label: "A" }] },
      { name: "D", type: "folder", label: "D", default: "${HOME}/x" },
      { name: "APP_DATA", type: "text", label: "A" },
    ] }), store)).join("\n");
    for (const part of ["name must be like", "a secret is made at install", "default is not one of the options", "${HOME}", "Hata's own variable"]) expect(got).toContain(part);
  });
  test("unknown keys and categories", () => {
    const got = texts(checkHata(app, hata({ titel: "x", category: "nope" }), store));
    expect(got).toContain('unknown key "titel"');
    expect(got.some((t) => t.startsWith('category "nope"'))).toBe(true);
  });
});

describe("icons", () => {
  const problems = (icon: unknown) => {
    const out: string[] = [];
    checkIcon(icon, (t) => out.push(t));
    return out;
  };
  test("an SVG picture passes", () => expect(problems(svg("<path d='M0 0'/>"))).toEqual([]));
  test("the claimed type must be the real one", () => {
    expect(problems(`data:image/png;base64,${Buffer.from("<svg></svg>").toString("base64")}`)[0]).toContain("holds svg");
  });
  test("an SVG that is more than a picture", () => {
    expect(svgDanger("<svg><script>1</script></svg>")).toBe("a script");
    expect(svgDanger('<svg onload="x()">')).toBe("an event handler");
    expect(svgDanger('<svg><image href="https://x/y.png"/></svg>')).toContain("a link");
    expect(svgDanger('<svg><path fill="url(#a)"/></svg>')).toBe("");
  });
  test("a link is not an icon", () => expect(problems("https://example.org/x.svg")[0]).toContain("data:image"));
});

describe("the app's other files", () => {
  const file = (name: string, text: string, link = false) => ({ name, bytes: new TextEncoder().encode(text), link });
  test("a config it mounts is its own", () => {
    const c = compose({ volumes: ["./nginx.conf:/etc/nginx/nginx.conf:ro", "./conf:/conf", "./data:/data"] });
    const got = texts(checkCompose("demo", c, hata(), ["nginx.conf", "conf/a.conf"]));
    expect(got).toEqual(["service demo mounts ./data, which is not a file of the app: data goes to ${APP_DATA:-.}/…"]);
    expect(shippedPath("./../x", ["../x"])).toBe(false);
  });
  test("what cannot go with an app", () => {
    const got = texts(checkShipped("demo", [file(".env", "A=1"), file("bin", "\0\x01"), file("l", "", true), file(".env.example", "# NOTE=x\nWEB_PORT=80\nOTHER=1\n")], compose({ ports: ["${WEB_PORT:-80}:80"] })));
    expect(got).toEqual([
      "is written by Hata and cannot come from the store",
      "is not text (UTF-8): only text files go with an app",
      "is a link; a file of the app is a plain file",
      "OTHER is not a variable of the compose file",
    ]);
  });
});

test("a line broken inside a paragraph is told, a list is not", () => {
  expect(brokenLine("One line\nand the next")).toBe(true);
  expect(brokenLine("A paragraph.\n\nAnother one.\n")).toBe(false);
  expect(brokenLine("Before:\n- one\n- two\n1. three")).toBe(false);
});

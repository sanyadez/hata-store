/**
 * Prints a picture as the data: URI the icon of hata.yml takes.
 *
 *   bun scripts/icon.ts logo.svg
 *
 * An SVG is made smaller first: comments, the XML prologue and whitespace between tags go.
 */
import { readFileSync } from "node:fs";
import { MAX_ICON, sniff, svgDanger } from "./lib.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: bun scripts/icon.ts <file>");
let bytes: Uint8Array = readFileSync(path);
const kind = sniff(bytes);
if (!kind || kind === "jpeg") throw new Error(`${path}: an icon is an SVG, PNG or WebP`);
if (kind === "svg") {
  const svg = new TextDecoder()
    .decode(bytes)
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .trim();
  const danger = svgDanger(svg);
  if (danger) throw new Error(`${path}: the SVG has ${danger}`);
  bytes = new TextEncoder().encode(svg);
}
const uri = `data:image/${kind === "svg" ? "svg+xml" : kind};base64,${Buffer.from(bytes).toString("base64")}`;
if (uri.length > MAX_ICON) throw new Error(`${path}: ${uri.length} bytes as a URI, more than ${MAX_ICON}`);
console.log(uri);

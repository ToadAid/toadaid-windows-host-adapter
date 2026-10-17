// WA-P1B native proof: pure report helpers (no I/O, no Windows calls).
// Used by scripts/windows-observation-native-proof.mjs and by unit tests.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const WA_P1B_PROOF_SCHEMA =
  "toadaid.windows-observation-native-proof.v1-proposed";
export const WA_P1B_CLASSIFICATIONS = Object.freeze([
  "PASS",
  "FAIL",
  "BLOCKED",
  "UNSUPPORTED",
]);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Canonical JSON: sorted keys, no whitespace. Deterministic for equal inputs. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(",")}}`;
}

export function proofCase(id, classification, facts, reason) {
  if (!/^[A-Z][A-Z0-9-]{1,40}$/.test(id)) {
    throw new TypeError(`case id invalid: ${id}`);
  }
  if (!WA_P1B_CLASSIFICATIONS.includes(classification)) {
    throw new TypeError(`classification invalid: ${classification}`);
  }
  return Object.freeze({
    id,
    classification,
    facts: Object.freeze({ ...(facts ?? {}) }),
    reason: String(reason ?? "").slice(0, 240),
  });
}

export function buildProofReport({ subject, environment, cases }) {
  const ids = new Set();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);
  }
  const summary = { PASS: 0, FAIL: 0, BLOCKED: 0, UNSUPPORTED: 0 };
  for (const c of cases) summary[c.classification] += 1;
  return Object.freeze({
    schema: WA_P1B_PROOF_SCHEMA,
    subject,
    environment,
    authority: "NONE",
    providerEvidenceIsAuthority: false,
    interactionReady: false,
    summary,
    cases,
  });
}

/**
 * Refuses a report that carries any operator-private string (absolute paths,
 * account names, home/temp directories, raw UI strings that are not synthetic).
 */
export function assertRedacted(reportText, forbidden) {
  for (const value of forbidden) {
    if (typeof value === "string" && value.length >= 3 &&
      reportText.toLowerCase().includes(value.toLowerCase())) {
      throw new Error("proof report contains an operator-private string");
    }
  }
  if (/[A-Za-z]:(\\\\|\/)|\\\\\\\\|\/Users\/|\/home\/|\/tmp\//.test(reportText)) {
    throw new Error("proof report contains a filesystem path");
  }
}

/**
 * Splits a growing stdout buffer into COMPLETE newline-terminated lines.
 * The trailing partial line (no newline yet) is returned as `rest` and is
 * never parsed. A trailing CR before the LF is dropped.
 */
export function splitCompleteLines(buffer) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = buffer.indexOf("\n", start);
    if (nl < 0) break;
    let line = buffer.slice(start, nl);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
    start = nl + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/**
 * Parses one exact-prefixed record (`<PREFIX> <json-object>`). Returns null for
 * any line that does not start with the exact prefix; throws on a prefixed line
 * whose body is not a single JSON object (a complete but corrupt record).
 */
export function parsePrefixedRecord(line, prefix) {
  if (!line.startsWith(`${prefix} `)) return null;
  const value = JSON.parse(line.slice(prefix.length + 1));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${prefix} record is not a JSON object`);
  }
  return value;
}

/**
 * Finds the single tree element bound to a fixture-reported screen rectangle
 * (exact geometry, optional class pattern). Returns { element } when exactly
 * one matches, or { ambiguous: count } otherwise. Never searches by value.
 */
export function bindFixtureElement(elements, rect, classPattern) {
  const hits = elements.filter((e) => e && e.bounds &&
    Math.round(e.bounds.left) === rect.left && Math.round(e.bounds.top) === rect.top &&
    Math.round(e.bounds.left + e.bounds.width) === rect.right && Math.round(e.bounds.top + e.bounds.height) === rect.bottom &&
    (classPattern === undefined || e.className === null || e.className === undefined || classPattern.test(String(e.className))));
  return hits.length === 1 ? { element: hits[0] } : { ambiguous: hits.length };
}

/** Minimal PNG reader: IHDR + 8-bit RGB/RGBA non-interlaced pixel sampling. */
export function readPng(bytes) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(sig)) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let ihdr = null;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }
  if (ihdr === null) throw new Error("PNG without IHDR");
  return {
    ...ihdr,
    pixel(x, y) {
      if (ihdr.bitDepth !== 8 || ihdr.interlace !== 0 ||
        (ihdr.colorType !== 2 && ihdr.colorType !== 6)) {
        throw new Error("unsupported PNG pixel format");
      }
      if (x < 0 || y < 0 || x >= ihdr.width || y >= ihdr.height) {
        throw new RangeError("pixel outside image");
      }
      const raw = this._raw ??= inflateSync(Buffer.concat(idat));
      const bpp = ihdr.colorType === 6 ? 4 : 3;
      const stride = ihdr.width * bpp;
      const rows = this._rows ??= unfilter(raw, ihdr.height, stride, bpp);
      const p = rows[y].subarray(x * bpp, x * bpp + bpp);
      return { r: p[0], g: p[1], b: p[2] };
    },
  };
}

function unfilter(raw, height, stride, bpp) {
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error("bad PNG filter");
      line[i] = (line[i] + add) & 0xff;
    }
    rows.push(line);
    prev = line;
  }
  return rows;
}

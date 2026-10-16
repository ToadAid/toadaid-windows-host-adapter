import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";

// The WA-P1B harness helpers are plain .mjs under scripts/; load them at runtime.
const helperUrl = new URL("../../scripts/wa-p1b/proofReport.mjs", import.meta.url).href;
type Helpers = {
  WA_P1B_PROOF_SCHEMA: string;
  canonicalJson(value: unknown): string;
  proofCase(id: string, classification: string, facts?: object, reason?: string): { id: string; classification: string };
  buildProofReport(input: { subject: object; environment: object; cases: readonly object[] }): { summary: Record<string, number>; authority: string; providerEvidenceIsAuthority: boolean; interactionReady: boolean };
  assertRedacted(text: string, forbidden: readonly string[]): void;
  readPng(bytes: Buffer): { width: number; height: number; pixel(x: number, y: number): { r: number; g: number; b: number } };
};
const load = async () => (await import(helperUrl)) as Helpers;

function png(width: number, height: number, rgba: (x: number, y: number) => [number, number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = (y: number) => Buffer.from(Array.from({ length: width * 4 }, (_, i) => rgba(Math.floor(i / 4), y)[i % 4] ?? 0));
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const line = raw(y);
    if (y % 2 === 0) {
      rows.push(Buffer.concat([Buffer.from([0]), line])); // filter None
    } else {
      const prev = raw(y - 1);
      rows.push(Buffer.concat([Buffer.from([2]), Buffer.from(line.map((v, i) => (v - (prev[i] ?? 0)) & 0xff))])); // filter Up
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("WA-P1B report: deterministic canonical JSON, closed classification set, authority always NONE", async () => {
  const h = await load();
  assert.equal(h.canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }], u: undefined }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.throws(() => h.proofCase("C01-X", "PASSED"), /classification invalid/);
  assert.throws(() => h.proofCase("bad id", "PASS"), /case id invalid/);
  const cases = [h.proofCase("C01-A", "PASS"), h.proofCase("U01-B", "UNSUPPORTED"), h.proofCase("U02-C", "BLOCKED")];
  const report = h.buildProofReport({ subject: {}, environment: {}, cases });
  assert.deepEqual(report.summary, { PASS: 1, FAIL: 0, BLOCKED: 1, UNSUPPORTED: 1 });
  assert.equal(report.authority, "NONE");
  assert.equal(report.providerEvidenceIsAuthority, false);
  assert.equal(report.interactionReady, false);
  assert.throws(() => h.buildProofReport({ subject: {}, environment: {}, cases: [cases[0]!, cases[0]!] }), /duplicate case id/);
});

test("WA-P1B report: redaction refuses paths and operator-private strings", async () => {
  const h = await load();
  const clean = JSON.stringify({ case: "C01", sha256: "a".repeat(64) });
  assert.doesNotThrow(() => h.assertRedacted(clean, ["Numair", "C:\\Users\\Numair"]));
  assert.throws(() => h.assertRedacted(JSON.stringify({ p: "C:\\Users\\someone\\x" }), []), /filesystem path/);
  assert.throws(() => h.assertRedacted(JSON.stringify({ p: "C:/Users/someone/x" }), []), /filesystem path/);
  assert.throws(() => h.assertRedacted(JSON.stringify({ p: "\\\\server\\share" }), []), /filesystem path/);
  assert.throws(() => h.assertRedacted(JSON.stringify({ who: "numair" }), ["Numair"]), /operator-private/);
});

test("WA-P1B report: the PNG reader returns real dimensions and pixels (None + Up filters)", async () => {
  const h = await load();
  const bytes = png(5, 4, (x, y) => (x === 3 && y === 2 ? [255, 0, 255, 255] : [32, 96, 64, 255]));
  const image = h.readPng(bytes);
  assert.equal(image.width, 5);
  assert.equal(image.height, 4);
  assert.deepEqual(image.pixel(3, 2), { r: 255, g: 0, b: 255 });
  assert.deepEqual(image.pixel(0, 0), { r: 32, g: 96, b: 64 });
  assert.deepEqual(image.pixel(4, 3), { r: 32, g: 96, b: 64 });
  assert.throws(() => image.pixel(5, 0), RangeError);
  assert.throws(() => h.readPng(Buffer.from("not a png at all, definitely not")), /not a PNG/);
});

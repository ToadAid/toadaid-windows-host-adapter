import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  WINDOWS_PROVIDER_PROTOCOL_VERSION,
  decodeProviderResponseFrame,
} from "../src/index.js";

// Native C# skeleton <-> strict Node decoder interop. Runs only on Windows with
// TOADAID_NATIVE_CSHARP_WORKER pointing at a built skeleton executable (built
// from native/ToadAid.WindowsWorker). One-shot frames; no observation.
const EXE = process.env.TOADAID_NATIVE_CSHARP_WORKER;
const SKIP = process.platform === "win32" && typeof EXE === "string" && EXE.length > 0
  ? false
  : "native Windows + TOADAID_NATIVE_CSHARP_WORKER required";

type Run = { exitCode: number | null; stdout: Buffer };
function run(input: Buffer): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE!, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("skeleton timed out")); }, 15_000);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout: Buffer.concat(chunks) }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const frame = (o: Record<string, unknown> = {}) => JSON.stringify({ protocolVersion: WINDOWS_PROVIDER_PROTOCOL_VERSION, requestId: "req-1", generationId: "gen-1", kind: "HANDSHAKE", payload: {}, ...o });
const lf = (s: string) => Buffer.from(`${s}\n`, "utf8");

function decodeStrict(r: Run) {
  // The response itself must obey the strict framing law: one line, LF only.
  assert.equal(r.stdout.includes(0x0d), false, "response contains no CR");
  assert.equal(r.stdout.filter((b) => b === 0x0a).length, 1, "exactly one LF");
  return decodeProviderResponseFrame(r.stdout);
}

test("native C# skeleton: HANDSHAKE and HEALTH decode under the strict Node v1 decoder", { skip: SKIP }, async () => {
  for (const kind of ["HANDSHAKE", "HEALTH"]) {
    const r = await run(lf(frame({ kind })));
    const d = decodeStrict(r);
    assert.equal(r.exitCode, 0);
    assert.equal(d.status, "OK");
    assert.equal(d.requestId, "req-1");
    assert.equal(d.generationId, "gen-1");
    assert.deepEqual(d.payload, { mutationImplemented: false, supportedKinds: ["HANDSHAKE", "HEALTH"], workerKind: "toadaid-windows-native-skeleton" });
  }
});

test("native C# skeleton: OBSERVE stays UNIMPLEMENTED_KIND", { skip: SKIP }, async () => {
  const r = await run(lf(frame({ kind: "OBSERVE" })));
  const d = decodeStrict(r);
  assert.equal(r.exitCode, 2);
  assert.equal(d.status, "ERROR");
  assert.equal(d.error?.code, "UNIMPLEMENTED_KIND");
});

test("native C# skeleton: strict framing and payload vectors are refused with typed, strictly-decodable errors", { skip: SKIP }, async () => {
  const base = frame({ payload: { a: 1 } });
  const invalidUtf8 = lf(frame({ payload: { s: "X" } }));
  invalidUtf8[invalidUtf8.indexOf("X")] = 0xff;
  const vectors: [string, Buffer, string][] = [
    ["duplicate top-level key", lf(frame().replace('"kind":"HANDSHAKE"', '"kind":"HANDSHAKE","kind":"HEALTH"')), "MALFORMED_REQUEST"],
    ["duplicate payload key", lf(base.replace('{"a":1}', '{"a":1,"a":2}')), "MALFORMED_REQUEST"],
    ["escaped duplicate payload key", lf(base.replace('{"a":1}', '{"a":1,"\\u0061":2}')), "MALFORMED_REQUEST"],
    ["nested duplicate key", lf(base.replace('{"a":1}', '{"o":{"k":1,"k":2}}')), "MALFORMED_REQUEST"],
    ["__proto__ payload key", lf(base.replace('{"a":1}', '{"__proto__":{"p":1}}')), "MALFORMED_REQUEST"],
    ["payload nested too deep", lf(base.replace('{"a":1}', '{"a":[[[[[[[[[[1]]]]]]]]]]}')), "MALFORMED_REQUEST"],
    ["invalid UTF-8", invalidUtf8, "FRAME_ENCODING_INVALID"],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lf(frame())]), "FRAME_ENCODING_INVALID"],
    ["CRLF request", Buffer.from(`${frame()}\r\n`, "utf8"), "FRAME_MULTILINE"],
    ["two lines", Buffer.concat([lf(frame()), lf(frame())]), "FRAME_MULTILINE"],
    ["unterminated", Buffer.from(frame(), "utf8"), "FRAME_UNTERMINATED"],
    ["empty", Buffer.alloc(0), "FRAME_MISSING"],
    ["oversized", lf(frame({ payload: { s: "x".repeat(300_000) } })), "FRAME_TOO_LARGE"],
    ["unknown field", lf(frame({ extra: 1 })), "MALFORMED_REQUEST"],
    ["wrong version", lf(frame({ protocolVersion: "toadaid.windows-provider-worker.v0" })), "PROTOCOL_MISMATCH"],
    ["invalid id", lf(frame({ requestId: "bad id" })), "IDENTITY_INVALID"],
    ["non-string kind", lf(frame({ kind: 7 })), "MALFORMED_REQUEST"],
  ];
  for (const [name, input, code] of vectors) {
    const r = await run(input);
    const d = decodeStrict(r);
    assert.equal(r.exitCode, 2, `${name}: exit code`);
    assert.equal(d.status, "ERROR", `${name}: status`);
    assert.equal(d.error?.code, code, `${name}: code`);
  }
});

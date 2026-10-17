import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_OBSERVATION_CONTRACT_IDS,
  DESKTOP_OBSERVATION_TOOL_NAMES,
  desktopObservationParametersSha256,
  normalizeDesktopObservationRequest,
} from "@toadaid/agent-capabilities";
import type {
  DesktopObservationAdapterRequest,
  DesktopObservationCapabilityId,
  DesktopObservationRequest,
} from "@toadaid/agent-capabilities";

import {
  createPowerShellWindowsObservationWorker,
  createWindowsDesktopObservationAdapter,
  defaultWindowsPowerShellPath,
} from "../src/windowsObservationAdapter.js";
import type { WindowsDesktopObservationAdapter } from "../src/windowsObservationAdapter.js";

// WA-P1A.2 NATIVE regression tests for F1-F4.
// - "pure" tests dot-source the real worker and need native Windows PowerShell
//   (no window, no screen, no UI Automation): they run on any win32 host.
// - "live" tests open ONE disposable synthetic fixture window and observe it
//   through the real adapter + worker. They run only when the operator opts in
//   with TOADAID_NATIVE_OBSERVATION_TESTS=1 (never unattended, never in CI).
// Off Windows every test here is skipped: Linux cannot provide this evidence.

const WIN = process.platform === "win32";
const LIVE = WIN && process.env.TOADAID_NATIVE_OBSERVATION_TESTS === "1";
const PURE_SKIP = WIN ? false : "native Windows PowerShell required";
const LIVE_SKIP = LIVE ? false : "set TOADAID_NATIVE_OBSERVATION_TESTS=1 on native Windows with the operator present";
const WORKER = fileURLToPath(new URL("../../worker/windows-observation.ps1", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../test/fixtures/native-safety-fixture.ps1", import.meta.url));
const CHILD_TIMEOUT_MS = 60_000;

const sha256 = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");

function runPowerShellFile(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(defaultWindowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("powershell timed out")); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => { out += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { if (err.length < 8_192) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out); else reject(new Error(`powershell exit ${code}: ${err.slice(0, 400)}`));
    });
  });
}

/** Dot-sources the real worker (functions only) and evaluates `expression` per case. */
async function dotSource(cases: readonly unknown[], expression: string): Promise<unknown[]> {
  const dir = await mkdtemp(join(tmpdir(), "wa-p1a2-pure-"));
  try {
    const casesFile = join(dir, "cases.json");
    const scriptFile = join(dir, "probe.ps1");
    await writeFile(casesFile, JSON.stringify(cases), "utf8");
    await writeFile(scriptFile, [
      `. '${WORKER.replace(/'/g, "''")}'`,
      `$cases = Get-Content -Raw -LiteralPath '${casesFile.replace(/'/g, "''")}' | ConvertFrom-Json`,
      `$out = @(foreach ($c in $cases) { ${expression} })`,
      `[Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress -Depth 4))`,
    ].join("\n"), "utf8");
    return JSON.parse(await runPowerShellFile(scriptFile, [], CHILD_TIMEOUT_MS)) as unknown[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const D = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test("WA-P1A.2 F4 (native, pure): a region must lie entirely on displays — single, multi, negative and gapped layouts", { skip: PURE_SKIP }, async () => {
  const one = [D(0, 0, 1600, 900)];
  const cases = [
    { name: "inside one display", displays: one, region: D(100, 100, 500, 400), expect: true },
    { name: "whole display", displays: one, region: D(0, 0, 1600, 900), expect: true },
    { name: "fully outside", displays: one, region: D(1700, 0, 1800, 100), expect: false },
    { name: "partially past the right edge", displays: one, region: D(1590, 0, 1650, 50), expect: false },
    { name: "partially above the top", displays: one, region: D(10, -20, 100, 50), expect: false },
    { name: "spans two adjacent displays", displays: [D(0, 0, 1920, 1080), D(1920, 0, 3840, 1080)], region: D(1800, 100, 2100, 300), expect: true },
    { name: "spans into the gap of vertically offset displays", displays: [D(0, 0, 1920, 1080), D(1920, 200, 3840, 1280)], region: D(1800, 100, 2100, 300), expect: false },
    { name: "negative-coordinate display on the left", displays: [D(-1920, 0, 0, 1080), D(0, 0, 1920, 1080)], region: D(-100, 10, 100, 200), expect: true },
    { name: "beyond a negative-coordinate display", displays: [D(-1920, 0, 0, 1080), D(0, 0, 1920, 1080)], region: D(-2000, 10, -1800, 200), expect: false },
    { name: "empty region", displays: one, region: D(10, 10, 10, 50), expect: false },
    { name: "no displays", displays: [], region: D(0, 0, 10, 10), expect: false },
  ];
  const got = await dotSource(cases, "[bool](Region-CoveredByDisplays $c.region @($c.displays))");
  cases.forEach((c, i) => assert.equal(got[i], c.expect, c.name));
});

test("WA-P1A.2 F1 (native, pure): names are recorded only for positively non-input text; password-like and ambiguous elements fail closed", { skip: PURE_SKIP }, async () => {
  const base = { isPassword: false, valuePattern: false, textPattern: false, nativeWindowHandle: 0, win32Style: 0, win32StyleKnown: false, factsIncomplete: false };
  const winformsEdit = "WindowsForms10.EDIT.app.0.141b42a_r6_ad1";
  const cases = [
    { name: "WinForms password edit surfaced as Pane (the native F1 shape)", f: { ...base, controlType: "ControlType.Pane", className: winformsEdit, nativeWindowHandle: 4242, win32Style: 0x50010020, win32StyleKnown: true }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "WinForms ordinary edit surfaced as Pane", f: { ...base, controlType: "ControlType.Pane", className: winformsEdit, nativeWindowHandle: 4243, win32Style: 0x50010000, win32StyleKnown: true }, security: "UNKNOWN", named: false },
    { name: "WinForms label", f: { ...base, controlType: "ControlType.Pane", className: "WindowsForms10.STATIC.app.0.141b42a_r6_ad1", nativeWindowHandle: 4244, win32Style: 0x50000000, win32StyleKnown: true }, security: "UNKNOWN", named: true },
    { name: "Win32 password Edit", f: { ...base, controlType: "ControlType.Edit", className: "Edit", valuePattern: true, nativeWindowHandle: 4245, win32Style: 0x50010020, win32StyleKnown: true }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "Win32 ordinary Edit", f: { ...base, controlType: "ControlType.Edit", className: "Edit", valuePattern: true, nativeWindowHandle: 4246, win32Style: 0x50010000, win32StyleKnown: true }, security: "ORDINARY_TEXT", named: false },
    // WA-P1A.2 review: uncertain edit evidence fails closed.
    { name: "windowless UIA Edit with an edit-like class (style unverifiable)", f: { ...base, controlType: "ControlType.Edit", className: "TextBox", valuePattern: true }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "windowless UIA Edit, no class, ValuePattern only", f: { ...base, controlType: "ControlType.Edit", className: "", valuePattern: true }, security: "UNKNOWN", named: false },
    { name: "Win32 Edit whose style read failed", f: { ...base, controlType: "ControlType.Edit", className: "Edit", valuePattern: true, nativeWindowHandle: 4247, win32Style: 0, win32StyleKnown: false }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "Win32 Edit reporting style 0 as known", f: { ...base, controlType: "ControlType.Edit", className: "Edit", valuePattern: true, nativeWindowHandle: 4248, win32Style: 0, win32StyleKnown: true }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "Win32 Edit style claimed known without a handle", f: { ...base, controlType: "ControlType.Edit", className: "Edit", valuePattern: true, nativeWindowHandle: 0, win32Style: 0x50010000, win32StyleKnown: true }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "inconsistent UIA: Text type with an Edit class, style unverified", f: { ...base, controlType: "ControlType.Text", className: "Edit", nativeWindowHandle: 4249, win32Style: 0, win32StyleKnown: false }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "inconsistent UIA: Text type with an Edit class, verified non-password style", f: { ...base, controlType: "ControlType.Text", className: "Edit", nativeWindowHandle: 4250, win32Style: 0x50010000, win32StyleKnown: true }, security: "UNKNOWN", named: false },
    { name: "Win32 Edit without a value pattern", f: { ...base, controlType: "ControlType.Edit", className: "Edit", nativeWindowHandle: 4251, win32Style: 0x50010000, win32StyleKnown: true }, security: "UNKNOWN", named: false },
    { name: "UIA IsPassword", f: { ...base, controlType: "ControlType.Edit", className: "PasswordBox", isPassword: true, valuePattern: true }, security: "SECRET_OR_PASSWORD", named: false },
    { name: "plain Text", f: { ...base, controlType: "ControlType.Text", className: "" }, security: "UNKNOWN", named: true },
    { name: "Button", f: { ...base, controlType: "ControlType.Button", className: "Button" }, security: "UNKNOWN", named: true },
    { name: "Text exposing a value pattern", f: { ...base, controlType: "ControlType.Text", className: "", valuePattern: true }, security: "UNKNOWN", named: false },
    { name: "Document", f: { ...base, controlType: "ControlType.Document", className: "" }, security: "UNKNOWN", named: false },
    { name: "ComboBox", f: { ...base, controlType: "ControlType.ComboBox", className: "" }, security: "UNKNOWN", named: false },
    { name: "Pane of an unknown class", f: { ...base, controlType: "ControlType.Pane", className: "SomeCustomRenderer" }, security: "UNKNOWN", named: false },
    { name: "Custom without class", f: { ...base, controlType: "ControlType.Custom", className: "" }, security: "UNKNOWN", named: false },
    { name: "facts unreadable", f: { ...base, controlType: "ControlType.Text", className: "", factsIncomplete: true }, security: "SECRET_OR_PASSWORD", named: false },
  ];
  const got = await dotSource(cases, "$p = Text-PolicyFor $c.f; @{ security = $p.inputSecurity; named = [bool]$p.nameRecorded }") as { security: string; named: boolean }[];
  cases.forEach((c, i) => {
    assert.equal(got[i]?.security, c.security, `${c.name}: inputSecurity`);
    assert.equal(got[i]?.named, c.named, `${c.name}: nameRecorded`);
  });
});

test("WA-P1A.2 review (native, pure): free-form identifiers are persisted only as short plain identifiers, never for secret elements", { skip: PURE_SKIP }, async () => {
  const cases = [
    { v: "wa-p1a2-secret", sensitive: false, expect: "wa-p1a2-secret" },
    { v: "WindowsForms10.EDIT.app.0.141b42a_r6_ad1", sensitive: false, expect: "WindowsForms10.EDIT.app.0.141b42a_r6_ad1" },
    { v: "123456", sensitive: true, expect: null },
    { v: "Value: hunter2", sensitive: false, expect: null },
    { v: "a".repeat(129), sensitive: false, expect: null },
    { v: "", sensitive: false, expect: null },
    { v: "line\nbreak", sensitive: false, expect: null },
  ];
  const got = await dotSource(cases, "Safe-Identifier ([string]$c.v) ([bool]$c.sensitive) 128");
  cases.forEach((c, i) => assert.equal(got[i] ?? null, c.expect, `Safe-Identifier(${JSON.stringify(c.v).slice(0, 40)})`));
});

test("WA-P1A.2 review (native, no UI): a deliberately unresponsive worker is killed by the outer watchdog and leaves no process", { skip: PURE_SKIP }, async () => {
  const marker = randomBytes(8).toString("hex");
  const dir = await mkdtemp(join(tmpdir(), "wa-p1a2-stall-"));
  try {
    const stall = join(dir, `stalled-worker-${marker}.ps1`);
    await writeFile(stall, "Start-Sleep -Seconds 120\n", "utf8");
    const worker = createPowerShellWindowsObservationWorker(defaultWindowsPowerShellPath(), stall);
    const request = {
      schemaVersion: "toadaid.desktop-observation-adapter-request.v1",
      invocationId: "stall-1", runId: "stall", hostId: "h", sessionId: "s", ownerId: "o",
      capabilityId: "host:display-inventory", toolName: "desktop.display-inventory",
      observationEpoch: "stall-epoch", parametersSha256: "7".repeat(64), maxWallClockMs: 1_500,
      parameters: normalizeDesktopObservationRequest({ kind: "DISPLAY_INVENTORY", hostId: "h", sessionId: "s", ownerId: "o", maxWallClockMs: 1_500 }),
    } as DesktopObservationAdapterRequest;
    const started = Date.now();
    await assert.rejects(worker.run(request, join(dir, "artifacts"), Date.now() + 1_000), /timed out/);
    assert.ok(Date.now() - started < 1_500 + 3_000, "killed within the wall clock plus slack");
    const probe = join(dir, "probe.ps1");
    await writeFile(probe, `$p = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*stalled-worker-${marker}*' }); [Console]::Out.Write($p.Count)`, "utf8");
    let alive = -1;
    for (let i = 0; i < 10; i += 1) {
      alive = Number(await runPowerShellFile(probe, [], CHILD_TIMEOUT_MS));
      if (alive === 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(alive, 0, "the stalled child process is gone");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WA-P1A.2 review (native, pure): a SECRET element persists no name, AutomationId or ClassName, and its fingerprint is built only from the redacted record", { skip: PURE_SKIP }, async () => {
  const token = `WA_P1A2_SECRET_CLASS_${randomBytes(6).toString("hex")}`;
  const idToken = `wa-p1a2-secret-automation-${randomBytes(6).toString("hex")}`;
  const nameToken = `wa-p1a2-secret-name-${randomBytes(6).toString("hex")}`;
  const observed = { name: nameToken, automationId: idToken, className: token, controlType: "ControlType.Edit", processId: 4242, enabled: true, offscreen: false, keyboardFocusable: true, bounds: { left: 10, top: 20, width: 200, height: 24 } };
  const cases = [
    { policy: { inputSecurity: "SECRET_OR_PASSWORD", nameRecorded: true }, observed },
    { policy: { inputSecurity: "UNKNOWN", nameRecorded: false }, observed },
    { policy: { inputSecurity: "UNKNOWN", nameRecorded: true }, observed: { ...observed, controlType: "ControlType.Text" } },
  ];
  const got = await dotSource(cases, "$p = Element-PersistedRecord $c.policy $c.observed; @{ record = $p.record; fingerprint = $p.fingerprint; sha = $p.evidenceSha256 }") as { record: Record<string, unknown>; fingerprint: string; sha: string }[];
  const [secret, unknownUnnamed, named] = got as [typeof got[0], typeof got[0], typeof got[0]];
  for (const value of [token, idToken, nameToken]) {
    assert.equal(JSON.stringify(secret.record).includes(value), false, "secret record discloses nothing free-form");
    assert.equal(secret.fingerprint.includes(value), false, "secret fingerprint input discloses nothing free-form");
  }
  assert.equal(secret.record.className, null);
  assert.equal(secret.record.classNameRedacted, true);
  assert.equal(secret.record.automationId, null);
  assert.equal(secret.record.name, null);
  assert.equal(secret.sha, sha256(secret.fingerprint), "the evidence SHA is exactly the hash of the redacted fingerprint");
  // Non-sensitive identifiers stay observable (bounded plain identifiers only).
  assert.equal(unknownUnnamed.record.className, token);
  assert.equal(unknownUnnamed.record.automationId, idToken);
  assert.equal(unknownUnnamed.record.name, null);
  assert.equal(named.record.name, nameToken);
  assert.notEqual(secret.sha, unknownUnnamed.sha);
});

// ------------------------------------------------------------------ live (operator opt-in)

type Ready = { pid: number; hwnd: number; bounds: ReturnType<typeof D>; primary: ReturnType<typeof D>; secretBounds: ReturnType<typeof D>; ordinaryBounds: ReturnType<typeof D>; secretClassName: string };
let fixture: { child: ReturnType<typeof spawn>; ready: Ready; closeFile: string; nonce: string } | null = null;
let workRoot = "";
const adapters = new Map<string, WindowsDesktopObservationAdapter>();
let seq = 0;

function adapterFor(capabilityId: DesktopObservationCapabilityId): WindowsDesktopObservationAdapter {
  let a = adapters.get(capabilityId);
  if (a === undefined) {
    a = createWindowsDesktopObservationAdapter({
      registration: {
        schemaVersion: "toadaid.desktop-observation-adapter-registration.v1",
        adapterId: `wa-p1a2-native-${capabilityId.replace("host:", "")}`,
        capabilityId,
        toolName: DESKTOP_OBSERVATION_TOOL_NAMES[capabilityId],
        contractId: DESKTOP_OBSERVATION_CONTRACT_IDS[capabilityId],
        descriptorSha256: "5".repeat(64),
        implementationFingerprintSha256: "6".repeat(64),
      },
      artifactRoot: join(workRoot, "artifacts"),
    });
    adapters.set(capabilityId, a);
  }
  return a;
}

async function observe(raw: Record<string, unknown>, maxWallClockOverride?: number) {
  const input = { hostId: "wa-p1a2-host", sessionId: "wa-p1a2-session", ownerId: "wa-p1a2-operator", ...raw } as DesktopObservationRequest;
  const normalized = normalizeDesktopObservationRequest(input);
  const parameters = maxWallClockOverride === undefined ? normalized : { ...normalized, maxWallClockMs: maxWallClockOverride };
  seq += 1;
  const request: DesktopObservationAdapterRequest = {
    schemaVersion: "toadaid.desktop-observation-adapter-request.v1",
    invocationId: `wa-p1a2-${seq}`,
    runId: "wa-p1a2-native",
    hostId: input.hostId,
    sessionId: input.sessionId,
    ownerId: input.ownerId,
    capabilityId: parameters.capabilityId,
    toolName: parameters.toolName,
    observationEpoch: `wa-p1a2-${fixture?.nonce ?? "x"}-${seq}`,
    parametersSha256: desktopObservationParametersSha256(input),
    maxWallClockMs: parameters.maxWallClockMs,
    parameters,
  };
  const adapter = adapterFor(parameters.capabilityId);
  return { adapter, result: await adapter.observe(request) };
}

before(async () => {
  if (!LIVE) return;
  workRoot = await mkdtemp(join(tmpdir(), "wa-p1a2-live-"));
  const nonce = randomBytes(8).toString("hex");
  const closeFile = join(workRoot, `close-${nonce}`);
  const child = spawn(defaultWindowsPowerShellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Nonce", nonce, "-CloseFile", closeFile, "-LifetimeSeconds", "180"], { shell: false, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
  const ready = await new Promise<Ready>((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => { child.kill(); reject(new Error("fixture not ready")); }, 30_000);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      const line = buf.split(/\r?\n/).find((l) => l.includes("WA_P1A2_FIXTURE_READY"));
      if (line) { clearTimeout(t); resolve(JSON.parse(line) as Ready); }
    });
    child.on("close", () => { clearTimeout(t); reject(new Error("fixture exited early")); });
  });
  fixture = { child, ready, closeFile, nonce };
});

after(async () => {
  if (fixture !== null) {
    await writeFile(fixture.closeFile, "close");
    const f = fixture;
    await new Promise<void>((r) => {
      if (f.child.exitCode !== null) { r(); return; }
      const t = setTimeout(() => { f.child.kill(); r(); }, 15_000);
      f.child.once("close", () => { clearTimeout(t); r(); });
    });
  }
  if (workRoot !== "") await rm(workRoot, { recursive: true, force: true });
});

test("WA-P1A.2 F1+F2 (native, live): exact-window snapshot keeps input values out of the artifact and drops out-of-window geometry", { skip: LIVE_SKIP }, async () => {
  const f = fixture!;
  const secret = `wa-p1a2-secret-value-${f.nonce}`;
  const ordinary = `wa-p1a2-ordinary-value-${f.nonce}`;
  const { adapter, result } = await observe({ kind: "UI_SNAPSHOT", windowId: `hwnd-${f.ready.hwnd}`, maxElements: 256 });
  const tree = result.artifacts.find((a) => a.kind === "UI_TREE")!;
  const text = await readFile(adapter.resolveArtifactPath(tree.id)!, "utf8");
  assert.equal(text.includes(secret), false, "password value must not enter the UI-tree artifact");
  assert.equal(text.includes(sha256(secret)), false, "nor its SHA-256");
  assert.equal(text.includes(ordinary), false, "input values are not recorded either");
  assert.equal(JSON.stringify(result).includes(secret), false, "nor the adapter result");
  assert.ok((result.elements ?? []).some((e) => e.inputSecurity === "SECRET_OR_PASSWORD"), "the password field is classified SECRET_OR_PASSWORD");
  // The SECRET element (bound by fixture geometry) persists no class/automation identifiers,
  // while the ordinary box of the same Win32 class keeps its plain identifiers.
  const at = (r: { left: number; top: number; right: number; bottom: number }) => (e: { bounds: { left: number; top: number; width: number; height: number } }) =>
    Math.round(e.bounds.left) === r.left && Math.round(e.bounds.top) === r.top && Math.round(e.bounds.left + e.bounds.width) === r.right && Math.round(e.bounds.top + e.bounds.height) === r.bottom;
  const all = (JSON.parse(text.replace(/^\uFEFF/, "")) as { elements: unknown }).elements;
  const list = (Array.isArray(all) ? all : [all]) as { className: string | null; automationId: string | null; bounds: { left: number; top: number; width: number; height: number } }[];
  const secretRecords = list.filter(at(f.ready.secretBounds));
  const ordinaryRecords = list.filter(at(f.ready.ordinaryBounds));
  assert.equal(secretRecords.length, 1, "exactly one record bound to the password box");
  assert.equal(ordinaryRecords.length, 1, "exactly one record bound to the ordinary box");
  assert.equal(secretRecords[0]!.className, null, "no ClassName for the SECRET element");
  assert.equal(secretRecords[0]!.automationId, null, "no AutomationId for the SECRET element");
  assert.equal(text.includes(f.ready.secretClassName) && ordinaryRecords[0]!.className !== f.ready.secretClassName, false, "the real class string appears only via the non-secret box");
  assert.equal(ordinaryRecords[0]!.className, f.ready.secretClassName, "the same Win32 class stays observable on the non-secret element");
  const parsed = JSON.parse(text.replace(/^﻿/, "")) as { elements: { name: string | null; bounds: { left: number; top: number; width: number; height: number } }[] | { name: string | null } };
  const els = (Array.isArray(parsed.elements) ? parsed.elements : [parsed.elements]) as { name: string | null; bounds: { left: number; top: number; width: number; height: number } }[];
  const names = new Set(els.map((e) => e.name));
  assert.equal(names.has("WA-P1A.2 visible label"), true, "safe display text is still observable");
  assert.equal(names.has("WA-P1A.2 outside label"), false, "an out-of-window child is not evidence");
  const b = f.ready.bounds;
  for (const e of els) {
    assert.ok(e.bounds.left >= b.left && e.bounds.top >= b.top && e.bounds.left + e.bounds.width <= b.right && e.bounds.top + e.bounds.height <= b.bottom, "every element lies inside the window");
  }
});

test("WA-P1A.2 F1 (native, live): text_exists cannot be used as an oracle for an input value", { skip: LIVE_SKIP }, async () => {
  const f = fixture!;
  const secretWait = await observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: `wa-p1a2-secret-value-${f.nonce}`, timeoutMs: 4_000, intervalMs: 250 });
  assert.equal(secretWait.result.matched, false);
  const labelWait = await observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: "WA-P1A.2 visible label", timeoutMs: 4_000, intervalMs: 250 });
  assert.equal(labelWait.result.matched, true);
});

test("WA-P1A.2 F3 (native, live): an absent match returns matched=false inside the bound; an exhausted budget still fails closed", { skip: LIVE_SKIP }, async () => {
  const f = fixture!;
  const started = Date.now();
  const absent = await observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: `wa-p1a2-absent-${f.nonce}`, timeoutMs: 3_000, intervalMs: 250 });
  assert.equal(absent.result.matched, false);
  assert.ok(Date.now() - started < 3_000 + 1_000, "finished within the outer wall clock (+ spawn slack)");
  await assert.rejects(
    observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: `wa-p1a2-absent-${f.nonce}`, timeoutMs: 200, intervalMs: 100 }),
    /deadline exhausted|timed out|worker failed/,
  );
});

async function waitEvidence(o: Awaited<ReturnType<typeof observe>>) {
  const art = o.result.artifacts.find((a) => a.kind === "WAIT_RESULT")!;
  return JSON.parse((await readFile(o.adapter.resolveArtifactPath(art.id)!, "utf8")).replace(/^\uFEFF/, "")) as { matched: boolean; reason: string; requestedTimeoutMs: number; observedIntervalMs: number; checks: number };
}

test("WA-P1A.2 review (native, live): wait evidence distinguishes a full timeout, a budget-truncated wait and a match", { skip: LIVE_SKIP }, async () => {
  const f = fixture!;
  const absent = `wa-p1a2-absent-${f.nonce}`;
  // Full requested timeout inside a larger wall-clock budget.
  const full = await observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: absent, timeoutMs: 1_500, intervalMs: 250 }, 8_000);
  const fe = await waitEvidence(full);
  assert.equal(full.result.matched, false);
  assert.equal(fe.reason, "REQUEST_TIMEOUT_ELAPSED");
  assert.ok(fe.observedIntervalMs >= 1_000, `observed ${fe.observedIntervalMs} ms of the requested 1500 ms`);
  // Contract-shaped wait (timeout == wall clock): the inner budget ends it first.
  const truncated = await observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: absent, timeoutMs: 3_000, intervalMs: 250 });
  const te = await waitEvidence(truncated);
  assert.equal(truncated.result.matched, false);
  assert.equal(te.reason, "WORKER_BUDGET_REACHED");
  assert.ok(te.observedIntervalMs < te.requestedTimeoutMs, "the evidence shows less than the requested interval was observed");
  // Match before any deadline.
  const hit = await observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: "WA-P1A.2 visible label", timeoutMs: 4_000, intervalMs: 250 });
  const he = await waitEvidence(hit);
  assert.equal(hit.result.matched, true);
  assert.equal(he.reason, "MATCHED");
  // A wait longer than its wall clock is refused, never reported as a full wait.
  await assert.rejects(observe({ kind: "WAIT_FOR", windowId: `hwnd-${f.ready.hwnd}`, condition: "text_exists", text: absent, timeoutMs: 20_000, intervalMs: 250 }, 3_000), /WAIT_TIMEOUT_EXCEEDS_WALL_CLOCK/);
});

test("WA-P1A.2 F4 (native, live): region-only captures outside or partly outside the displays are refused; inside is captured", { skip: LIVE_SKIP }, async () => {
  const f = fixture!;
  const p = f.ready.primary;
  await assert.rejects(observe({ kind: "SCREENSHOT", scope: { region: D(p.right + 10, p.top, p.right + 60, p.top + 50) } }), /worker failed/);
  await assert.rejects(observe({ kind: "SCREENSHOT", scope: { region: D(p.right - 10, p.top, p.right + 50, p.top + 50) } }), /worker failed/);
  const b = f.ready.bounds;
  const inside = await observe({ kind: "SCREENSHOT", scope: { region: D(b.left, b.top, b.left + 200, b.top + 100) } });
  const shot = inside.result.artifacts[0]!;
  const bytes = await readFile(inside.adapter.resolveArtifactPath(shot.id)!);
  assert.equal(sha256(bytes), shot.sha256);
});

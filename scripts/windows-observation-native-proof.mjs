// WA-P1B — operator-invoked native Windows OBSERVATION proof harness.
//
// Observation only: no click, keyboard, clipboard, file/registry mutation,
// shell command dispatch, elevation, UIAccess, persistence or service install.
// It starts ONE disposable synthetic fixture window (its own child process),
// observes it through the real adapter + PowerShell worker, writes artifacts
// only under a fresh operator-local temp directory, and deletes them at the
// end unless --keep-artifacts is given. The printed report is redacted:
// no account names, paths, screenshot bytes or non-synthetic UI strings.
//
// Usage (native Windows, operator present):
//   npm run build
//   node scripts/windows-observation-native-proof.mjs --consent OPERATOR_PRESENT_AND_CONSENTS [--out <report.json>] [--keep-artifacts]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRedacted,
  buildProofReport,
  canonicalJson,
  proofCase,
  readPng,
  sha256Hex,
} from "./wa-p1b/proofReport.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONSENT = "OPERATOR_PRESENT_AND_CONSENTS";
const FIXTURE_READY_MS = 30_000;
const CHILD_KILL_MS = 60_000;

function parseArgs(argv) {
  const out = { consent: null, out: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--consent") out.consent = argv[++i] ?? null;
    else if (argv[i] === "--out") out.out = argv[++i] ?? null;
    else if (argv[i] === "--keep-artifacts") out.keep = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function powershellPath() {
  const root = process.env.SystemRoot;
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error("SystemRoot must be an explicit local path");
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Bounded child run with explicit timeout; returns stdout text. */
function runPs(file, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); rejectPromise(new Error("probe timed out")); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d) => { if (out.length < 65_536) out += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { if (err.length < 8_192) err += d; });
    child.on("error", (e) => { clearTimeout(timer); rejectPromise(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) rejectPromise(new Error(`probe exit ${code} stderrSha256=${sha256Hex(Buffer.from(err))}`));
      else resolvePromise(out);
    });
  });
}

async function readGitHead(repo) {
  const head = (await readFile(join(repo, ".git", "HEAD"), "utf8")).trim();
  if (/^[0-9a-f]{40}$/.test(head)) return { commit: head, ref: null };
  const ref = head.replace(/^ref: /, "");
  let commit = null;
  try { commit = (await readFile(join(repo, ".git", ...ref.split("/")), "utf8")).trim(); } catch {
    const packed = await readFile(join(repo, ".git", "packed-refs"), "utf8");
    commit = packed.split("\n").find((l) => l.endsWith(` ${ref}`))?.slice(0, 40) ?? null;
  }
  return { commit, ref: ref.split("/").slice(2).join("/") };
}

async function capabilityIdentity(repo) {
  const lock = JSON.parse(await readFile(join(repo, "package-lock.json"), "utf8"));
  const entry = lock.packages?.["node_modules/@toadaid/agent-capabilities"] ?? {};
  const resolved = String(entry.resolved ?? "");
  const commit = /#([0-9a-f]{40})$/.exec(resolved)?.[1] ?? null;
  const pinned = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).dependencies["@toadaid/agent-capabilities"];
  const pinnedCommit = /#([0-9a-f]{40})$/.exec(pinned)?.[1] ?? null;
  const contract = await readFile(join(repo, "node_modules", "@toadaid", "agent-capabilities", "dist", "src", "desktopObservation.js"));
  return { pinnedCommit, installedCommit: commit, desktopObservationJsSha256: sha256Hex(contract) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") {
    console.error("WA_P1B_NATIVE_WINDOWS_REQUIRED");
    process.exitCode = 2;
    return;
  }
  if (args.consent !== CONSENT) {
    console.error(`WA_P1B_CONSENT_REQUIRED: pass --consent ${CONSENT} only when the operator is present and has agreed to the observation steps`);
    process.exitCode = 2;
    return;
  }

  const capabilities = await import("@toadaid/agent-capabilities");
  const { createWindowsDesktopObservationAdapter } = await import(new URL("../dist/src/index.js", import.meta.url).href);

  const nonce = randomBytes(8).toString("hex");
  const work = await realpath(await mkdtemp(join(tmpdir(), "toadaid-wa-p1b-")));
  const artifactRoot = join(work, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const closeFile = join(work, `close-${nonce}`);
  const cases = [];
  const add = (...a) => cases.push(proofCase(...a));
  let fixture = null;
  let step = "SETUP";

  const workerFile = join(REPO, "worker", "windows-observation.ps1");
  const fixtureFile = join(REPO, "scripts", "wa-p1b", "fixture-window.ps1");
  const probeFile = join(REPO, "scripts", "wa-p1b", "env-probe.ps1");

  const subject = {
    adapter: await readGitHead(REPO),
    capability: await capabilityIdentity(REPO),
    workerSha256: sha256Hex(await readFile(workerFile)),
    fixtureSha256: sha256Hex(await readFile(fixtureFile)),
    probeSha256: sha256Hex(await readFile(probeFile)),
    harnessSha256: sha256Hex(await readFile(fileURLToPath(import.meta.url))),
    adapterDistIndexSha256: sha256Hex(await readFile(join(REPO, "dist", "src", "windowsObservationAdapter.js"))),
  };

  const envRaw = JSON.parse(await runPs(probeFile, [], 30_000));
  const environment = {
    ...envRaw,
    marker: undefined,
    nodeVersion: process.version,
    nodeArch: process.arch,
    nativeWorkerSkeleton: existsSync(join(REPO, "native", "ToadAid.WindowsWorker", "Program.cs")) ? "SOURCE_PRESENT" : "ABSENT",
  };

  const registrationFor = (capabilityId) => ({
    schemaVersion: "toadaid.desktop-observation-adapter-registration.v1",
    adapterId: `wa-p1b-native-proof-${capabilityId.replace("host:", "")}`,
    capabilityId,
    toolName: capabilities.DESKTOP_OBSERVATION_TOOL_NAMES[capabilityId],
    contractId: capabilities.DESKTOP_OBSERVATION_CONTRACT_IDS[capabilityId],
    descriptorSha256: sha256Hex(Buffer.from(`wa-p1b-descriptor-${capabilityId}`)),
    implementationFingerprintSha256: subject.workerSha256,
  });
  const capabilityFor = { DISPLAY_INVENTORY: "host:display-inventory", SCREENSHOT: "host:screenshot", UI_SNAPSHOT: "host:ui-snapshot", WAIT_FOR: "host:wait-for" };
  const adapters = {};
  for (const [kind, cap] of Object.entries(capabilityFor)) {
    adapters[kind] = createWindowsDesktopObservationAdapter({ registration: registrationFor(cap), artifactRoot });
  }
  let seq = 0;
  const base = { hostId: "wa-p1b-native-host", sessionId: "wa-p1b-native-session", ownerId: "wa-p1b-operator" };
  /** Builds an adapter request from the upstream normalizer, optionally overriding normalized fields (for refusal cases). */
  function adapterRequest(raw, override = {}) {
    const normalized = { ...capabilities.normalizeDesktopObservationRequest({ ...base, ...raw }), ...override };
    seq += 1;
    return {
      schemaVersion: "toadaid.desktop-observation-adapter-request.v1",
      invocationId: `wa-p1b-${nonce}-${seq}`,
      runId: `wa-p1b-${nonce}`,
      hostId: base.hostId,
      sessionId: base.sessionId,
      ownerId: base.ownerId,
      capabilityId: normalized.capabilityId,
      toolName: normalized.toolName,
      observationEpoch: `wa-p1b-${nonce}-epoch-${seq}`,
      parametersSha256: capabilities.desktopObservationParametersSha256({ ...base, ...raw }),
      maxWallClockMs: normalized.maxWallClockMs,
      parameters: normalized,
    };
  }
  const observe = (raw, override) => {
    const request = adapterRequest(raw, override);
    return adapters[request.parameters.kind].observe(request);
  };
  async function verifyArtifacts(kind, result) {
    const adapter = adapters[kind];
    const rootReal = await realpath(artifactRoot);
    const out = [];
    for (const a of result.artifacts) {
      const p = adapter.resolveArtifactPath(a.id);
      const bytes = await readFile(p);
      const rel = relative(rootReal, await realpath(p));
      out.push({ id: a.id, kind: a.kind, sha256: a.sha256, diskSha256Matches: sha256Hex(bytes) === a.sha256, contained: rel !== "" && !rel.startsWith("..") && !isAbsolute(rel), bytes: bytes.length, path: p });
    }
    return out;
  }
  const publicArtifacts = (list) => list.map(({ path: _p, ...rest }) => rest);
  async function refusal(id, fn, expect) {
    const started = Date.now();
    try {
      await fn();
      add(id, "FAIL", { refused: false }, "observation succeeded where a fail-closed refusal was required");
    } catch (error) {
      const message = String(error?.message ?? error);
      const ok = expect.test(message);
      add(id, ok ? "PASS" : "FAIL", { refused: true, expectedRefusal: ok, refusalSha256: sha256Hex(Buffer.from(message)), withinMs: Date.now() - started < 30_000 }, ok ? "refused fail-closed before or inside the worker" : "refused, but not with the expected reason");
    }
  }

  try {
    // ---------------------------------------------------------------- fixture
    step = "FIXTURE";
    fixture = await startFixture(fixtureFile, nonce, closeFile);
    const fx = fixture.ready;
    const fixturePid = fx.pid;
    const mainWindowId = `hwnd-${fx.mainHwnd}`;

    // ---------------------------------------------------------------- C01 display inventory
    step = "C01";
    const inv = await observe({ kind: "DISPLAY_INVENTORY" });
    const invArtifacts = await verifyArtifacts("DISPLAY_INVENTORY", inv);
    const displays = JSON.parse((await readFile(invArtifacts[0].path, "utf8")).replace(/^﻿/, "")).displays;
    const displayList = (Array.isArray(displays) ? displays : [displays]).map((d) => ({
      id: d.id, primary: d.primary, deviceNameSha256: sha256Hex(Buffer.from(String(d.deviceName))),
      bounds: d.bounds, workingArea: d.workingArea,
    }));
    const primary = displayList.find((d) => d.primary) ?? displayList[0];
    add("C01-DISPLAY-INVENTORY", displayList.length >= 1 && invArtifacts.every((a) => a.diskSha256Matches && a.contained) ? "PASS" : "FAIL", {
      displayCount: displayList.length,
      displays: displayList,
      negativeVirtualCoordinates: displayList.some((d) => d.bounds.left < 0 || d.bounds.top < 0),
      mixedBounds: new Set(displayList.map((d) => `${d.bounds.width}x${d.bounds.height}`)).size > 1,
      primaryMatchesFixtureView: primary.bounds.left === fx.primaryBounds.left && primary.bounds.right === fx.primaryBounds.right && primary.bounds.bottom === fx.primaryBounds.bottom,
      artifacts: publicArtifacts(invArtifacts),
    }, "real display inventory; device names reported only as SHA-256");

    // ---------------------------------------------------------------- C02 one display screenshot (covered by synthetic cover)
    step = "C02";
    const shot = await observe({ kind: "SCREENSHOT", scope: { displayIds: [primary.id] } });
    const shotArtifacts = await verifyArtifacts("SCREENSHOT", shot);
    const shotPng = readPng(await readFile(shotArtifacts[0].path));
    add("C02-DISPLAY-SCREENSHOT", shotArtifacts.length === 1 && shotArtifacts[0].diskSha256Matches && shotArtifacts[0].contained && shotPng.width === primary.bounds.width && shotPng.height === primary.bounds.height ? "PASS" : "FAIL", {
      displayId: primary.id, pngWidth: shotPng.width, pngHeight: shotPng.height, artifacts: publicArtifacts(shotArtifacts),
    }, "one explicitly selected display; the operator desktop is hidden behind the synthetic cover window");

    // ---------------------------------------------------------------- C03 one bounded region (the fixture window)
    step = "C03";
    const region = { left: fx.mainBounds.left, top: fx.mainBounds.top, right: fx.mainBounds.right, bottom: fx.mainBounds.bottom };
    const rshot = await observe({ kind: "SCREENSHOT", scope: { region } });
    const rArtifacts = await verifyArtifacts("SCREENSHOT", rshot);
    const rPng = readPng(await readFile(rArtifacts[0].path));
    const ox = Math.floor((fx.occluderBounds.left + fx.occluderBounds.right) / 2) - region.left;
    const oy = Math.floor((fx.occluderBounds.top + fx.occluderBounds.bottom) / 2) - region.top;
    let occluderPixel = null;
    try { occluderPixel = rPng.pixel(ox, oy); } catch { occluderPixel = null; }
    add("C03-REGION-SCREENSHOT", rArtifacts[0].diskSha256Matches && rArtifacts[0].contained && rPng.width === region.right - region.left && rPng.height === region.bottom - region.top ? "PASS" : "FAIL", {
      regionWidth: region.right - region.left, regionHeight: region.bottom - region.top, pngWidth: rPng.width, pngHeight: rPng.height, artifacts: publicArtifacts(rArtifacts),
    }, "one bounded region of synthetic content");

    // ---------------------------------------------------------------- C04 exact-window UI snapshot + identity binding
    step = "C04";
    const ui = await observe({ kind: "UI_SNAPSHOT", windowId: mainWindowId, includeScreenshot: true, maxElements: 256 });
    const uiArtifacts = await verifyArtifacts("UI_SNAPSHOT", ui);
    const treeArtifact = uiArtifacts.find((a) => a.kind === "UI_TREE");
    const tree = JSON.parse((await readFile(treeArtifact.path, "utf8")).replace(/^﻿/, ""));
    const treeEls = Array.isArray(tree.elements) ? tree.elements : [tree.elements];
    const names = new Set(treeEls.map((e) => e.name));
    const probeWin = JSON.parse(await runPs(probeFile, ["-Hwnd", String(fx.mainHwnd)], 30_000)).window;
    const secretEl = treeEls.find((e) => e.automationId === "wa-p1b-password-input");
    const ordinaryEl = treeEls.find((e) => e.automationId === "wa-p1b-ordinary-input");
    const evidenceById = new Map((ui.elements ?? []).map((e) => [e.elementId, e]));
    // Every C04 element is owned by the synthetic fixture process (asserted), so its
    // synthetic strings may be reported; anything else is reported only as a hash.
    const synthetic = (v) => (typeof v === "string" && (v === "" || /^(WA-P1B |wa-p1b-|synthetic)/.test(v) || /^[A-Za-z]+$/.test(v)) ? v : `sha256:${sha256Hex(Buffer.from(String(v)))}`);
    const elementTable = treeEls.every((e) => e.processId === fixturePid) ? treeEls.map((e) => ({
      controlType: e.controlType, automationId: synthetic(e.automationId), name: synthetic(e.name), className: synthetic(e.className),
      inputSecurity: evidenceById.get(e.elementId)?.inputSecurity ?? null,
      boundsInsideWindow: e.bounds.left >= fx.mainBounds.left && e.bounds.top >= fx.mainBounds.top && e.bounds.left + e.bounds.width <= fx.mainBounds.right && e.bounds.top + e.bounds.height <= fx.mainBounds.bottom,
      carriesPasswordValue: JSON.stringify(e).includes("synthetic-not-a-secret"),
    })) : [];
    const secretOk = secretEl !== undefined && evidenceById.get(secretEl.elementId)?.inputSecurity === "SECRET_OR_PASSWORD";
    const leak = JSON.stringify(tree).includes("synthetic-not-a-secret");
    add("C04B-EXACT-WINDOW-SECRET-HANDLING", secretOk && !leak ? "PASS" : "FAIL", { passwordElementFound: secretEl !== undefined, passwordInputClassifiedSecret: secretOk, passwordValueAbsentFromTree: !leak }, "a password field must be classified SECRET_OR_PASSWORD and its value must never enter the UI tree artifact");
    add("C04C-EXACT-WINDOW-GEOMETRY", !names.has("WA-P1B clipped text delta") ? "PASS" : "FAIL", { clippedChildFilteredOut: !names.has("WA-P1B clipped text delta"), elementsOutsideWindowBounds: elementTable.filter((e) => !e.boundsInsideWindow).length }, "a child positioned far outside its window must not be reported as observable geometry");
    add("C04-EXACT-WINDOW-UI-SNAPSHOT", uiArtifacts.every((a) => a.diskSha256Matches && a.contained) && treeEls.every((e) => e.processId === fixturePid) && names.has("WA-P1B synthetic text alpha") && names.has("WA-P1B synthetic text beta") && Array.isArray(ui.elements) && ui.elements.length === treeEls.length ? "PASS" : "FAIL", {
      elementTable,
      elementCount: treeEls.length,
      allElementsOwnedByFixturePid: treeEls.every((e) => e.processId === fixturePid),
      siblingSubtreesAlphaAndBeta: names.has("WA-P1B synthetic text alpha") && names.has("WA-P1B synthetic text beta"),
      reusableElementEvidenceCount: (ui.elements ?? []).length,
      passwordInputClassifiedSecret: secretEl ? evidenceById.get(secretEl.elementId)?.inputSecurity === "SECRET_OR_PASSWORD" : false,
      ordinaryInputClassifiedOrdinary: ordinaryEl ? evidenceById.get(ordinaryEl.elementId)?.inputSecurity === "ORDINARY_TEXT" : false,
      passwordValueAbsentFromTree: !JSON.stringify(tree).includes("synthetic-not-a-secret"),
      clippedChildFilteredOut: !names.has("WA-P1B clipped text delta"),
      occludedLabelPresentInUia: names.has("WA-P1B occluded text gamma"),
      truncated: tree.truncated === true,
      windowIdentity: {
        hwndIsWindow: probeWin.isWindow,
        ownerPidMatchesFixture: probeWin.ownerPid === fixturePid,
        ownerSessionMatchesEnvironment: probeWin.ownerSessionId === envRaw.sessionId,
        ownerStartMatchesFixture: probeWin.ownerStartUtc !== null && Math.abs(Date.parse(probeWin.ownerStartUtc) - Date.parse(fx.processStartUtc)) < 1000,
        adapterResultBindsPidAndCreationTime: false,
      },
      artifacts: publicArtifacts(uiArtifacts),
    }, "exact HWND scope; HWND/PID/session/process-start bound by the independent probe; the adapter result itself carries only the hwnd locator");

    // ---------------------------------------------------------------- C05 on-screen pixels vs UIA semantics
    step = "C05";
    add("C05-PIXELS-VS-UIA", occluderPixel !== null && occluderPixel.r > 200 && occluderPixel.g < 60 && occluderPixel.b > 200 && names.has("WA-P1B occluded text gamma") ? "PASS" : "FAIL", {
      screenshotPixelAtOccludedLabelIsOccluder: occluderPixel !== null && occluderPixel.r > 200 && occluderPixel.g < 60 && occluderPixel.b > 200,
      uiaStillReportsOccludedLabel: names.has("WA-P1B occluded text gamma"),
    }, "CopyFromScreen returns on-screen pixels (the occluder), while UIA reports the hidden label: pixels are not semantic evidence and occluded pixels are not captured");

    // ---------------------------------------------------------------- C06 region-scoped UI snapshot: sibling traversal, no reusable evidence
    step = "C06";
    const rui = await observe({ kind: "UI_SNAPSHOT", scope: { region }, maxElements: 256 });
    const ruiArtifacts = await verifyArtifacts("UI_SNAPSHOT", rui);
    const rtree = JSON.parse((await readFile(ruiArtifacts.find((a) => a.kind === "UI_TREE").path, "utf8")).replace(/^﻿/, ""));
    const rEls = rtree.elements === undefined || rtree.elements === null ? [] : (Array.isArray(rtree.elements) ? rtree.elements : [rtree.elements]);
    const rNames = new Set(rEls.filter((e) => e.processId === fixturePid).map((e) => e.name));
    add("C06-REGION-UI-SNAPSHOT", rui.elements === undefined && rNames.has("WA-P1B synthetic text alpha") && rNames.has("WA-P1B synthetic text beta") ? "PASS" : "FAIL", {
      reusableElementEvidencePresent: rui.elements !== undefined,
      fixtureSiblingSubtreesAlphaAndBeta: rNames.has("WA-P1B synthetic text alpha") && rNames.has("WA-P1B synthetic text beta"),
      fixtureElementCount: rEls.filter((e) => e.processId === fixturePid).length,
      foreignProcessElementCount: rEls.filter((e) => e.processId !== fixturePid).length,
      allElementsInsideRegion: rEls.every((e) => e.bounds.left >= region.left && e.bounds.top >= region.top && e.bounds.left + e.bounds.width <= region.right && e.bounds.top + e.bounds.height <= region.bottom),
      truncated: rtree.truncated === true,
      artifacts: publicArtifacts(ruiArtifacts),
    }, "display/region scope traverses sibling subtrees; reusable element evidence is withheld outside exact-window scope; foreign elements are counted, never named");

    // ---------------------------------------------------------------- C07 display-scoped UI snapshot: invalid/minimized geometry filtered
    step = "C07";
    const dui = await observe({ kind: "UI_SNAPSHOT", scope: { displayIds: [primary.id] }, maxElements: 256 });
    const duiArtifacts = await verifyArtifacts("UI_SNAPSHOT", dui);
    const dtree = JSON.parse((await readFile(duiArtifacts.find((a) => a.kind === "UI_TREE").path, "utf8")).replace(/^﻿/, ""));
    const dEls = dtree.elements === undefined || dtree.elements === null ? [] : (Array.isArray(dtree.elements) ? dtree.elements : [dtree.elements]);
    const dNames = new Set(dEls.filter((e) => e.processId === fixturePid).map((e) => e.name));
    add("C07-DISPLAY-UI-SNAPSHOT", dui.elements === undefined && !dNames.has("WA-P1B minimized text epsilon") && !dNames.has("WA-P1B clipped text delta") ? "PASS" : "FAIL", {
      reusableElementEvidencePresent: dui.elements !== undefined,
      minimizedWindowContentFiltered: !dNames.has("WA-P1B minimized text epsilon"),
      clippedChildFiltered: !dNames.has("WA-P1B clipped text delta"),
      fixtureMainVisible: dNames.has("WA-P1B synthetic text alpha"),
      fixtureElementCount: dEls.filter((e) => e.processId === fixturePid).length,
      foreignProcessElementCount: dEls.filter((e) => e.processId !== fixturePid).length,
      truncated: dtree.truncated === true,
      artifacts: publicArtifacts(duiArtifacts),
    }, "invalid/offscreen geometry filtered in display scope; foreign elements are counted, never named");

    // ---------------------------------------------------------------- C08/C09 bounded waits
    step = "C08";
    const t0 = Date.now();
    const w1 = await observe({ kind: "WAIT_FOR", windowId: mainWindowId, condition: "text_exists", text: "WA-P1B synthetic text alpha", timeoutMs: 5_000, intervalMs: 250 });
    const w1a = await verifyArtifacts("WAIT_FOR", w1);
    add("C08-WAIT-TEXT-EXISTS", w1.matched === true && w1a.every((a) => a.diskSha256Matches && a.contained) ? "PASS" : "FAIL", { matched: w1.matched, completedWithinTimeoutPlusStartup: Date.now() - t0 < 20_000, artifacts: publicArtifacts(w1a) }, "bounded read-only text_exists wait on the exact window");
    const t1 = Date.now();
    let w2;
    try { w2 = await observe({ kind: "WAIT_FOR", windowId: mainWindowId, condition: "text_exists", text: `WA-P1B absent text ${nonce}`, timeoutMs: 1_500, intervalMs: 250 }); } catch (e) { w2 = { error: String(e?.message ?? e) }; }
    add("C09-WAIT-TEXT-ABSENT", w2.matched === false ? "PASS" : "FAIL", {
      matched: w2.matched ?? null,
      adapterTimedOutInstead: w2.error !== undefined && /timed out/.test(w2.error),
      neverReportedMatched: w2.matched !== true,
      completedWithin20s: Date.now() - t1 < 20_000,
    }, w2.matched === false ? "absent text completes as matched=false within the bound" : "absent text never matched (fail-closed), but the adapter wall clock equals the wait timeout, so the worker is killed before it can answer matched=false");

    // ---------------------------------------------------------------- C10 wall-clock bound kills a long worker
    step = "C10";
    const t2 = Date.now();
    await refusal("C10-WALLCLOCK-TIMEOUT", () => observe({ kind: "WAIT_FOR", windowId: mainWindowId, condition: "text_exists", text: `WA-P1B absent text ${nonce}`, timeoutMs: 20_000, intervalMs: 250 }, { maxWallClockMs: 3_000 }), /timed out/);
    cases[cases.length - 1] = proofCase(cases.at(-1).id, cases.at(-1).classification === "PASS" && Date.now() - t2 < 15_000 ? "PASS" : "FAIL", { ...cases.at(-1).facts, boundedWithin15s: Date.now() - t2 < 15_000 }, cases.at(-1).reason);

    // ---------------------------------------------------------------- refusals
    step = "REFUSALS";
    await refusal("R01-USE-DOM", () => observe({ kind: "UI_SNAPSHOT", windowId: mainWindowId }, { useDom: true }), /useDom/);
    await refusal("R02-ANNOTATE", () => observe({ kind: "SCREENSHOT", scope: { displayIds: [primary.id] } }, { annotate: true }), /annotation/);
    await refusal("R03-MIXED-SCOPE", () => observe({ kind: "UI_SNAPSHOT", windowId: mainWindowId }, { displayIds: [primary.id] }), /mixed window/);
    await refusal("R04-SELECTORLESS-WAIT", () => observe({ kind: "WAIT_FOR", windowId: mainWindowId, condition: "text_exists", text: "x" }, { condition: "element_exists", text: null }), /selectorless/);
    // A region that extends past the right edge of every display (outside the virtual screen).
    const virtualRight = Math.max(...displayList.map((d) => d.bounds.right));
    const outside = { left: virtualRight - 10, top: primary.bounds.top, right: virtualRight + 50, bottom: primary.bounds.top + 50 };
    await refusal("R05-REGION-OUTSIDE-DISPLAYS", () => observe({ kind: "SCREENSHOT", scope: { region: outside } }), /worker failed|not contained|invalid|outside|region/i);
    await refusal("R05B-DISPLAY-AND-REGION-TOGETHER", () => observe({ kind: "SCREENSHOT", scope: { displayIds: [primary.id], region } }), /not both/);
    await refusal("R06-UNKNOWN-DISPLAY", () => observe({ kind: "SCREENSHOT", scope: { displayIds: [displayList.length + 5] } }), /worker failed|unavailable|display/i);

    // ---------------------------------------------------------------- stale window (after the fixture is closed)
    step = "STALE";
    await stopFixture(fixture, closeFile);
    fixture = null;
    await refusal("R07-STALE-WINDOW-UI", () => observe({ kind: "UI_SNAPSHOT", windowId: mainWindowId, maxElements: 50 }), /worker failed|unavailable|stale|handle/i);
    const tw = Date.now();
    let staleWait;
    try { staleWait = await observe({ kind: "WAIT_FOR", windowId: mainWindowId, condition: "text_exists", text: "WA-P1B synthetic text alpha", timeoutMs: 1_500, intervalMs: 250 }); } catch (e) { staleWait = { error: String(e?.message ?? e) }; }
    add("R08-STALE-WINDOW-WAIT", staleWait.error !== undefined || staleWait.matched === false ? "PASS" : "FAIL", { refused: staleWait.error !== undefined, matched: staleWait.matched ?? null, completedWithin20s: Date.now() - tw < 20_000 }, "a closed window never satisfies a wait; it is refused or reported unmatched");

    // ---------------------------------------------------------------- not natively exercisable here
    step = "NOT-NATIVELY";
    add("U01-UNSUPPORTED-SESSION-DESKTOP", "UNSUPPORTED", { remoteSession: envRaw.remoteSession, sessionId: envRaw.sessionId, activeConsoleSessionId: envRaw.activeConsoleSessionId, desktop: envRaw.desktop }, "only the operator's interactive console session/Default desktop exists here; secure desktop, other sessions and RDP are WA-P1C");
    add("U02-OVERSIZED-MALFORMED-WORKER-OUTPUT", "BLOCKED", {}, "the real worker cannot be made to emit oversized/malformed output without modifying it; covered by fake-worker source tests only");
    add("U03-NATIVE-CSHARP-SKELETON", "BLOCKED", {}, "no .NET SDK on this host; installing one needs an explicit human OK; the skeleton is not observation parity in any case");
    add("U04-DPI-MIXED-NEGATIVE-COORDS", displayList.length > 1 ? "PASS" : "UNSUPPORTED", { displayCount: displayList.length, appliedDpi: envRaw.appliedDpi, probeDpiAwareness: envRaw.probeDpiAwareness }, displayList.length > 1 ? "multiple displays present" : "single display: negative virtual coordinates and mixed DPI cannot be exercised on this host");
  } catch (error) {
    const message = String(error?.message ?? error);
    add(`ABORTED-AT-${step}`, "FAIL", { errorSha256: sha256Hex(Buffer.from(message)) }, message.slice(0, 160));
  } finally {
    if (fixture !== null) await stopFixture(fixture, closeFile).catch(() => {});
    if (!args.keep) await rm(work, { recursive: true, force: true });
  }

  const report = buildProofReport({ subject, environment, cases });
  const text = `${canonicalJson(report)}\n`;
  const user = userInfo().username;
  assertRedacted(text, [work, tmpdir(), homedir(), REPO, user]);
  if (args.out) await writeFile(resolve(args.out), text, { flag: "wx" });
  process.stdout.write(text);
  if (report.summary.FAIL > 0) process.exitCode = 1;
}

function startFixture(fixtureFile, nonce, closeFile) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixtureFile, "-Nonce", nonce, "-CloseFile", closeFile, "-LifetimeSeconds", "240"], { shell: false, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let done = false;
    const killTimer = setTimeout(() => { if (!child.killed) child.kill(); }, 300_000);
    const readyTimer = setTimeout(() => { if (!done) { done = true; child.kill(); rejectPromise(new Error("fixture did not become ready")); } }, FIXTURE_READY_MS);
    child.stdout.setEncoding("utf8").on("data", (d) => {
      buffer += d;
      const line = buffer.split(/\r?\n/).find((l) => l.includes("WA_P1B_FIXTURE_READY"));
      if (line && !done) {
        done = true;
        clearTimeout(readyTimer);
        resolvePromise({ child, killTimer, ready: JSON.parse(line) });
      }
    });
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(readyTimer); rejectPromise(e); } });
    child.on("close", () => { clearTimeout(killTimer); if (!done) { done = true; clearTimeout(readyTimer); rejectPromise(new Error("fixture exited early")); } });
  });
}

async function stopFixture(fixture, closeFile) {
  await writeFile(closeFile, "close", { flag: "w" });
  const exited = await new Promise((r) => {
    if (fixture.child.exitCode !== null) { r(true); return; }
    const t = setTimeout(() => r(false), 15_000);
    fixture.child.once("close", () => { clearTimeout(t); r(true); });
  });
  clearTimeout(fixture.killTimer);
  if (!exited) fixture.child.kill();
}

main().catch((error) => {
  console.error(`WA_P1B_HARNESS_ERROR sha256=${sha256Hex(Buffer.from(String(error?.stack ?? error)))}`);
  console.error(String(error?.message ?? error).slice(0, 400));
  process.exitCode = 3;
});

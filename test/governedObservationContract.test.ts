import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// Narrow surfaces only: the package root also re-exports the browser modules,
// which need the optional playwright peer that this adapter never installs.
import {
  DESKTOP_OBSERVATION_CONTRACT_IDS,
  DESKTOP_OBSERVATION_TOOL_NAMES,
  desktopObservationAdapterRegistrationSha256,
  desktopObservationParametersSha256,
  normalizeDesktopObservationRequest,
  observeGovernedDesktop,
} from "@toadaid/agent-capabilities/desktop-observation";
import { createHostConnectorSessionLease } from "@toadaid/agent-capabilities/host-session";
import { CORE_CAPABILITY_MANIFEST, resolveCapabilityAuthority } from "@toadaid/agent-capabilities/policy";
import type {
  DesktopObservationAdapterRegistration,
  DesktopObservationAdapterRequest,
  DesktopObservationHead,
  DesktopObservationProviderIdentity,
  DesktopObservationRequest,
} from "@toadaid/agent-capabilities/desktop-observation";
import { createRunBudgetLedger } from "@toadaid/agent-capabilities/budget";
import {
  assertCapabilityContractCompatible,
  capabilityContractDescriptorSha256,
  createCapabilityContractRegistry,
  createCapabilityInvocationContractBinding,
} from "@toadaid/agent-capabilities/contracts";
import { sealCapabilityInvocationRecord } from "@toadaid/agent-capabilities/invocation";

import { createWindowsDesktopObservationAdapter } from "../src/windowsObservationAdapter.js";
import type {
  WindowsObservationWorker,
  WindowsObservationWorkerResponse,
} from "../src/windowsObservationAdapter.js";
import { withTempRoot } from "./support/tempRoot.js";

// WA-CAP-SYNC-P1: the Windows adapter is exercised through the REAL governed
// spine of the pinned @toadaid/agent-capabilities (P15 lease, P3 authority, C1
// contract, H1 invocation, Q1 budget, provider identity), not just its own
// interface. The worker is synthetic: it writes real artifact files but reads
// no desktop. Native behaviour of the real worker is covered separately.

const NOW = "2026-10-21T03:00:00.000Z";
const TOPOLOGY = "topology-sha256-" + "c".repeat(64);
const OTHER_TOPOLOGY = "topology-sha256-" + "d".repeat(64);
const WINDOW = "hwnd-4242";
/** The spine's clock is pinned to the same instant the lease and budget were created at. */
const CLOCK = { now: () => new Date(NOW) };

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function policy(capabilityId: string) {
  return resolveCapabilityAuthority(capabilityId, CORE_CAPABILITY_MANIFEST, [
    { scope: "agent", subject: "agent0", decisions: { [capabilityId]: "ALLOW" } },
  ]);
}

type Shape = "SYNCED" | "LEGACY_PRE_SYNC";

interface Synthetic {
  readonly shape?: Shape;
  readonly topology?: string;
  readonly matched?: boolean;
  readonly mutate?: (r: WindowsObservationWorkerResponse) => WindowsObservationWorkerResponse;
}

/** A synthetic worker in the exact response shape of worker/windows-observation.ps1. */
function syntheticWorker(opts: Synthetic, calls: { n: number }): WindowsObservationWorker {
  return {
    async run(request: DesktopObservationAdapterRequest, artifactRoot: string) {
      calls.n += 1;
      const p = request.parameters;
      const kind = p.kind === "DISPLAY_INVENTORY" ? "DISPLAY_INVENTORY" : p.kind === "WAIT_FOR" ? "WAIT_RESULT" : p.kind === "UI_SNAPSHOT" ? "UI_TREE" : "SCREENSHOT";
      const id = `${kind.toLowerCase().replace("_", "-")}-synthetic-0`;
      const path = join(artifactRoot, `${id}${kind === "SCREENSHOT" ? ".png" : ".json"}`);
      const bytes = Buffer.from(JSON.stringify({ synthetic: true, kind, epoch: request.observationEpoch }), "utf8");
      await writeFile(path, bytes);
      const topology = opts.topology ?? TOPOLOGY;
      const legacy = opts.shape === "LEGACY_PRE_SYNC";
      const exactWindow = p.kind === "UI_SNAPSHOT" && p.windowId !== null;
      const matched = opts.matched ?? true;
      const base: WindowsObservationWorkerResponse = {
        observationEpoch: request.observationEpoch,
        hostId: request.hostId,
        sessionId: request.sessionId,
        displayIds: p.kind === "DISPLAY_INVENTORY" ? [0] : [...p.displayIds],
        windowId: p.windowId,
        // The pre-sync worker (WHA main 3471610) reported none of the
        // topology/geometry/completion fields; the cast reproduces its output.
        ...(legacy ? {} : { displayTopologyEpoch: topology }),
        ...(!legacy && exactWindow ? { geometry: { coordinateSpace: "DESKTOP_PHYSICAL" as const, bounds: { left: 100, top: 80, right: 740, bottom: 560 }, displayTopologyEpoch: topology } } : {}),
        evidenceSha256: sha256(`evidence-${request.observationEpoch}`),
        artifacts: [{ id, kind, sha256: sha256(bytes) }],
        ...(exactWindow ? { elements: [{ elementId: "uia-synthetic-0001", evidenceSha256: "2".repeat(64), inputSecurity: "ORDINARY_TEXT" as const }] } : {}),
        ...(p.kind === "WAIT_FOR" ? { matched, ...(legacy ? {} : { completionReason: matched ? "MATCHED" as const : "TIMED_OUT" as const }) } : {}),
        artifactFiles: [{ id, path }],
      } as WindowsObservationWorkerResponse;
      return opts.mutate ? opts.mutate(base) : base;
    },
  };
}

function governedInput(request: DesktopObservationRequest, artifactRoot: string, worker: WindowsObservationWorker) {
  const normalized = normalizeDesktopObservationRequest(request);
  const capabilityId = normalized.capabilityId;
  const toolName = DESKTOP_OBSERVATION_TOOL_NAMES[capabilityId];
  const contractId = DESKTOP_OBSERVATION_CONTRACT_IDS[capabilityId];
  const descriptor = {
    schemaVersion: "toadaid.capability-contract.v2" as const,
    capabilityId,
    contractId,
    version: { major: 1, minor: 0 },
    features: ["bounded-observation", "lease-bound", "q1-accounted"],
    requestSchema: { schemaId: "toadaid.desktop.observation-request", schemaSha256: "8".repeat(64) },
    resultSchema: { schemaId: "toadaid.desktop.observation-result", schemaSha256: "9".repeat(64) },
    receiptSchema: { schemaId: "toadaid.desktop.observation-receipt", schemaSha256: "a".repeat(64) },
  };
  const registration: DesktopObservationAdapterRegistration = {
    schemaVersion: "toadaid.desktop-observation-adapter-registration.v1",
    adapterId: "windows-observation-adapter",
    capabilityId,
    toolName,
    contractId,
    descriptorSha256: capabilityContractDescriptorSha256(descriptor),
    implementationFingerprintSha256: "e".repeat(64),
  };
  const registry = createCapabilityContractRegistry([descriptor]);
  const requirement = { capabilityId, contractId, major: 1, minMinor: 0, requiredFeatures: ["bounded-observation", "lease-bound", "q1-accounted"] };
  const compatibility = assertCapabilityContractCompatible(registry, requirement);
  const invocation = sealCapabilityInvocationRecord({
    schemaVersion: "toadaid.capability-invocation.v1",
    invocationId: "wa-capsync-invocation-001",
    revision: 2,
    status: "STARTED",
    runId: "wa-capsync-run-001",
    childTaskId: null,
    capabilityId,
    toolName,
    externalToolCallId: null,
    createdAt: NOW,
    updatedAt: NOW,
    request: { intentSha256: "b".repeat(64), argumentsSha256: desktopObservationParametersSha256(request) },
    authorization: { checkedAt: NOW, decision: "ALLOW", reason: "AUTHORIZED_BY_POLICY", decisionSha256: "c".repeat(64) },
    start: { startedAt: NOW, managerId: "wa-capsync-manager" },
    cancellation: null,
    outcome: null,
    continuity: { previousRecordSha256: "d".repeat(64) },
  });
  const contractBinding = createCapabilityInvocationContractBinding(invocation, requirement, registry, {
    providerDescriptorSha256: "f".repeat(64),
    adapterRegistrationSha256: desktopObservationAdapterRegistrationSha256(registration),
    implementationFingerprintSha256: registration.implementationFingerprintSha256,
  });
  const contractReady = {
    schemaVersion: "toadaid.capability-invocation-contract-ready.v1" as const,
    invocationId: invocation.record.invocationId,
    capabilityId,
    bindingSha256: contractBinding.bindingSha256,
    provider: {
      providerDescriptorSha256: contractBinding.providerDescriptorSha256,
      adapterRegistrationSha256: contractBinding.adapterRegistrationSha256,
      implementationFingerprintSha256: contractBinding.implementationFingerprintSha256,
    },
    compatibility,
  };
  const providerIdentity: DesktopObservationProviderIdentity = Object.freeze({
    providerDescriptorSha256: contractBinding.providerDescriptorSha256,
    providerGenerationSha256: "7".repeat(64),
    evidenceNamespace: "wa-capsync-session-001",
  });
  let currentProvider: DesktopObservationProviderIdentity | null = providerIdentity;
  const lease = createHostConnectorSessionLease(
    { hostId: request.hostId, sessionId: request.sessionId, ownerId: request.ownerId, allowedCapabilities: [capabilityId], connectionConfigSha256: "e".repeat(64), ttlMs: 60_000, createdAt: NOW },
    policy("host:session"),
    { now: () => new Date(NOW) },
  );
  const budget = createRunBudgetLedger(
    { budgetId: "wa-capsync-budget", runId: "wa-capsync-run-001", createdAt: NOW, limits: { modelRequests: 0, inputTokens: 0, outputTokens: 0, toolCalls: 10, networkRequests: 0, retries: 0, wallClockMs: 300_000, childTasks: 0 } },
    { now: () => new Date(NOW) },
  );
  const heads = new Map<string, DesktopObservationHead>();
  const key = (h: string, s: string, w: string) => `${h}\n${s}\n${w}`;
  const adapter = createWindowsDesktopObservationAdapter({ registration, artifactRoot, worker, platform: "linux" });
  return {
    adapter,
    setProvider(next: DesktopObservationProviderIdentity | null) { currentProvider = next; },
    input: {
      lease,
      leaseRuntime: { now: () => new Date(NOW), resolveCurrentLeaseSha256: () => lease.leaseSha256 },
      observationHeadRuntime: {
        resolveCurrentProviderIdentity: () => currentProvider,
        publishCurrentObservationHead(head: DesktopObservationHead) { heads.set(key(head.hostId, head.sessionId, head.windowId), head); },
        claimCurrentObservationHead(expected: DesktopObservationHead, next: DesktopObservationHead) {
          const k = key(expected.hostId, expected.sessionId, expected.windowId);
          if (JSON.stringify(heads.get(k) ?? null) !== JSON.stringify(expected)) return false;
          heads.set(k, next);
          return true;
        },
        resolveCurrentObservationHead: (id: Readonly<{ hostId: string; sessionId: string; windowId: string }>) => heads.get(key(id.hostId, id.sessionId, id.windowId)) ?? null,
      },
      sessionAuthority: policy("host:session"),
      actionAuthority: policy(capabilityId),
      invocation,
      contractBinding,
      contractReady,
      contractRequirement: requirement,
      contractRegistry: registry,
      budget,
      providerIdentity,
      request,
    },
  };
}

const who = { hostId: "wa-capsync-host", sessionId: "wa-capsync-session", ownerId: "agent0" } as const;
const REQUESTS: Record<string, DesktopObservationRequest> = {
  inventory: { ...who, kind: "DISPLAY_INVENTORY", maxWallClockMs: 5_000 } as DesktopObservationRequest,
  displayShot: { ...who, kind: "SCREENSHOT", scope: { displayIds: [0], displayTopologyEpoch: TOPOLOGY }, annotate: false, maxWallClockMs: 5_000 } as DesktopObservationRequest,
  windowSnapshot: { ...who, kind: "UI_SNAPSHOT", windowId: WINDOW, maxElements: 64, maxWallClockMs: 5_000 } as DesktopObservationRequest,
  wait: { ...who, kind: "WAIT_FOR", windowId: WINDOW, condition: "text_exists", text: "synthetic label", timeoutMs: 2_000, intervalMs: 250, maxWallClockMs: 5_000 } as DesktopObservationRequest,
};

async function governed(name: keyof typeof REQUESTS | string, opts: Synthetic = {}) {
  return withTempRoot("toadaid-wa-capsync-", async (root) => {
    const calls = { n: 0 };
    const ctx = governedInput(REQUESTS[name]!, join(root, "artifacts"), syntheticWorker(opts, calls));
    const outcome = await observeGovernedDesktop(ctx.adapter, ctx.input, CLOCK);
    return { outcome, calls };
  });
}

test("WA-CAP-SYNC-P1: every observation kind completes through the real governed spine", async () => {
  const inv = await governed("inventory");
  assert.equal(inv.outcome.receipt.status, "OK");
  assert.equal(inv.outcome.receipt.displayTopologyEpoch, TOPOLOGY);
  assert.equal(inv.outcome.receipt.cancellationStatus, "NOT_REQUESTED");

  const shot = await governed("displayShot");
  assert.equal(shot.outcome.receipt.status, "OK");
  assert.deepEqual(shot.outcome.receipt.displayIds, [0]);
  assert.equal(shot.outcome.receipt.displayTopologyEpoch, TOPOLOGY);

  const ui = await governed("windowSnapshot");
  assert.equal(ui.outcome.receipt.status, "OK");
  assert.deepEqual(ui.outcome.receipt.geometry, { coordinateSpace: "DESKTOP_PHYSICAL", bounds: { left: 100, top: 80, right: 740, bottom: 560 }, displayTopologyEpoch: TOPOLOGY });
  assert.equal(ui.outcome.receipt.elements.length, 1);

  const hit = await governed("wait", { matched: true });
  assert.equal(hit.outcome.receipt.status, "OK");
  assert.equal(hit.outcome.receipt.matched, true);
  assert.equal(hit.outcome.receipt.completionReason, "MATCHED");

  const miss = await governed("wait", { matched: false });
  assert.equal(miss.outcome.receipt.status, "OK");
  assert.equal(miss.outcome.receipt.matched, false);
  assert.equal(miss.outcome.receipt.completionReason, "TIMED_OUT");
});

test("WA-CAP-SYNC-P1 RED->GREEN: the pre-sync worker output shape is refused (degraded), never silently accepted", async () => {
  for (const name of ["inventory", "displayShot", "windowSnapshot", "wait"]) {
    const { outcome, calls } = await governed(name, { shape: "LEGACY_PRE_SYNC" });
    assert.equal(calls.n, 1, name);
    assert.equal(outcome.receipt.status, "DEGRADED", name);
    assert.equal(outcome.result, null, name);
    assert.equal(outcome.receipt.evidenceSha256, null, name);
  }
});

test("WA-CAP-SYNC-P1: a worker that observed a different display topology fails closed", async () => {
  const { outcome } = await governed("displayShot", { topology: OTHER_TOPOLOGY });
  assert.equal(outcome.receipt.status, "DEGRADED");
  assert.equal(outcome.receipt.degradedReason, "ADAPTER_RESULT_INVALID");
  assert.equal(outcome.receipt.artifacts.length, 0);
});

test("WA-CAP-SYNC-P1: exact-window geometry must be present, physical, in-topology and well-formed", async () => {
  const cases: readonly ((r: WindowsObservationWorkerResponse) => WindowsObservationWorkerResponse)[] = [
    ({ geometry: _g, ...rest }) => rest as WindowsObservationWorkerResponse,
    (r) => ({ ...r, geometry: { ...r.geometry!, coordinateSpace: "WINDOW_CLIENT_PHYSICAL" } }),
    (r) => ({ ...r, geometry: { ...r.geometry!, displayTopologyEpoch: OTHER_TOPOLOGY } }),
    (r) => ({ ...r, geometry: { ...r.geometry!, bounds: { left: 10, top: 10, right: 10, bottom: 50 } } }),
    (r) => ({ ...r, geometry: { ...r.geometry!, bounds: { left: 0.5, top: 0, right: 10, bottom: 10 } } }),
  ];
  for (const [i, mutate] of cases.entries()) {
    const { outcome } = await governed("windowSnapshot", { mutate });
    assert.equal(outcome.receipt.status, "DEGRADED", `case ${i}`);
    assert.equal(outcome.receipt.degradedReason, "ADAPTER_RESULT_INVALID", `case ${i}`);
  }
  // geometry outside exact-window scope is refused too
  const { outcome } = await governed("inventory", { mutate: (r) => ({ ...r, geometry: { coordinateSpace: "DESKTOP_PHYSICAL", bounds: { left: 0, top: 0, right: 1, bottom: 1 }, displayTopologyEpoch: TOPOLOGY } }) });
  assert.equal(outcome.receipt.status, "DEGRADED");
});

test("WA-CAP-SYNC-P1: wait-for completion reason must agree with matched, and stays out of other kinds", async () => {
  for (const mutate of [
    (r: WindowsObservationWorkerResponse) => ({ ...r, completionReason: "TIMED_OUT" as const }),
    (r: WindowsObservationWorkerResponse) => { const { completionReason: _c, ...rest } = r; return rest as WindowsObservationWorkerResponse; },
  ]) {
    const { outcome } = await governed("wait", { matched: true, mutate });
    assert.equal(outcome.receipt.status, "DEGRADED");
  }
  const { outcome } = await governed("inventory", { mutate: (r) => ({ ...r, matched: true, completionReason: "MATCHED" }) });
  assert.equal(outcome.receipt.status, "DEGRADED");
});

test("WA-CAP-SYNC-P1: a stale provider generation is refused by the spine before the Windows worker runs", async () => {
  await withTempRoot("toadaid-wa-capsync-", async (root) => {
    const calls = { n: 0 };
    const ctx = governedInput(REQUESTS["inventory"]!, join(root, "artifacts"), syntheticWorker({}, calls));
    ctx.setProvider({ providerDescriptorSha256: "f".repeat(64), providerGenerationSha256: "6".repeat(64), evidenceNamespace: "wa-capsync-session-001" });
    await assert.rejects(observeGovernedDesktop(ctx.adapter, ctx.input, CLOCK), /provider generation or evidence namespace is stale/);
    assert.equal(calls.n, 0);
  });
});

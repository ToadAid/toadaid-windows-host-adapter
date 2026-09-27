# ToadAid Windows Provider Worker Protocol v1

Status: WA-P1A.1 Linux-verifiable foundation. This document does **not** claim native Windows proof.

## Boundary

The shared capability spine decides whether an action may occur.

The Windows provider membrane decides whether the exact Windows object previously observed still exists in the same provider generation and OS identity boundary.

The worker attempts only the bounded mechanism requested by the provider.

Provider evidence is never authority.

## Framing

Protocol version:

`toadaid.windows-provider-worker.v1`

Transport framing is one UTF-8 JSON object followed by one LF byte.

Maximum frame size: 256 KiB.

Unknown or missing top-level fields are refused. Multiline/pretty-printed frames are refused. Request IDs and generation IDs are bounded identifiers.

Initial request kinds:

- `HANDSHAKE`
- `HEALTH`
- `OBSERVE`

P17/P18 mutation kinds are intentionally absent from v1 of this foundation.

## Generation law

A worker generation is one runtime life.

Crash, restart, upgrade, logoff, Windows session change, desktop change, or protocol reset creates a new generation and invalidates all provider live references from the previous generation.

Opaque provider references may point to evidence, but possession of a reference grants no authority.

## Window evidence

Provider-side window evidence binds at minimum:

- worker generation
- Windows session identity
- window station / desktop identity
- HWND locator
- owning PID
- process creation time
- observation epoch
- observation timestamp
- bounded TTL

`hwnd-<decimal>` is a locator only. It is not sufficient identity for P17 dispatch.

Before any future interaction dispatch, the provider must re-resolve and compare the generation/session/desktop/HWND/PID/process-creation tuple. A mismatch refuses rather than retargeting.

## Element evidence

Element evidence is bound to:

- observation epoch
- exact window reference
- P16 element ID
- P16 element evidence SHA-256
- worker generation
- UIA runtime ID where available
- ancestry fingerprint
- bounds fingerprint
- clickable-point fingerprint where available
- observation timestamp
- TTL

Worker restart invalidates element evidence.

## Failure law

Pure/read work may fail safely before or after worker transport loss.

A future mutation that has not entered OS dispatch may fail safely.

A future mutation whose OS dispatch may have begun and then loses transport is `RECONCILIATION_REQUIRED`. The provider must never retry it blindly.

## Artifacts

Each operation receives an unpredictable provider-owned directory beneath the configured artifact root.

Artifacts use create-new semantics, bounded byte size, duplicate-ID refusal, root containment, and bounded retention/cleanup.

Raw paths, clipboard text, file contents, command payloads, and other sensitive runtime data must not enter authority receipts or routine logs.

## Native worker target

The long-term worker target is a per-user, per-interactive-session C#/.NET process using one narrow local protocol.

The WA-P1A.1 C# skeleton implements protocol framing / handshake / health shape and explicit non-Windows refusal only. It contains no P17/P18 mutation implementation.

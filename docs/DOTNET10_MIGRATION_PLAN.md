# Native worker: .NET 10 LTS migration plan (proposal, not executed)

Status: **plan only.** Nothing here is installed or retargeted. Retargeting and
installing .NET 10 is a separately reviewed development cut, run with operator
consent; the existing per-user .NET 8 SDK is not replaced.

## Why now

`native/ToadAid.WindowsWorker` targets `net8.0`. .NET 8 (LTS) reaches end of
support on **10 November 2026**; after that it receives no security fixes.
.NET 10 is the current LTS line.

## Current state (recorded 2026-10-17)

- Dev host SDK: .NET SDK 8.0.426 (runtime 8.0.32), per-user under
  `E:\ToadAid\tools\dotnet-sdk-8`, installed with Microsoft's signed
  `dotnet-install.ps1`; no PATH change, no machine-wide install.
- The project has no package references; it builds offline from the SDK's
  targeting packs. `TreatWarningsAsErrors` is on.
- The skeleton implements HANDSHAKE/HEALTH only; OBSERVE is `UNIMPLEMENTED_KIND`.

## Proposed cut (for review)

1. Install the .NET 10 SDK side by side in a new per-user directory (signed
   installer, provenance recorded: script hash, Authenticode, download URL,
   `dotnet --info`). Do not touch the .NET 8 directory.
2. Change `TargetFramework` to `net10.0` only; no other project change.
3. Rebuild with warnings-as-errors; record new analyzer warnings rather than
   suppressing them.
4. Re-run the native interop suite
   (`test/nativeWorkerSkeletonInterop.test.ts` with
   `TOADAID_NATIVE_CSHARP_WORKER`) and the source tests; require identical
   protocol behaviour (framing, typed errors, LF-only responses).
5. Record behaviour differences of `System.Text.Json` between 8 and 10 that
   matter to the strict parser (duplicate-key handling, depth limits,
   invalid-UTF-8 handling) with explicit tests, not assumptions.
6. CI: switch the Windows job's SDK to 10 in the same cut, pinned.
7. Rollback: retarget back to `net8.0`; the .NET 8 SDK stays installed until
   the reviewer approves its removal.

## Out of scope

Runtime deployment, self-contained publishing, signing, installers, services,
or enabling the native worker as the observation path (WA-P1D).

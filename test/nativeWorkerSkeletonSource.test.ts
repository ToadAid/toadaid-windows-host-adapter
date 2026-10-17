import assert from "node:assert/strict";
import {
  readFile,
} from "node:fs/promises";
import {
  resolve,
} from "node:path";
import test from "node:test";

test("WA-P1A.1 native skeleton mirrors strict one-line protocol law without mutation primitives", async () => {
  const source =
    await readFile(
      resolve(
        process.cwd(),
        "native",
        "ToadAid.WindowsWorker",
        "Program.cs",
      ),
      "utf8",
    );

  for (const required of [
    "RequireExactTopLevelFields",
    "Console.OpenStandardInput()",
    "Console.OpenStandardOutput()",
    "RequireStrictPayload",
    "FRAME_ENCODING_INVALID",
    "FRAME_UNTERMINATED",
    "FRAME_MULTILINE",
    "FRAME_TOO_LARGE",
    "PROTOCOL_MISMATCH",
    "IDENTITY_INVALID",
    "KIND_INVALID",
    "NON_WINDOWS_HOST",
    "mutationImplemented",
    '"HANDSHAKE"',
    '"HEALTH"',
  ]) {
    assert.equal(
      source.includes(required),
      true,
      required,
    );
  }

  // WA-NATIVE-NET10-P1: the skeleton targets the .NET 10 LTS line with
  // warnings as errors; nothing else in the project changes.
  const project = await readFile(
    resolve(process.cwd(), "native", "ToadAid.WindowsWorker", "ToadAid.WindowsWorker.csproj"),
    "utf8",
  );
  assert.match(project, /<TargetFramework>net10\.0<\/TargetFramework>/);
  assert.match(project, /<TreatWarningsAsErrors>true<\/TreatWarningsAsErrors>/);
  assert.equal(/PackageReference/.test(project), false, "no package references");

  // LF-only framing: responses must never go through WriteLine (CRLF on Windows).
  assert.equal(source.includes("Console.Out.WriteLine"), false, "Console.Out.WriteLine");
  assert.equal(source.includes("Console.In.ReadLine"), false, "Console.In.ReadLine");

  for (const forbidden of [
    "Process.Start",
    "TerminateProcess",
    "SendInput",
    "SetCursorPos",
    "RegSetValue",
    "CreateProcess",
    "SetValue",
    "InvokePattern",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      forbidden,
    );
  }
});

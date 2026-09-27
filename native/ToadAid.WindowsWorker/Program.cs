using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

const string ProtocolVersion =
    "toadaid.windows-provider-worker.v1";
const int MaxFrameBytes = 256 * 1024;

static string Sha256(string value)
{
    return Convert.ToHexString(
        SHA256.HashData(
            Encoding.UTF8.GetBytes(value)))
        .ToLowerInvariant();
}

static bool ValidId(string value)
{
    return Regex.IsMatch(
        value,
        @"\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\z",
        RegexOptions.CultureInvariant);
}

static void RequireExactTopLevelFields(
    JsonElement root)
{
    if (root.ValueKind != JsonValueKind.Object)
    {
        throw new InvalidOperationException(
            "request root must be object");
    }

    HashSet<string> missing =
        new(
            new[]
            {
                "protocolVersion",
                "requestId",
                "generationId",
                "kind",
                "payload",
            },
            StringComparer.Ordinal);

    int count = 0;
    foreach (
        JsonProperty property
        in root.EnumerateObject())
    {
        count += 1;
        if (!missing.Remove(property.Name))
        {
            throw new InvalidOperationException(
                "request contains unknown field");
        }
    }

    if (count != 5 || missing.Count != 0)
    {
        throw new InvalidOperationException(
            "request contains missing field");
    }
}

static void WriteResponse(
    string requestId,
    string generationId,
    string status,
    object? payload,
    string? errorCode,
    string? errorMessage)
{
    object? error = errorCode is null
        ? null
        : new
        {
            code = errorCode,
            messageSha256 = Sha256(
                errorMessage ?? errorCode),
        };

    var response = new
    {
        protocolVersion = ProtocolVersion,
        requestId,
        generationId,
        status,
        payload,
        error,
    };

    Console.Out.WriteLine(
        JsonSerializer.Serialize(response));
}

string? line = Console.In.ReadLine();
if (line is null)
{
    WriteResponse(
        "startup",
        "generation-unset",
        "ERROR",
        null,
        "FRAME_MISSING",
        "worker request frame missing");
    return 2;
}

if (Console.In.Peek() != -1)
{
    WriteResponse(
        "startup",
        "generation-unset",
        "ERROR",
        null,
        "FRAME_MULTILINE",
        "worker accepts exactly one JSON line");
    return 2;
}

if (
    line.Contains('\r') ||
    line.Contains('\n'))
{
    WriteResponse(
        "startup",
        "generation-unset",
        "ERROR",
        null,
        "FRAME_MULTILINE",
        "worker accepts exactly one JSON line");
    return 2;
}

if (
    Encoding.UTF8.GetByteCount(line) + 1 >
    MaxFrameBytes)
{
    WriteResponse(
        "startup",
        "generation-unset",
        "ERROR",
        null,
        "FRAME_TOO_LARGE",
        "worker request frame too large");
    return 2;
}

string requestId = "request-unparsed";
string generationId = "generation-unset";

try
{
    using JsonDocument document =
        JsonDocument.Parse(line);
    JsonElement root =
        document.RootElement;

    RequireExactTopLevelFields(root);

    string version =
        root.GetProperty(
            "protocolVersion")
        .GetString() ?? "";
    requestId =
        root.GetProperty(
            "requestId")
        .GetString() ??
        requestId;
    generationId =
        root.GetProperty(
            "generationId")
        .GetString() ??
        generationId;
    string kind =
        root.GetProperty(
            "kind")
        .GetString() ?? "";

    if (version != ProtocolVersion)
    {
        WriteResponse(
            requestId,
            generationId,
            "ERROR",
            null,
            "PROTOCOL_MISMATCH",
            "worker protocol version mismatch");
        return 2;
    }

    if (
        !ValidId(requestId) ||
        !ValidId(generationId))
    {
        WriteResponse(
            "request-invalid",
            "generation-invalid",
            "ERROR",
            null,
            "IDENTITY_INVALID",
            "request or generation id invalid");
        return 2;
    }

    if (
        kind != "HANDSHAKE" &&
        kind != "HEALTH" &&
        kind != "OBSERVE")
    {
        WriteResponse(
            requestId,
            generationId,
            "ERROR",
            null,
            "KIND_INVALID",
            "worker request kind invalid");
        return 2;
    }

    _ = root.GetProperty("payload");

    if (!OperatingSystem.IsWindows())
    {
        WriteResponse(
            requestId,
            generationId,
            "ERROR",
            null,
            "NON_WINDOWS_HOST",
            "native Windows worker requires Windows");
        return 2;
    }

    if (kind == "OBSERVE")
    {
        WriteResponse(
            requestId,
            generationId,
            "ERROR",
            null,
            "UNIMPLEMENTED_KIND",
            "native skeleton does not implement observation");
        return 2;
    }

    WriteResponse(
        requestId,
        generationId,
        "OK",
        new
        {
            workerKind =
                "toadaid-windows-native-skeleton",
            mutationImplemented =
                false,
            supportedKinds =
                new[]
                {
                    "HANDSHAKE",
                    "HEALTH",
                },
        },
        null,
        null);
    return 0;
}
catch (Exception error)
{
    WriteResponse(
        requestId,
        generationId,
        "ERROR",
        null,
        "MALFORMED_REQUEST",
        error.GetType().Name);
    return 2;
}

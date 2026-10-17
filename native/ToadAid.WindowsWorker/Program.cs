using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// WA native worker SKELETON (protocol v1): HANDSHAKE / HEALTH only. OBSERVE is
// UNIMPLEMENTED_KIND. No observation, no mutation, no host service.
//
// Framing law (same as the strict Node decoder): exactly one UTF-8 JSON object
// followed by exactly one LF byte; no CR, no BOM, at most 256 KiB. Responses
// are written as raw UTF-8 bytes + "\n" (never Console.WriteLine, which emits
// CRLF on Windows). Payloads are validated strictly and recursively.

const string ProtocolVersion =
    "toadaid.windows-provider-worker.v1";
const int MaxFrameBytes = 256 * 1024;
const int MaxPayloadDepth = 8;
const int MaxStringLength = 65_536;
const int MaxArrayLength = 4_096;
const int MaxObjectKeys = 512;
const int MaxKeyLength = 128;

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
                "request contains unknown or duplicate field");
        }
    }

    if (count != 5 || missing.Count != 0)
    {
        throw new InvalidOperationException(
            "request contains missing field");
    }
}

// Mirrors the Node normalizer: bounded depth, sizes and keys; duplicate keys
// are compared after JSON unescaping (JsonProperty.Name is unescaped);
// "__proto__" and NUL-bearing or empty keys are refused.
static void RequireStrictPayload(
    JsonElement value,
    int depth)
{
    if (depth > MaxPayloadDepth)
    {
        throw new InvalidOperationException(
            "payload nesting is too deep");
    }

    switch (value.ValueKind)
    {
        case JsonValueKind.Object:
            HashSet<string> keys =
                new(StringComparer.Ordinal);
            foreach (
                JsonProperty property
                in value.EnumerateObject())
            {
                string key = property.Name;
                if (
                    key.Length < 1 ||
                    key.Length > MaxKeyLength ||
                    key.Contains('\0') ||
                    key == "__proto__")
                {
                    throw new InvalidOperationException(
                        "payload key is invalid");
                }
                if (!keys.Add(key))
                {
                    throw new InvalidOperationException(
                        "payload contains a duplicate key");
                }
                if (keys.Count > MaxObjectKeys)
                {
                    throw new InvalidOperationException(
                        "payload object has too many keys");
                }
                RequireStrictPayload(
                    property.Value,
                    depth + 1);
            }
            break;
        case JsonValueKind.Array:
            int length = 0;
            foreach (
                JsonElement item
                in value.EnumerateArray())
            {
                length += 1;
                if (length > MaxArrayLength)
                {
                    throw new InvalidOperationException(
                        "payload array is too large");
                }
                RequireStrictPayload(
                    item,
                    depth + 1);
            }
            break;
        case JsonValueKind.String:
            if (
                (value.GetString() ?? "").Length >
                MaxStringLength)
            {
                throw new InvalidOperationException(
                    "payload string is too large");
            }
            break;
        default:
            break;
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

    byte[] bytes =
        Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(response) + "\n");
    using Stream stdout =
        Console.OpenStandardOutput();
    stdout.Write(bytes, 0, bytes.Length);
    stdout.Flush();
}

static int Refuse(
    string code,
    string message)
{
    WriteResponse(
        "startup",
        "generation-unset",
        "ERROR",
        null,
        code,
        message);
    return 2;
}

// Read the whole one-shot frame as raw bytes, bounded (never decoded by the
// console code page and never via ReadLine, which hides CR/LF details).
byte[] frame;
using (Stream stdin = Console.OpenStandardInput())
using (MemoryStream buffer = new())
{
    byte[] chunk = new byte[16 * 1024];
    int read;
    while (
        (read = stdin.Read(chunk, 0, chunk.Length)) > 0)
    {
        buffer.Write(chunk, 0, read);
        if (buffer.Length > MaxFrameBytes)
        {
            break;
        }
    }
    frame = buffer.ToArray();
}

if (frame.Length == 0)
{
    return Refuse(
        "FRAME_MISSING",
        "worker request frame missing");
}

if (frame.Length > MaxFrameBytes)
{
    return Refuse(
        "FRAME_TOO_LARGE",
        "worker request frame too large");
}

if (
    frame.Length >= 3 &&
    frame[0] == 0xEF &&
    frame[1] == 0xBB &&
    frame[2] == 0xBF)
{
    return Refuse(
        "FRAME_ENCODING_INVALID",
        "worker request frame must not start with a BOM");
}

int lineFeeds = 0;
bool carriageReturn = false;
foreach (byte b in frame)
{
    if (b == (byte)'\n')
    {
        lineFeeds += 1;
    }
    else if (b == (byte)'\r')
    {
        carriageReturn = true;
    }
}

if (frame[^1] != (byte)'\n')
{
    return Refuse(
        "FRAME_UNTERMINATED",
        "worker request frame must end with one LF");
}

if (
    lineFeeds != 1 ||
    carriageReturn)
{
    return Refuse(
        "FRAME_MULTILINE",
        "worker accepts exactly one JSON line");
}

string line;
try
{
    line =
        new UTF8Encoding(false, true)
        .GetString(frame, 0, frame.Length - 1);
}
catch (DecoderFallbackException)
{
    return Refuse(
        "FRAME_ENCODING_INVALID",
        "worker request frame is not valid UTF-8");
}

string requestId = "request-unparsed";
string generationId = "generation-unset";

try
{
    using JsonDocument document =
        JsonDocument.Parse(
            line,
            new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = MaxPayloadDepth + 2,
            });
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

    RequireStrictPayload(
        root.GetProperty("payload"),
        0);

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
        ValidId(requestId) ? requestId : "request-invalid",
        ValidId(generationId) ? generationId : "generation-invalid",
        "ERROR",
        null,
        "MALFORMED_REQUEST",
        error.GetType().Name);
    return 2;
}

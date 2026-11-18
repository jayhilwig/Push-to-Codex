using System.Buffers.Binary;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PushToCodex;

internal static class Program
{
    private const int MaxMessage = 1024 * 1024;
    private const string Manifest = "com.push_to_codex.host.json";

    [STAThread]
    private static void Main(string[] args)
    {
        using Stream output = Console.OpenStandardOutput();
        try
        {
            if (!IsAuthorized(args))
            {
                Reply(output, "helper_forbidden");
                return;
            }

            using Stream input = Console.OpenStandardInput();
            var request = ReadRequest(input);
            if (request is null)
            {
                Reply(output, "invalid");
                return;
            }

            using var gate = new Mutex(false, @"Local\PushToCodex.Transfer");
            if (!TakeGate(gate))
            {
                Reply(output, "in_progress");
                return;
            }
            try
            {
                // UI Automation calls can block inside an external provider. Bound host lifetime too.
                using var watchdog = new Timer(_ => Environment.Exit(1), null, 18_000, Timeout.Infinite);
                Reply(output, DesktopTransfer.Run(request));
            }
            finally
            {
                gate.ReleaseMutex();
            }
        }
        catch (Exception)
        {
            // Native stdout is reserved for framed results. Details may contain prompt text.
            Reply(output, "unknown_outcome");
        }
    }

    private static bool IsAuthorized(string[] args)
    {
        if (args.Length == 0 || !Regex.IsMatch(args[0], @"\Achrome-extension://[a-p]{32}/\z"))
            return false;

        try
        {
            using var manifest = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, Manifest)));
            var origins = manifest.RootElement.GetProperty("allowed_origins");
            return origins.GetArrayLength() == 1 && origins[0].GetString() == args[0];
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidOperationException or KeyNotFoundException)
        {
            return false;
        }
    }

    private static Transfer? ReadRequest(Stream input)
    {
        try
        {
            Span<byte> header = stackalloc byte[4];
            input.ReadExactly(header);
            int size = BinaryPrimitives.ReadInt32LittleEndian(header);
            if (size <= 0 || size > MaxMessage) return null;

            var body = new byte[size];
            input.ReadExactly(body);
            using var json = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 2 });
            if (json.RootElement.ValueKind != JsonValueKind.Object) return null;
            var fields = json.RootElement.EnumerateObject().ToArray();
            if (fields.Length != 3 || fields.Select(field => field.Name).Distinct().Count() != 3) return null;

            var request = json.RootElement;
            if (!request.TryGetProperty("prompt", out var prompt) || prompt.ValueKind != JsonValueKind.String ||
                !request.TryGetProperty("mode", out var mode) || mode.ValueKind != JsonValueKind.String ||
                !request.TryGetProperty("submit", out var submit) || submit.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                return null;

            string text = prompt.GetString()!;
            string? modeName = mode.GetString();
            if (string.IsNullOrWhiteSpace(text) || text.Contains('\0') || modeName is not ("active" or "new"))
                return null;

            return new Transfer(text, modeName == "new", submit.GetBoolean());
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    private static bool TakeGate(Mutex gate)
    {
        try { return gate.WaitOne(0); }
        catch (AbandonedMutexException) { return true; }
    }

    private static void Reply(Stream output, string code)
    {
        try
        {
            byte[] body = JsonSerializer.SerializeToUtf8Bytes(new { code });
            Span<byte> header = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(header, body.Length);
            output.Write(header);
            output.Write(body);
            output.Flush();
        }
        catch (IOException) { }
    }
}

internal sealed record Transfer(string Prompt, bool NewChat, bool Submit);

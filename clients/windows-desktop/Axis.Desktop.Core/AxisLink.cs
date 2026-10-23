using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Axis.Desktop;

/** Who this client is, as it tells Axis on every connection. */
public sealed record ClientIdentity(string Type, string Version, string[] Capabilities, JsonObject Describe);

/** What the client holds once paired. Kept by the app; the token is a secret. */
public sealed record Pairing(string Address, string ClientId, string Token, string Name);

/** A command's answer: `Data` for a structured one, `Payload` for a few values. */
public sealed record CommandAnswer(bool Ok, string? Error = null, JsonObject? Payload = null, JsonNode? Data = null)
{
    public static CommandAnswer Fail(string error) => new(false, error);
    public static CommandAnswer Done(JsonObject? payload = null, JsonNode? data = null) => new(true, null, payload, data);
}

public enum LinkState { Stopped, Connecting, Online, Offline, Refused }

/**
 * One connection to Axis, kept open: hello, welcome, describe, settings and commands, protocol 1.
 * Reconnects by itself after a drop, waiting longer each time up to half a minute. A refused token
 * stops it for good (the pairing is gone; pair again).
 */
public sealed class AxisLink : IAsyncDisposable
{
    public const int Protocol = 1;
    static readonly int[] BackoffSeconds = [1, 2, 5, 10, 30];
    // With a resolver: options made by hand have none, and then any value not built from a plain string, number or
    // bool (JsonArray.Add<T>, JsonValue.Create<T>) cannot be written. That broke every look in 0.4.0 to 0.4.3.
    static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver(),
    };

    readonly ClientIdentity identity;
    readonly Pairing pairing;
    CancellationTokenSource? stop;
    Task? running;
    ClientWebSocket? socket;
    readonly SemaphoreSlim sendLock = new(1, 1);
    int settingsVersion;

    /** Called with every change of state, with a few words on why when there are any. */
    public event Action<LinkState, string?>? StateChanged;
    /** Called with the full resolved settings whenever Axis sends them. */
    public event Action<IReadOnlyDictionary<string, JsonElement>>? SettingsChanged;
    /** Carries out a command from Axis. Unset, every command is answered "not implemented". */
    public Func<string, JsonElement, CancellationToken, Task<CommandAnswer>>? OnCommand { get; set; }
    /** Every message from Axis this class does not handle itself (turns, speech, replies), as it came. */
    public event Action<string, JsonElement>? Message;
    /** Audio from Axis: the binary frames between a speak.start and its speak.end. */
    public event Action<byte[]>? Audio;
    /** How much speech this client can hold ahead of playing it; set when it has a speaker. */
    public int AudioBufferMs { get; init; }

    public LinkState State { get; private set; } = LinkState.Stopped;
    public AxisAddress Address { get; }

    public AxisLink(Pairing pairing, ClientIdentity identity)
    {
        this.pairing = pairing;
        this.identity = identity;
        Address = AxisAddress.Parse(pairing.Address);
    }

    /** Pairs with a one-time code from Axis's admin page ("Add a device"). */
    public static async Task<Pairing> PairAsync(AxisAddress address, string code, string name, ClientIdentity identity, CancellationToken ct = default)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var body = new JsonObject
        {
            ["code"] = code.Trim(),
            ["type"] = identity.Type,
            ["version"] = identity.Version,
            ["capabilities"] = new JsonArray(identity.Capabilities.Select(c => (JsonNode?)JsonValue.Create(c)).ToArray()),
        };
        if (!string.IsNullOrWhiteSpace(name)) body["name"] = name.Trim();
        using var res = await http.PostAsync(address.Pair, new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"), ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        JsonNode? reply = null;
        try { reply = JsonNode.Parse(text); } catch (JsonException) { }
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException(reply?["error"]?.GetValue<string>() ?? $"Axis said {(int)res.StatusCode}.");
        return new Pairing(address.ToString(), reply!["clientId"]!.GetValue<string>(), reply["token"]!.GetValue<string>(), reply["name"]!.GetValue<string>());
    }

    public void Start()
    {
        if (running != null) return;
        stop = new CancellationTokenSource();
        running = Task.Run(() => RunAsync(stop.Token));
    }

    volatile bool woke;

    /**
     * The computer woke or the network came back: the socket it holds is most likely dead without knowing it (after a
     * sleep it can look open for minutes), so it is dropped and the connection made again at once, with no wait left
     * over from earlier failures.
     */
    public void Nudge()
    {
        if (running == null) return;
        woke = true;
        try { socket?.Abort(); } catch { }
    }

    public async Task StopAsync()
    {
        if (stop == null) return;
        stop.Cancel();
        try { socket?.Abort(); } catch { }
        try { if (running != null) await running; } catch { }
        running = null;
        stop = null;
        SetState(LinkState.Stopped, null);
    }

    public async ValueTask DisposeAsync() => await StopAsync();

    void SetState(LinkState state, string? why)
    {
        State = state;
        StateChanged?.Invoke(state, why);
    }

    async Task RunAsync(CancellationToken ct)
    {
        var attempt = 0;
        while (!ct.IsCancellationRequested)
        {
            SetState(LinkState.Connecting, null);
            string? why = null;
            try
            {
                var refused = await SessionAsync(ct);
                if (refused != null)
                {
                    SetState(LinkState.Refused, refused);
                    return;
                }
                attempt = 0;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception e) { why = e.Message; }
            var wait = BackoffSeconds[Math.Min(attempt++, BackoffSeconds.Length - 1)];
            SetState(LinkState.Offline, why ?? "connection closed");
            // Waited in slices, so a wake or a network coming back cuts the wait short.
            try
            {
                for (var waited = 0; waited < wait * 1000; waited += 250)
                {
                    if (woke) { woke = false; attempt = 0; break; }
                    await Task.Delay(250, ct);
                }
            }
            catch (OperationCanceledException) { return; }
        }
    }

    /** One connection, to its end. Returns why Axis refused this client for good, or null for an ordinary drop. */
    async Task<string?> SessionAsync(CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);        socket = ws;
        using (var connectCt = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            connectCt.CancelAfter(TimeSpan.FromSeconds(15));
            await ws.ConnectAsync(Address.Socket, connectCt.Token);
        }
        var hello = new JsonObject
        {
            ["t"] = "hello",
            ["protocol"] = Protocol,
            ["clientId"] = pairing.ClientId,
            ["token"] = pairing.Token,
            ["type"] = identity.Type,
            ["version"] = identity.Version,
            ["capabilities"] = new JsonArray(identity.Capabilities.Select(c => (JsonNode?)JsonValue.Create(c)).ToArray()),
            ["settingsVersion"] = settingsVersion,
            // Big enough for anything Axis might send.
            ["maxFrameBytes"] = 65536,
        };
        if (AudioBufferMs > 0) hello["audioBufferMs"] = AudioBufferMs;
        await SendAsync(hello, ct);

        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                result = await ws.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close) return CloseReason(ws);
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);
            if (result.MessageType != WebSocketMessageType.Text)
            {
                Audio?.Invoke(message.ToArray());
                continue;
            }

            using var doc = JsonDocument.Parse(message.ToArray());
            var root = doc.RootElement;
            switch (root.GetProperty("t").GetString())
            {
                case "welcome":
                    await SendAsync(DescribeMessage(), ct);
                    SetState(LinkState.Online, null);
                    break;
                case "settings":
                    settingsVersion = root.GetProperty("version").GetInt32();
                    var values = new Dictionary<string, JsonElement>();
                    foreach (var p in root.GetProperty("values").EnumerateObject()) values[p.Name] = p.Value.Clone();
                    SettingsChanged?.Invoke(values);
                    break;
                case "command":
                    // Each command runs on its own, so a slow look does not hold up a point.
                    var id = root.GetProperty("id").GetString()!;
                    var name = root.GetProperty("name").GetString()!;
                    var parameters = root.TryGetProperty("params", out var p2) ? p2.Clone() : default;
                    // Structured arguments (desktop.steps) arrive beside the params; the handler sees them as params.data.
                    if (root.TryGetProperty("data", out var extra))
                    {
                        var merged = parameters.ValueKind == JsonValueKind.Object ? (JsonObject)JsonNode.Parse(parameters.GetRawText())! : new JsonObject();
                        merged["data"] = JsonNode.Parse(extra.GetRawText());
                        parameters = JsonDocument.Parse(merged.ToJsonString()).RootElement.Clone();
                    }
                    var receivedAt = Environment.TickCount64;
                    _ = Task.Run(() => AnswerAsync(id, name, parameters, ct, receivedAt), ct);
                    break;
                case "turn" or "transcript" or "reply.text" or "reply.image" or "speak.start" or "speak.end" or "stop" or "ask" or "ask.end" or "status":
                    Message?.Invoke(root.GetProperty("t").GetString()!, root.Clone());
                    break;
                case "error":
                    var code = root.GetProperty("code").GetString();
                    var text = root.GetProperty("message").GetString();
                    if (code == "unauthorized") return $"Axis no longer knows this computer ({text}). Pair it again.";
                    if (code == "unsupported_protocol") return $"Axis speaks another protocol ({text}). Update the app.";
                    break;
            }
        }
        return null;
    }

    static string? CloseReason(ClientWebSocket ws) =>
        ws.CloseStatusDescription is { Length: > 0 } d && d.Contains("token", StringComparison.OrdinalIgnoreCase) ? $"Axis refused this computer: {d}. Pair it again." : null;

    /** Something went wrong answering Axis that Axis itself will never hear about: said in the app instead. */
    public event Action<string>? Trouble;

    async Task AnswerAsync(string id, string name, JsonElement parameters, CancellationToken ct, long receivedAt)
    {
        var started = Environment.TickCount64;
        if (started - receivedAt > 1000) Trouble?.Invoke($"{name} waited {started - receivedAt} ms to start ({DesktopCommands.Busy()})");
        CommandAnswer answer;
        try
        {
            answer = OnCommand == null ? CommandAnswer.Fail("not implemented on this device") : await OnCommand(name, parameters, ct);
        }
        catch (Exception e)
        {
            // Some Windows errors carry no message; the kind of error is still worth knowing.
            answer = CommandAnswer.Fail(string.IsNullOrWhiteSpace(e.Message) ? $"{e.GetType().Name} (0x{e.HResult:X8})" : $"{e.Message} ({e.GetType().Name})");
        }
        try
        {
            var reply = new JsonObject { ["t"] = "command.result", ["id"] = id, ["ok"] = answer.Ok };
            if (answer.Payload != null) reply["payload"] = answer.Payload;
            if (answer.Data != null) reply["data"] = answer.Data;
            if (answer.Error != null) reply["error"] = answer.Error.Length > 256 ? answer.Error[..255] + "…" : answer.Error;
            var sending = Environment.TickCount64;
            await SendAsync(reply, ct);
            var sent = Environment.TickCount64;
            // Axis waits 15 s for most commands; an answer near that is as good as lost, so the app says where the time went.
            if (sent - receivedAt > 10000)
                Trouble?.Invoke($"{name} answered after {sent - receivedAt} ms (work {sending - started}, sending {sent - sending}; {DesktopCommands.Busy()})");
        }
        catch (Exception e)
        {
            // Before 0.4.3 this was swallowed: an answer that never left looked like the computer not answering.
            Trouble?.Invoke($"{name}: the answer could not be sent: {e.Message} ({e.GetType().Name})");
        }
    }

    JsonObject DescribeMessage()
    {
        var d = (JsonObject)identity.Describe.DeepClone();
        d["t"] = "describe";
        d.TryAdd("settings", new JsonArray());
        d.TryAdd("actions", new JsonArray());
        d.TryAdd("links", new JsonArray());
        return d;
    }

    /** Sends a message, for the voice part; false when not connected. */
    public async Task<bool> TrySendAsync(JsonObject message)
    {
        try { await SendAsync(message, CancellationToken.None); return true; }
        catch { return false; }
    }

    /**
     * A POST to one of Axis's client routes (`/v1/timers/cancel`), as this client: its token and id in the headers, as the
     * web client sends them. True when Axis said yes.
     */
    public async Task<bool> PostAsync(string path, JsonObject body, CancellationToken ct = default)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(Address.Http, path))
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", pairing.Token);
        request.Headers.Add("x-axis-client", pairing.ClientId);
        try
        {
            using var res = await http.SendAsync(request, ct);
            return res.IsSuccessStatusCode;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { return false; }
    }

    /** Sends a frame of microphone audio. */
    public async Task<bool> TrySendAudioAsync(ReadOnlyMemory<byte> pcm)
    {
        var ws = socket;
        if (ws == null || ws.State != WebSocketState.Open) return false;
        await sendLock.WaitAsync();
        try { await ws.SendAsync(pcm, WebSocketMessageType.Binary, true, CancellationToken.None); return true; }
        catch { return false; }
        finally { sendLock.Release(); }
    }

    async Task SendAsync(JsonObject message, CancellationToken ct)
    {
        var ws = socket ?? throw new InvalidOperationException("not connected");
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString(Json));
        await sendLock.WaitAsync(ct);
        try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct); }
        finally { sendLock.Release(); }
    }
}

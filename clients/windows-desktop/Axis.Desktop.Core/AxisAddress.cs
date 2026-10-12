namespace Axis.Desktop;

/**
 * Where Axis is, from whatever a person pastes: an address with or without its scheme, or a
 * setup string (axis://host:port/code, axis+tls:// for an encrypted address) that carries the
 * pairing code too.
 */
public sealed record AxisAddress(Uri Http, string? Code)
{
    public const string PairPath = "/v1/pair";
    public const string SocketPath = "/v1/client";

    public Uri Pair => new(Http, PairPath);

    public Uri Socket
    {
        get
        {
            var b = new UriBuilder(Http) { Scheme = Http.Scheme == "https" ? "wss" : "ws", Path = SocketPath };
            if (b.Uri.IsDefaultPort) b.Port = -1;
            return b.Uri;
        }
    }

    /** The address as it is kept and shown: the http(s) base, no path. */
    public override string ToString() => Http.GetLeftPart(UriPartial.Authority);

    /**
     * Reads an address. A bare host:port is taken as plain http (a hub on the local network); a bare
     * name as https (a hub under a public name). An explicit scheme wins.
     */
    public static AxisAddress Parse(string input)
    {
        var text = (input ?? "").Trim();
        if (text.Length == 0) throw new FormatException("Give Axis's address.");
        string? code = null;
        string scheme;
        if (text.StartsWith("axis+tls://", StringComparison.OrdinalIgnoreCase) || text.StartsWith("axis://", StringComparison.OrdinalIgnoreCase))
        {
            scheme = text.StartsWith("axis+tls://", StringComparison.OrdinalIgnoreCase) ? "https" : "http";
            text = text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..];
            var slash = text.IndexOf('/');
            if (slash >= 0)
            {
                code = text[(slash + 1)..].Trim('/');
                if (code.Length == 0) code = null;
                text = text[..slash];
            }
        }
        else if (text.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || text.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            scheme = text.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? "https" : "http";
            text = text[(text.IndexOf("://", StringComparison.Ordinal) + 3)..];
            var slash = text.IndexOf('/');
            if (slash >= 0) text = text[..slash];
        }
        else
        {
            var slash = text.IndexOf('/');
            if (slash >= 0) text = text[..slash];
            scheme = text.Contains(':') ? "http" : "https";
        }
        if (!Uri.TryCreate($"{scheme}://{text}/", UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host))
            throw new FormatException($"\"{input}\" is not an address.");
        return new AxisAddress(uri, code);
    }
}

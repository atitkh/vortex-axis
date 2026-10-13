using System.Security.Cryptography;
using System.Text.Json;

namespace Axis.Desktop;

/**
 * Fetching a newer build of this app from Axis, for Axis's `update` command: `{version, size, sha256, path}`.
 * The download proves who is asking with the computer's own token, and the file is kept only if its size and
 * SHA-256 match what Axis said. Putting it in place and restarting is the platform's part.
 */
public static class AppUpdate
{
    public sealed record Offer(string Version, long Size, string Sha256, string Path);

    public static Offer Read(JsonElement p)
    {
        string S(string key) => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        var size = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("size", out var n) && n.ValueKind == JsonValueKind.Number ? n.GetInt64() : 0;
        var offer = new Offer(S("version"), size, S("sha256").ToLowerInvariant(), S("path"));
        if (offer.Version.Length == 0 || offer.Size <= 0 || offer.Sha256.Length != 64 || !offer.Path.StartsWith('/'))
            throw new FormatException("the update offer is incomplete");
        return offer;
    }

    /** Downloads the offer to `file` and checks it. Throws, leaving no file, when anything does not match. */
    public static async Task DownloadAsync(Pairing pairing, Offer offer, string file, CancellationToken ct)
    {
        var address = AxisAddress.Parse(pairing.Address);
        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(address.Http, offer.Path));
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", pairing.Token);
        request.Headers.Add("X-Axis-Client", pairing.ClientId);
        try
        {
            using var res = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"Axis answered {(int)res.StatusCode} to the download");
            await using (var output = File.Create(file))
            await using (var input = await res.Content.ReadAsStreamAsync(ct))
                await input.CopyToAsync(output, ct);
            var length = new FileInfo(file).Length;
            if (length != offer.Size) throw new InvalidOperationException($"the download is {length} bytes, not {offer.Size}");
            string hash;
            await using (var check = File.OpenRead(file)) hash = Convert.ToHexString(await SHA256.HashDataAsync(check, ct)).ToLowerInvariant();
            if (hash != offer.Sha256) throw new InvalidOperationException("the download does not match its checksum");
        }
        catch
        {
            try { File.Delete(file); } catch { }
            throw;
        }
    }
}

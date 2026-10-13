using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;

namespace Axis.Desktop.App;

/**
 * What the app keeps between runs, in %APPDATA%\VorteX Axis\desktop.json: the pairing (the token
 * encrypted for this Windows user with DPAPI) and the person's own choices.
 */
public sealed class Saved
{
    public string? Address { get; set; }
    public string? ClientId { get; set; }
    public string? Name { get; set; }
    public string? TokenProtected { get; set; }
    public bool Paused { get; set; }
    /** Talking from this computer (its microphone and speakers as an Axis device). On unless switched off. */
    public bool Voice { get; set; } = true;
    /** The pill at the top of the screen while an agent is using this computer. */
    public bool ShowControl { get; set; } = true;
    /** Vortex's face at the bottom of the screen during a turn and while an agent is at this computer. */
    public bool ShowFace { get; set; } = true;
    /** The face stays on screen between turns, and a click on it talks. */
    public bool KeepFace { get; set; }

    static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "VorteX Axis");
    static string FilePath => Path.Combine(Folder, "desktop.json");

    public static Saved Load()
    {
        try { return JsonSerializer.Deserialize<Saved>(File.ReadAllText(FilePath)) ?? new Saved(); }
        catch { return new Saved(); }
    }

    public void Store()
    {
        Directory.CreateDirectory(Folder);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    /** Never written as it is: only the encrypted token goes to the file. */
    [JsonIgnore]
    public Pairing? Pairing
    {
        get
        {
            if (Address == null || ClientId == null || TokenProtected == null) return null;
            try
            {
                var token = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(TokenProtected), null, DataProtectionScope.CurrentUser));
                return new Pairing(Address, ClientId, token, Name ?? ClientId);
            }
            catch { return null; }
        }
        set
        {
            Address = value?.Address;
            ClientId = value?.ClientId;
            Name = value?.Name;
            TokenProtected = value == null ? null : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value.Token), null, DataProtectionScope.CurrentUser));
        }
    }

    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string RunName = "VorteX Axis Desktop";

    /** Starting with Windows, as the per-user Run entry. */
    public static bool StartWithWindows
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(RunName) != null;
        }
        set
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (value) key.SetValue(RunName, $"\"{Environment.ProcessPath}\" --tray");
            else key.DeleteValue(RunName, false);
        }
    }
}

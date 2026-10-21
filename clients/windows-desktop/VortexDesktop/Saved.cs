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
    /** The talk key, one of App.TalkKeys. */
    public string TalkKey { get; set; } = "ctrl+alt+space";
    /** A key of its own for typing to the agent, one of App.TalkKeys; empty: a tap on the talk key types. */
    public string TypingKey { get; set; } = "";
    /** Microphone and speaker by Windows' number for them; -1 is Windows' default. */
    public int MicDevice { get; set; } = -1;
    public int SpeakerDevice { get; set; } = -1;
    /** The face's size and where along the bottom of the screen it sits (FaceWindow.Sizes, Places). */
    public string FaceSize { get; set; } = "medium";
    /** "center", "left" or "right" along the bottom, or "custom": where FaceX and FaceY (the face's middle, in screen units) say. */
    public string FacePlace { get; set; } = "center";
    public double? FaceX { get; set; }
    public double? FaceY { get; set; }

    static string Folder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "VorteX Axis");
    static string FilePath => Path.Combine(Folder, "desktop.json");

    /** The last good copy: a write cut short (power, a crash) must not cost the pairing. */
    public static Saved Load()
    {
        foreach (var path in new[] { FilePath, FilePath + ".bak" })
        {
            try
            {
                if (File.Exists(path) && JsonSerializer.Deserialize<Saved>(File.ReadAllText(path)) is { } found) return found;
            }
            catch (Exception e) { Diag.Log($"could not read {Path.GetFileName(path)}: {e.Message}"); }
        }
        return new Saved();
    }

    /** Written beside the file and swapped in, so the file is always whole. Never throws: a full disk is logged, not fatal. */
    public void Store()
    {
        try
        {
            Directory.CreateDirectory(Folder);
            var fresh = FilePath + ".new";
            File.WriteAllText(fresh, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
            if (File.Exists(FilePath)) File.Replace(fresh, FilePath, FilePath + ".bak");
            else File.Move(fresh, FilePath);
        }
        catch (Exception e) { Diag.Log($"could not save settings: {e.Message}"); }
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

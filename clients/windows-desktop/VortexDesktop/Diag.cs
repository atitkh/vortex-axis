using System;
using System.IO;

namespace Axis.Desktop.App;

/** A small log next to the settings (%APPDATA%\VorteX Axis\desktop.log), for what went wrong while nobody was looking. */
static class Diag
{
    static readonly object Gate = new();
    const long Largest = 200_000;

    static string FilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "VorteX Axis", "desktop.log");

    public static void Log(string line)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                // Kept short: when it grows past the limit, the old half goes.
                var info = new FileInfo(FilePath);
                if (info.Exists && info.Length > Largest)
                {
                    var lines = File.ReadAllLines(FilePath);
                    File.WriteAllLines(FilePath, lines[(lines.Length / 2)..]);
                }
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
            }
        }
        catch { /* nothing left to report it to */ }
    }
}

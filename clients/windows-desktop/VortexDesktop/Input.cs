using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Axis.Desktop.App;

/**
 * Real mouse and keyboard input, through SendInput, in physical screen pixels (the app is per-monitor
 * DPI aware). A click moves the person's mouse there for an instant and puts it back where it was.
 */
static class Input
{
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10;
    const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short VkKeyScan(char c);

    static void Send(List<INPUT> inputs)
    {
        if (inputs.Count == 0) return;
        var sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<INPUT>());
        if (sent != inputs.Count)
            throw new InvalidOperationException("Windows refused the input (an app running as administrator is in front, or the screen is locked)");
    }

    static INPUT Mouse(uint flags) => new() { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags } } };
    static INPUT Key(ushort vk, bool up, bool extended = false) =>
        new() { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0) } } };
    static INPUT Unicode(char c, bool up) =>
        new() { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wScan = c, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0) } } };

    /** Clicks at (x, y) and puts the mouse back where it was. */
    public static void Click(int x, int y, ClickKind kind)
    {
        Native.GetCursorPos(out var was);
        try
        {
            SetCursorPos(x, y);
            Thread.Sleep(30);  // lets the window under it see the mouse arrive, as hover menus need
            var (down, up) = kind == ClickKind.Right ? (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) : (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
            var inputs = new List<INPUT> { Mouse(down), Mouse(up) };
            if (kind == ClickKind.Double) inputs.AddRange([Mouse(down), Mouse(up)]);
            Send(inputs);
            Thread.Sleep(30);
        }
        finally
        {
            SetCursorPos(was.X, was.Y);
        }
    }

    const uint MOUSEEVENTF_MOVE = 0x1, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;

    /** A move to (x, y) as input, which a drag's modal loop sees (SetCursorPos alone may not be). */
    static INPUT MoveTo(int x, int y)
    {
        var desk = System.Windows.Forms.SystemInformation.VirtualScreen;
        var mi = new MOUSEINPUT
        {
            dx = (int)Math.Round((x - desk.X) * 65535.0 / Math.Max(1, desk.Width - 1)),
            dy = (int)Math.Round((y - desk.Y) * 65535.0 / Math.Max(1, desk.Height - 1)),
            dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        };
        return new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = mi } };
    }

    /**
     * Drags with the left button from (x1, y1) to (x2, y2): down, held `holdMs` (a little at least, so the press
     * is seen), moved in steps over `moveMs`, a moment at rest over the target so it takes the drop, then up.
     * The button is always let go and the mouse put back.
     */
    public static void Drag(int x1, int y1, int x2, int y2, int holdMs, int moveMs)
    {
        Native.GetCursorPos(out var was);
        var down = false;
        try
        {
            SetCursorPos(x1, y1);
            Send([MoveTo(x1, y1)]);
            Thread.Sleep(30);
            Send([Mouse(MOUSEEVENTF_LEFTDOWN)]);
            down = true;
            Thread.Sleep(Math.Max(80, holdMs));
            var steps = Math.Max(10, moveMs / 15);
            for (var i = 1; i <= steps; i++)
            {
                Send([MoveTo(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)]);
                Thread.Sleep(Math.Max(1, moveMs / steps));
            }
            Thread.Sleep(150);
            Send([Mouse(MOUSEEVENTF_LEFTUP)]);
            down = false;
            Thread.Sleep(30);
        }
        finally
        {
            if (down) try { Send([Mouse(MOUSEEVENTF_LEFTUP)]); } catch (InvalidOperationException) { }
            SetCursorPos(was.X, was.Y);
        }
    }

    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;

    /** Turns the mouse wheel over (x, y), `notches` at a time (negative: up or left), and puts the mouse back. */
    public static void Wheel(int x, int y, int notches, bool sideways)
    {
        Native.GetCursorPos(out var was);
        try
        {
            SetCursorPos(x, y);
            Thread.Sleep(30);
            // Down and right are negative and positive in Windows' terms: a vertical wheel's positive is away from the person.
            var delta = sideways ? notches * 120 : -notches * 120;
            for (var left = Math.Abs(notches); left > 0; left -= 5)
            {
                var step = Math.Sign(delta) * 120 * Math.Min(5, left);
                Send([new INPUT { type = INPUT_MOUSE, u = new InputUnion { mi = new MOUSEINPUT { dwFlags = sideways ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, mouseData = unchecked((uint)step) } } }]);
                Thread.Sleep(15);
            }
        }
        finally
        {
            SetCursorPos(was.X, was.Y);
        }
    }

    /** Types text as characters, whatever the keyboard layout; a new line is Enter. */
    public static void Type(string text)
    {
        var inputs = new List<INPUT>();
        foreach (var c in text.Replace("\r\n", "\n"))
        {
            if (c == '\n')
            {
                inputs.Add(Key(0x0D, false));
                inputs.Add(Key(0x0D, true));
            }
            else
            {
                inputs.Add(Unicode(c, false));
                inputs.Add(Unicode(c, true));
            }
        }
        // In pieces, so a long text does not swamp the window it goes to.
        for (var i = 0; i < inputs.Count; i += 64)
        {
            Send(inputs.GetRange(i, Math.Min(64, inputs.Count - i)));
            Thread.Sleep(8);
        }
    }

    static readonly Dictionary<string, (ushort Vk, bool Extended)> Keys = new()
    {
        ["enter"] = (0x0D, false), ["tab"] = (0x09, false), ["escape"] = (0x1B, false), ["backspace"] = (0x08, false),
        ["delete"] = (0x2E, true), ["insert"] = (0x2D, true), ["space"] = (0x20, false),
        ["up"] = (0x26, true), ["down"] = (0x28, true), ["left"] = (0x25, true), ["right"] = (0x27, true),
        ["home"] = (0x24, true), ["end"] = (0x23, true), ["pageup"] = (0x21, true), ["pagedown"] = (0x22, true),
        ["printscreen"] = (0x2C, false), ["capslock"] = (0x14, false), ["menu"] = (0x5D, true),
        ["volumeup"] = (0xAF, true), ["volumedown"] = (0xAE, true), ["volumemute"] = (0xAD, true),
        ["mediaplaypause"] = (0xB3, true), ["medianext"] = (0xB0, true), ["mediaprevious"] = (0xB1, true), ["mediastop"] = (0xB2, true),
    };

    /** Presses one combination: the modifiers down, the key down and up, the modifiers up. */
    public static void Press(KeyCombo combo)
    {
        ushort vk;
        var extended = false;
        if (Keys.TryGetValue(combo.Key, out var named)) (vk, extended) = named;
        else if (combo.Key.Length > 1 && combo.Key[0] == 'f') vk = (ushort)(0x70 + int.Parse(combo.Key[1..]) - 1);
        else
        {
            var scan = VkKeyScan(combo.Key[0]);
            if (scan == -1) throw new InvalidOperationException($"this keyboard layout has no key for \"{combo.Key}\"");
            vk = (ushort)(scan & 0xFF);
        }
        var mods = new List<ushort>();
        if (combo.Ctrl) mods.Add(0x11);
        if (combo.Alt) mods.Add(0x12);
        if (combo.Shift) mods.Add(0x10);
        if (combo.Win) mods.Add(0x5B);
        var inputs = new List<INPUT>();
        foreach (var m in mods) inputs.Add(Key(m, false, m == 0x5B));
        inputs.Add(Key(vk, false, extended));
        inputs.Add(Key(vk, true, extended));
        for (var i = mods.Count - 1; i >= 0; i--) inputs.Add(Key(mods[i], true, mods[i] == 0x5B));
        Send(inputs);
    }
}

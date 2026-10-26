using System.Text.Json;
using System.Text.Json.Nodes;
using Axis.Desktop;

/** The Core's checks that need no Axis: where clicks land, ids after a scroll, the face's settings. `smoke check`. */
static class Checks
{
    static int failed, passed;

    static void Is<T>(T actual, T expected, string what)
    {
        if (EqualityComparer<T>.Default.Equals(actual, expected)) passed++;
        else { failed++; Console.WriteLine($"FAIL {what}: got {actual}, wanted {expected}"); }
    }

    static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    public static async Task<int> RunAsync()
    {
        Clipping();
        ChromeBand();
        await AfterScrollAsync();
        FaceSettings();
        TapOrHold();
        Typing();
        Progress();
        Timers();
        SoundChecks();
        Pictures();
        await CapabilitiesOffAsync();
        ListeningChecks();
        Console.WriteLine($"{passed} passed, {failed} failed");
        return failed == 0 ? 0 : 1;
    }

    static void Clipping()
    {
        var window = new Box(0, 0, 1000, 900);
        var page = new Box(0, 100, 1000, 800);  // under 100 px of tabs and address bar
        // A field half under the top of the page: its middle is on the address bar, the part that shows is not.
        var field = new Box(100, 50, 400, 90);
        var shown = Geometry.Visible(field, [page, window]);
        Is(shown, new Box(100, 100, 400, 40), "the part of a half-hidden field that shows");
        Is(field.Centre.Y < page.Y, true, "the whole field's middle is above the page");
        Is(shown!.Value.Centre, (300, 120), "the middle of what shows is in the page");
        Is(Math.Round(Geometry.Fraction(field, shown), 2), 0.44, "4/9 of it shows");
        Is(Geometry.Enough(field, shown), true, "over 40% is enough to click");
        // A thin sliver: scrolled into view first.
        var sliver = new Box(100, 70, 400, 40);
        Is(Geometry.Enough(sliver, Geometry.Visible(sliver, [page])), false, "a quarter of a field is not enough");
        // Wholly above the page: nothing shows.
        Is(Geometry.Visible(new Box(100, 20, 400, 40), [page]), null, "a field scrolled above the page");
        Is(Geometry.Enough(new Box(100, 20, 400, 40), null), false, "nothing showing is not enough");
        Is(Geometry.Fraction(new Box(100, 20, 400, 40), null), 0.0, "nothing showing is 0");
        // A big control with a big piece showing is clicked there, whatever share that is.
        var tall = new Box(0, -1000, 1000, 3000);
        Is(Geometry.Enough(tall, Geometry.Visible(tall, [page])), true, "a big piece of a tall pane is enough");
        // A frame inside the page, itself half scrolled out: cut by both.
        var frame = new Box(200, 50, 400, 300);
        Is(Geometry.Visible(new Box(250, 80, 100, 40), [frame, page, window]), new Box(250, 100, 100, 20), "a control in a frame, cut by the frame and the page");
        // Wholly inside: as it is.
        Is(Geometry.Visible(new Box(10, 500, 50, 20), [page, window]), new Box(10, 500, 50, 20), "a control wholly in the page");
        Is(Geometry.Shown(new ScreenElement("edit", "Search", 100, 60, 400, 80), new Box(100, 100, 400, 40)),
            new ScreenElement("edit", "Search", 100, 100, 400, 40), "an element cut to what shows");
    }

    static void ChromeBand()
    {
        var chrome = new WindowInfo("Shop - Google Chrome", "chrome", 0, 0, 1000, 900);
        var page = new Box(0, 90, 1000, 810);
        Is(Geometry.IsBrowser("chrome"), true, "chrome is a browser");
        Is(Geometry.IsBrowser("MSEdge.exe"), true, "msedge.exe is a browser");
        Is(Geometry.IsBrowser("firefox"), true, "firefox is a browser");
        Is(Geometry.IsBrowser("notepad"), false, "notepad is not");
        Is(Geometry.ChromeRefusal(chrome, 50, true, page) != null, true, "a page control clicked on the address bar is refused");
        Is(Geometry.ChromeRefusal(chrome, 95, true, page), null, "a page control just below the bar, inside the band, is clicked");
        Is(Geometry.ChromeRefusal(chrome, 50, false, null), null, "the address bar itself is clicked");
        Is(Geometry.ChromeRefusal(chrome, 50, false, page), null, "a tab or button is clicked");
        Is(Geometry.ChromeRefusal(chrome, 300, true, page), null, "below the band, anything goes");
        Is(Geometry.ChromeRefusal(chrome with { App = "notepad" }, 50, true, page), null, "not a browser: not refused");
        Is(Geometry.ChromeRefusal(chrome, 50, true, new Box(0, 0, 1000, 900)), null, "a full-screen page is clicked at the top");
        Is(Geometry.ChromeRefusal(chrome, 50, true, new Box(0, -2000, 1000, 5000)) != null, true, "a page box reaching above the window says nothing: refused");
        Is(Geometry.ChromeRefusal(chrome, 50, true, null) != null, true, "in a page with no box: refused");
        Is(Geometry.ChromeRefusal(chrome with { Y = -8 }, -8 + 99, true, null) != null, true, "a maximized window's band starts at its own top");
        Is(Geometry.ChromeRefusal(null, 50, true, page), null, "no window in front: not refused");
    }

    static Dictionary<string, JsonElement> Values(string json) =>
        Json(json).EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone());

    /** Runs a face for `seconds` in steps of a tenth, and gives the last frame. */
    static (List<Face.Circle> Dots, Face.Circle? Core, Face.Pen? Icon) Run(Face face, double seconds)
    {
        var frame = face.Frame(0);
        for (var t = 0.0; t < seconds - 1e-9; t += 0.1) frame = face.Frame(0.1);
        return frame;
    }

    static int ShapeDots(List<Face.Circle> dots) => dots.Count(d => Math.Abs(d.Radius - FaceIcons.ShapeDot) < 1e-9);

    static void FaceSettings()
    {
        // toolIconDots, as web/vortex.js: dot n is in the shape when n < dots, at point floor(n * 78 / dots).
        Is(Face.ShapePoint(0, 78), 0, "all 78: dot 0 at point 0");
        Is(Face.ShapePoint(77, 78), 77, "all 78: dot 77 at point 77");
        Is(Face.ShapePoint(11, 12), 71, "12 dots: dot 11 at point 71");
        Is(Face.ShapePoint(12, 12), -1, "12 dots: dot 12 stays on its arm");
        Is(Face.ShapePoint(39, 40), 76, "40 dots: dot 39 at point 76");
        Is(Face.ShapePoint(5, 40), 9, "40 dots: dot 5 at point 9");

        // The settings as Axis sends them; out of range brought in, missing is the usual.
        var face = new Face();
        face.UseSettings(Values("""{"toolIcons":"line","toolIconMs":5000,"toolIconDots":5}"""));
        Is(face.IconStyle, "line", "toolIcons line");
        Is(face.IconMs, 3000.0, "toolIconMs at most 3000");
        Is(face.IconDots, 12, "toolIconDots at least 12");
        face.UseSettings(Values("""{"toolIcons":"sparkles","toolIconMs":100,"toolIconDots":40.5}"""));
        Is(face.IconStyle, "dots", "an unknown style is dots");
        Is(face.IconMs, 150.0, "toolIconMs at least 150");
        Is(face.IconDots, 41, "toolIconDots rounded as Math.round");
        face.UseSettings(Values("{}"));
        Is((face.IconStyle, face.IconMs, face.IconDots), ("dots", 700.0, 78), "no settings: dots, 700 ms, 78 dots");

        // 12 dots in the shape: once formed, 12 dots are the shape's size and the other 66 stand 80 or more from the middle.
        face = new Face();
        face.SetIconTuning(null, 12);
        face.SetMode("thinking");
        face.SetDoing("search");
        var (dots, core, pen) = Run(face, 1.5);
        Is(ShapeDots(dots), 12, "12 dots in the shape");
        Is(dots.Count(d => Math.Abs(d.Radius - FaceIcons.ShapeDot) >= 1e-9 && Math.Sqrt(Math.Pow(d.X - 120, 2) + Math.Pow(d.Y - 120, 2)) >= 80 - 1e-6), 66, "the other 66 in a ring 80 out");
        Is((core == null, pen == null), (true, true), "no core and no pen once formed");
        // All 78: every dot is in the shape.
        face.SetIconTuning(null, null);
        (dots, _, _) = Run(face, 0.1);
        Is(ShapeDots(dots), 78, "78 dots in the shape");

        // toolIconMs: at 3000 ms the shape is far from formed after 0.7 s.
        face = new Face();
        face.SetIconTuning(3000, null);
        face.SetMode("thinking");
        face.SetDoing("search");
        (dots, core, _) = Run(face, 0.7);
        Is(ShapeDots(dots), 0, "3000 ms: not formed after 0.7 s");
        Is(core != null, true, "3000 ms: the core still shows after 0.7 s");

        // toolIcons off: no icon at all; line: a pen and no shape.
        face = new Face { IconStyle = "off" };
        face.SetMode("thinking");
        face.SetDoing("search");
        (dots, core, pen) = Run(face, 1.5);
        Is((core != null, pen == null, ShapeDots(dots)), (true, true, 0), "off: the core, no icon");
        face.IconStyle = "line";
        (dots, core, pen) = Run(face, 1.5);
        Is((core == null, pen != null, ShapeDots(dots)), (true, true, 0), "line: the pen in place of the core");

        // idleLooksOff: only sway left on; it is the one shown, and stays.
        var allButSway = string.Join(", ", Face.IdleNames.Where(n => n != "sway").Select(n => n.ToUpperInvariant()));
        face = new Face();
        face.SetIdleOff(allButSway + ",nonsense");
        face.SetMode("idle");
        Is(face.IdleName, "sway", "only sway on: sway");
        Run(face, 40);
        Is(face.IdleName, "sway", "only sway on: still sway after 40 s");
        // Switched off while on show: moves off at once, and never comes back.
        face = new Face();
        face.SetMode("idle");
        var showing = face.IdleName;
        face.UseSettings(Values($$"""{"idleLooksOff":"{{showing}}"}"""));
        Is(face.IdleName != showing, true, $"{showing} switched off while shown: moved off");
        var back = false;
        for (var i = 0; i < 30; i++) { Run(face, 17.1); back |= face.IdleName == showing; }
        Is(back, false, $"{showing} never comes back");
        // Every look named: the first stays.
        face = new Face();
        face.SetIdleOff(string.Join(",", Face.IdleNames));
        face.SetMode("idle");
        Run(face, 40);
        Is(face.IdleName, "calm", "every look off: calm stays");
    }

    static async Task AfterScrollAsync()
    {
        var ct = CancellationToken.None;
        // Text read from the pixels (no Ref) cannot be read again: after a scroll its id is refused.
        var flat = new DesktopCommands(new FakeDesktop());
        Is((await flat.HandleAsync("desktop.look", Json("{}"), ct)).Ok, true, "look");
        Is((await flat.HandleAsync("desktop.click", Json("""{"id":2}"""), ct)).Ok, true, "click by id before a scroll");
        Is((await flat.HandleAsync("desktop.scroll", Json("""{"go":"down"}"""), ct)).Ok, true, "scroll");
        var stale = await flat.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(stale.Ok, false, "click by id after a scroll, nothing to read again");
        Is(stale.Error?.StartsWith("scrolled since the last look"), true, $"says why ({stale.Error})");
        Is((await flat.HandleAsync("desktop.point", Json("""{"id":2}"""), ct)).Ok, false, "point by id after a scroll");
        Is((await flat.HandleAsync("desktop.click", Json("""{"name":"Send"}"""), ct)).Ok, true, "click by name after a scroll (read afresh)");
        Is((await flat.HandleAsync("desktop.click", Json("""{"id":2}"""), ct)).Ok, true, "click by id once looked again");

        // Controls the platform can read again: clicked where they are now.
        var fake = new FakeDesktop { Live = true };
        var live = new DesktopCommands(fake);
        await live.HandleAsync("desktop.look", Json("{}"), ct);
        var before = await live.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(before.Payload?["y"]?.GetValue<int>(), -80, "the field's middle before the scroll");
        await live.HandleAsync("desktop.scroll", Json("""{"go":"down"}"""), ct);
        var after = await live.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(after.Ok, true, "click by id after a scroll, read again");
        Is(after.Payload?["y"]?.GetValue<int>(), -380, "clicked where it is now");
        await live.HandleAsync("desktop.scroll", Json("""{"go":"down","pages":3}"""), ct);
        var gone = await live.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(gone.Ok, false, "scrolled off the screen");
        Is(gone.Error?.Contains("off the screen since the scroll"), true, $"says why ({gone.Error})");
        // In steps, a scroll then a click by id: the same.
        await live.HandleAsync("desktop.look", Json("{}"), ct);
        var steps = await live.HandleAsync("desktop.steps", Json("""{"data":{"steps":[{"action":"scroll","go":"down"},{"action":"click","id":2}]}}"""), ct);
        Is(steps.Ok, false, "steps: scroll, then click by id gone off the screen");
        Is(fake.Scrolled, 1500, "every scroll reached the computer");
    }

    /** A microphone and speaker that do nothing but count, for the voice part's checks. */
    sealed class FakeIo : IVoiceIo
    {
        public Action<short[]>? Frame;
        public int Starts, Stops, Sounds;
        public void StartCapture(Action<short[]> frame) { Frame = frame; Starts++; }
        public void StopCapture() { Frame = null; Stops++; }
        public void PlayBegin(int sampleRate) { }
        public void PlayWrite(byte[] pcm) { }
        public void PlayEnd(Action finished) => finished();
        public bool StopPlayback() => false;
        public double PlayLevel => 0;
        public void PlaySound(short[] pcm, int sampleRate) => Sounds++;
        public double Volume { get; set; } = 1;
    }

    /** A voice part on a link that never connects: every send fails quietly, and is seen through Sent. */
    static (Voice, FakeIo, List<JsonObject>, List<byte[]>) NewVoice()
    {
        var link = new AxisLink(new Pairing("http://127.0.0.1:9", "c1", "t", "PC"), DesktopIdentity.Create("0.0.0", true));
        var io = new FakeIo();
        var voice = new Voice(link, io);
        // Quiet hours never, and every sound allowed, whatever the time of day the checks run.
        voice.Sounds.UseSettings(Values("""{"quietFrom":"","quietTo":""}"""));
        var sent = new List<JsonObject>();
        var audio = new List<byte[]>();
        voice.Sent += m => sent.Add(m);
        voice.SentAudio += a => audio.Add(a);
        return (voice, io, sent, audio);
    }

    static string Kinds(List<JsonObject> sent) => string.Join(",", sent.Select(m => m["t"]!.GetValue<string>()));

    static void TapOrHold()
    {
        Is(TalkPress.IsTap(1000, 1219), true, "up after 219 ms: a tap");
        Is(TalkPress.IsTap(1000, 1220), false, "up after 220 ms: a hold");

        // A tap: the microphone opened at once, then closed, and nothing reached Axis.
        var (voice, io, sent, audio) = NewVoice();
        Is(voice.Arm(), true, "key down: armed");
        Is(io.Starts, 1, "the microphone opens at key down");
        io.Frame!(new short[320]);
        io.Frame!(new short[320]);
        Is(voice.Mode, VoiceMode.Idle, "not listening yet while it could be a tap");
        Is(voice.Disarm(), true, "key up early: a tap");
        Is((io.Stops, sent.Count, audio.Count), (1, 0, 0), "a tap: microphone closed, nothing sent");
        Is(voice.Disarm(), false, "a second tap is nothing");

        // A hold: audio.start, then the pre-roll in order, then live audio; the listening cue sounds.
        (voice, io, sent, audio) = NewVoice();
        voice.Arm();
        var loud = Enumerable.Repeat((short)8000, 320).ToArray();
        for (var i = 0; i < 3; i++) io.Frame!(i == 1 ? loud : new short[320]);
        Is(audio.Count, 0, "nothing sent before the hold is known");
        voice.Commit();
        Is(Kinds(sent), "audio.start", "a hold starts the turn");
        Is(sent[0]["trigger"]!.GetValue<string>(), "hold", "with trigger hold");
        Is(audio.Count, 3, "the three pre-roll frames follow");
        Is(audio[1][0] | audio[1][1] << 8, 8000, "in the order they were heard");
        Is(voice.Mode, VoiceMode.Listening, "listening");
        Is(io.Starts, 1, "the microphone was not opened twice");
        Is(io.Sounds, 1, "the listening cue played");
        io.Frame!(new short[320]);
        Is(audio.Count, 4, "live audio after the pre-roll");
        voice.Release();
        Is(Kinds(sent), "audio.start,audio.end", "let go: the recording ends");
        Is(sent[1]["reason"]!.GetValue<string>(), "silence", "and is sent (speech was heard in the pre-roll)");

        // The pre-roll is bounded.
        (voice, io, sent, audio) = NewVoice();
        voice.Arm();
        for (var i = 0; i < TalkPress.PreRollFrames + 20; i++) io.Frame!(new short[320]);
        voice.Commit();
        Is(audio.Count, TalkPress.PreRollFrames, "at most PreRollFrames kept");

        // Key down while it thinks: stops it, as before, and is not armed.
        (voice, io, sent, audio) = NewVoice();
        voice.Type("hello");
        sent.Clear();
        Is(voice.Arm(), false, "key down while thinking is not a tap or hold");
        Is(Kinds(sent), "interrupt", "it stops the agent");
    }

    /** What an admin switched off on the Axis admin page (`capabilitiesOff`): read, refused, and back on again. */
    static async Task CapabilitiesOffAsync()
    {
        var ct = CancellationToken.None;
        Is(DesktopCommands.CapabilitiesOff(Values("{}")).Count, 0, "not set: nothing off");
        Is(DesktopCommands.CapabilitiesOff(Values("""{"capabilitiesOff":""}""")).Count, 0, "empty: nothing off");
        Is(string.Join("|", DesktopCommands.CapabilitiesOff(Values("""{"capabilitiesOff":"mic, desktop"}""")).Order()), "desktop|mic", "two off");

        var commands = new DesktopCommands(new FakeDesktop());
        commands.UseSettings(Values("""{"capabilitiesOff":"desktop"}"""));
        var refused = await commands.HandleAsync("desktop.look", Json("{}"), ct);
        Is(refused.Ok, false, "desktop off: a look is refused");
        Is(refused.Error?.Contains("switched off"), true, $"says why ({refused.Error})");
        commands.UseSettings(Values("""{"capabilitiesOff":"screen"}"""));
        Is((await commands.HandleAsync("desktop.look", Json("{}"), ct)).Ok, true, "desktop on again: a look");

        var (voice, io, sent, _) = NewVoice();
        voice.UseCapabilitiesOff(DesktopCommands.CapabilitiesOff(Values("""{"capabilitiesOff":"mic,speaker"}""")));
        voice.Press();
        Is((voice.Mode, io.Starts, sent.Count), (VoiceMode.Idle, 0, 0), "mic off: the talk key does nothing");
        Is(voice.Arm(), false, "mic off: nothing to arm");
        Is(voice.Play(SoundKind.Listen), false, "speaker off: no sounds");
        voice.UseCapabilitiesOff(new HashSet<string>());
        voice.Press();
        Is((voice.Mode, io.Starts), (VoiceMode.Listening, 1), "on again: the talk key listens");
    }

    static void Typing()
    {
        Is(TypedText.Clean("  hi  "), "hi", "trimmed");
        Is(TypedText.Clean("   "), null, "blank is not sent");
        Is(TypedText.Clean(null), null, "nothing is not sent");
        Is(TypedText.Clean(new string('a', 4000))?.Length, 4000, "4000 characters go");
        Is(TypedText.Clean(new string('a', 4001)), null, "4001 do not");
        Is(TypedText.Message("pc-1", "hi").ToJsonString(), """{"t":"text","turnId":"pc-1","text":"hi"}""", "the message's shape");

        var (voice, _, sent, _) = NewVoice();
        Is(voice.Type(" "), false, "a blank line is not sent");
        Is(sent.Count, 0, "nothing went");
        Is(voice.Type("what's the time?\nand the date"), true, "typed");
        Is(Kinds(sent), "interrupt,text", "stops what was going on, then the text");
        Is(sent[1]["text"]!.GetValue<string>(), "what's the time?\nand the date", "the words, newline kept");
        Is(sent[1]["turnId"]!.GetValue<string>().StartsWith("pc-"), true, "a new turn id");
        Is((voice.Mode, voice.Heard), (VoiceMode.Thinking, "what's the time?\nand the date"), "the pill thinks, with the words");
    }

    static void Progress()
    {
        var glance = new Glance();
        var chimes = 0;
        glance.TaskChime += () => chimes++;
        Is(glance.Handle("desktop.look", Json("{}"), 0), false, "other commands are not the glance's");
        glance.Handle("progress.show", Json("""{"title":"Backup","note":"copying","done":3,"total":7,"state":"running","count":2,"steps":"xScan\n>Copy\n-Check","others":"!Invoice: which account?"}"""), 0);
        var t = glance.TaskAt(0)!;
        Is((t.Word, t.Detail, t.More), ("Working", "3/7", "+1"), "running: word, steps done, more");
        Is(Math.Round(t.Part!.Value, 3), 0.429, "the bar at 3/7");
        Is(string.Join("|", t.Steps.Select(r => $"{r.Kind}:{r.Text}")), "done:Scan|running:Copy|pending:Check", "the steps");
        Is(string.Join("|", t.Others.Select(r => $"{r.Kind}:{r.Text}")), "needs:Invoice: which account?", "the other task, waiting for you");
        Is(t.HasList, true, "a list to open");
        glance.Handle("progress.show", Json("""{"title":"Backup","note":"which disk?","done":3,"total":7,"state":"blocked","count":1}"""), 1000);
        t = glance.TaskAt(1000)!;
        Is((t.Word, t.Detail, t.More, t.HasList), ("Needs you", "which disk?", "", false), "blocked");
        glance.Handle("progress.show", Json("""{"title":"Notes","note":"","done":-1,"total":0,"state":"running","count":1}"""), 1500);
        Is(glance.TaskAt(1500)!.Part, null, "no count of steps: no bar");
        glance.Handle("progress.show", Json("""{"title":"Backup","note":"","done":7,"total":7,"state":"done","count":1,"chime":true}"""), 2000);
        t = glance.TaskAt(2000)!;
        Is((t.Word, t.Part, t.Finished), ("Done", (double?)1, true), "done: full bar");
        Is(chimes, 1, "the chime Axis asked for");
        // The same finished task told again (another task changed) does not restart its 90 s.
        glance.Handle("progress.show", Json("""{"title":"Backup","state":"done","count":1}"""), 50_000);
        Is(glance.TaskAt(2000 + Glance.DoneShownMs) != null, true, "still shown at 90 s");
        Is(glance.TaskAt(2001 + Glance.DoneShownMs), null, "gone after 90 s");
        glance.Handle("progress.show", Json("""{"title":"","note":"","done":-1,"total":0,"state":"none","count":0}"""), 3000);
        Is(glance.Task, null, "no tasks: nothing");
        Is(chimes, 1, "no chime without Axis asking");
    }

    static void Timers()
    {
        var glance = new Glance();
        glance.Handle("timer.next", Json("""{"label":"Pasta","ms":272000,"count":2,"id":7}"""), 10_000);
        var t = glance.TimerAt(10_000)!;
        Is((t.Label, t.Clock(10_000), t.More, t.CanCancel, t.Id), ("Pasta", "4:32", "+1", true, (long?)7), "a timer");
        Is(t.Clock(10_500), "4:32", "rounded up, as the web client");
        Is(t.Final(10_000 + 262_000), true, "the last ten seconds");
        Is(t.Final(10_000 + 261_000), false, "eleven left is not");
        Is(t.Clock(10_000 + 272_000), "0:00", "rung");
        Is(glance.TimerAt(10_000 + 275_000), null, "gone once rung");
        glance.Handle("timer.next", Json("""{"label":"","ms":3_904_000,"count":1}""".Replace("_", "")), 0);
        t = glance.TimerAt(0)!;
        Is((t.Label, t.Clock(0), t.More, t.CanCancel), ("Timer", "1:05:04", "", false), "unnamed, over an hour, no id (older Axis)");
        glance.Handle("timer.next", Json("""{"label":"","ms":0,"count":0}"""), 0);
        Is(glance.Timer, null, "no timer");
    }

    static void SoundChecks()
    {
        Is(Sounds.MinutesOf("22:30"), 1350, "22:30");
        Is(Sounds.MinutesOf("24:00"), null, "24:00 is not a time");
        Is(Sounds.Quiet("22:30", "07:00", 23 * 60), true, "over midnight: 23:00 is quiet");
        Is(Sounds.Quiet("22:30", "07:00", 6 * 60 + 59), true, "06:59 is quiet");
        Is(Sounds.Quiet("22:30", "07:00", 7 * 60), false, "07:00 is not");
        Is(Sounds.Quiet("13:00", "14:00", 13 * 60 + 30), true, "same day stretch");
        Is(Sounds.Quiet("", "", 0), false, "none set");
        Is(Sounds.Quiet("08:00", "08:00", 8 * 60), false, "equal: none");

        var sounds = new Sounds();
        var night = new DateTime(2026, 10, 20, 23, 0, 0);
        var day = new DateTime(2026, 10, 20, 12, 0, 0);
        sounds.UseSettings(Values("""{"quietFrom":"22:00","quietTo":"07:00","taskChime":false}"""));
        Is((sounds.May(SoundKind.Chime, night), sounds.May(SoundKind.Listen, night)), (false, false), "nothing in quiet hours");
        Is((sounds.May(SoundKind.Chime, day), sounds.May(SoundKind.Listen, day), sounds.May(SoundKind.TaskDone, day)), (true, true, false), "task chime off");
        sounds.UseSettings(Values("""{"listenCue":0}"""));
        Is((sounds.May(SoundKind.Listen, day), sounds.May(SoundKind.TaskDone, day)), (false, true), "listening cue off as 0");

        Is(Sounds.Envelope(0, 0.02, 0.5), 0.0, "silent at the start");
        Is(Sounds.Envelope(0.02, 0.02, 0.5), 1.0, "full after the attack");
        Is(Math.Round(Sounds.Envelope(0.4999, 0.02, 0.5), 3), 0.001, "a thousandth at the end");
        Is(Sounds.Envelope(0.3, 0.02, 0.5) < Sounds.Envelope(0.2, 0.02, 0.5), true, "falling");
        foreach (var (kind, ms) in new[] { (SoundKind.TaskDone, 660), (SoundKind.Chime, 950), (SoundKind.Listen, 140) })
        {
            var pcm = Sounds.Pcm(kind);
            Is((int)Math.Round(pcm.Length * 1000.0 / Sounds.Rate), ms, $"{kind}: {ms} ms long");
            var peak = pcm.Max(x => Math.Abs((int)x)) / 32768.0;
            Is(peak is > 0.1 and < 0.6, true, $"{kind}: peak {peak:0.00}, heard and not harsh");
            Is(Math.Abs((int)pcm[0]) < 200 && Math.Abs((int)pcm[^1]) < 200, true, $"{kind}: starts and ends near silence (no click)");
        }
    }

    static void Pictures()
    {
        var link = new AxisLink(new Pairing("http://192.168.1.20:8440", "c1", "t", "PC"), DesktopIdentity.Create("0.0.0", true));
        Is(DesktopIdentity.Create("0.0.0", true).Capabilities.Contains("images"), true, "images with talking on");
        Is(DesktopIdentity.Create("0.0.0", false).Capabilities.Contains("images"), false, "no images with talking off");
        var actions = DesktopIdentity.Create("0.0.0", false).Describe["actions"]!.AsArray().Select(a => a!["name"]!.GetValue<string>());
        Is(actions.Contains("chime"), true, "the chime action declared either way");
        Is(link.Address.Http.ToString(), "http://192.168.1.20:8440/", "the address pictures are fetched from");
    }

    /** Speech for `turn` from Axis, played to the end (the fake speaker finishes at once). */
    static void Spoken(Voice voice, string turn)
    {
        var id = JsonSerializer.Serialize(turn);
        voice.Receive("speak.start", Json($"{{\"turnId\":{id},\"format\":{{\"sampleRate\":24000}}}}"));
        voice.Receive("speak.end", Json($"{{\"turnId\":{id}}}"));
    }

    /** Axis's shared Listening settings: the end of a sentence, giving up, the longest, and listening on after an answer. */
    static void ListeningChecks()
    {
        Is(Listening.Read(Values("{}")), Listening.Default, "nothing sent: the boards' numbers");
        Is(Listening.Read(Values("""{"onsetMs":3000,"silenceMs":1500,"maxSpeechMs":10000,"followUpMs":0}""")), new Listening(3000, 1500, 10000, 0), "read");
        Is(Listening.Read(Values("""{"silenceMs":10,"maxSpeechMs":999999,"onsetMs":"x"}""")), new Listening(6000, 300, 60000, 6000), "held to the ranges");

        long now = 1000;
        var (voice, io, sent, _) = NewVoice();
        voice.Clock = () => now;
        voice.UseSettings(Values("""{"silenceMs":1500,"onsetMs":3000,"maxSpeechMs":5000,"followUpMs":4000}"""));
        var loud = Enumerable.Repeat((short)8000, 320).ToArray();
        voice.Press();
        io.Frame!(loud);
        now += 1400; io.Frame!(new short[320]);
        now += 1400; io.Frame!(new short[320]);
        Is(voice.Mode, VoiceMode.Listening, "1.4 s of quiet does not end it with silenceMs 1500");
        now += 200; io.Frame!(new short[320]);
        Is(sent.Last()["reason"]?.GetValue<string>(), "silence", "past silenceMs: sent");
        var turn = sent[0]["turnId"]!.GetValue<string>();

        // Its answer spoken to the end: it listens again, with no cue, for followUpMs.
        var sounds = io.Sounds;
        Spoken(voice, turn);
        Is(voice.Mode, VoiceMode.Listening, "after the spoken answer: listening");
        Is(sent.Last(m => m["t"]!.GetValue<string>() == "audio.start")["trigger"]?.GetValue<string>(), "follow_up", "as a follow-up");
        Is(io.Sounds, sounds, "no cue for a follow-up");
        now += 3900; io.Frame!(new short[320]);
        Is(voice.Mode, VoiceMode.Listening, "still waiting inside followUpMs");
        now += 200; io.Frame!(new short[320]);
        Is((voice.Mode, sent.Last()["reason"]?.GetValue<string>()), (VoiceMode.Idle, "cancel"), "nothing said: ends quietly");

        // Speech nobody here asked for: no follow-up.
        var count = sent.Count;
        Spoken(voice, "say-1");
        Is(sent.Skip(count).Any(m => m["t"]!.GetValue<string>() == "audio.start"), false, "no follow-up after an announcement");

        // A tap gives up after onsetMs with nothing said; maxSpeechMs caps a hold.
        voice.Press();
        now += 2900; io.Frame!(new short[320]);
        Is(voice.Mode, VoiceMode.Listening, "inside onsetMs");
        now += 200; io.Frame!(new short[320]);
        Is(sent.Last()["reason"]?.GetValue<string>(), "cancel", "past onsetMs: given up");
        voice.Press(); voice.Hold();
        now += 5100; io.Frame!(loud);
        Is(sent.Last()["reason"]?.GetValue<string>(), "max", "past maxSpeechMs: ended");

        // The app's own volume: a gain on what it plays; 100 when not set.
        Is(io.Volume, 1.0, "no volume sent: as loud as the computer is set");
        voice.UseSettings(Values("""{"volume":25}"""));
        Is(io.Volume, 0.25, "volume 25 (quiet hours' cap): a quarter");
        voice.UseSettings(Values("""{"volume":250}"""));
        Is(io.Volume, 1.0, "held to 100");
        var volume = DesktopIdentity.Create("0.0.0", true).Describe["settings"]!.AsArray().FirstOrDefault(x => x!["key"]!.GetValue<string>() == "volume");
        Is(volume?["default"]?.GetValue<int>(), 100, "declares volume, default 100 (Axis caps it in quiet hours from this)");
        Is(volume?["group"]?.GetValue<string>(), "Sound", "in Sound");

        // followUpMs 0: no follow-up.
        (voice, io, sent, _) = NewVoice();
        voice.Clock = () => now;
        voice.UseSettings(Values("""{"followUpMs":0}"""));
        voice.Press(); voice.Hold(); io.Frame!(loud); voice.Release();
        turn = sent[0]["turnId"]!.GetValue<string>();
        Spoken(voice, turn);
        Is(voice.Mode, VoiceMode.Idle, "followUpMs 0: no follow-up");
    }
}

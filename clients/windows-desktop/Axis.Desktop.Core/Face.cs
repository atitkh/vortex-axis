using System.Text.Json;

namespace Axis.Desktop;

/**
 * The vortex face, the one the boards and the web client draw (docs/face.md; web/vortex.js is the copy this
 * follows line for line): dots on three spiral arms that spin slowly when idle, pull in and go green to
 * listen, spin fast and violet to think, and open and pulse with the voice to speak. This class works out
 * where every dot is each frame, in a 240 by 240 square; the platform only paints the circles.
 * Change the specification, vortex.js, vortex.cpp and this together.
 */
public sealed class Face
{
    public const double Size = 240;
    const int Arms = 3, DotsPerArm = 26;
    const double MaxRadius = Size / 2 - 14;

    /** One look: spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b, wave, tilt. */
    static double[] Look(double spin, double radius, double twist, double pulse, double pulseHz, double wander, double sparkle, double dot,
        double r, double g, double b, double wave = 0, double tilt = 0) => [spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b, wave, tilt];
    const int Spin = 0, Radius = 1, Twist = 2, Pulse = 3, PulseHz = 4, Wander = 5, Sparkle = 6, Dot = 7, R = 8, G = 9, B = 10, Wave = 11, Tilt = 12;

    // Idle picks among these at random, so it does not look like a loop.
    static readonly double[][] Idle =
    [
        Look(0.5, 0.85, 0.9, 0.03, 0.25, 0, 0, 1.0, 0.1, 0.78, 0.95),
        Look(0.35, 0.8, 0.8, 0.2, 0.18, 0, 0, 1.1, 0.15, 0.6, 1.0),
        Look(-0.4, 0.95, 1.25, 0.04, 0.3, 0, 0, 0.9, 0.2, 0.85, 0.8),
        Look(0.8, 1.0, 0.45, 0.05, 0.3, 0, 0, 1.2, 0.05, 0.7, 1.0),
        Look(1.1, 0.58, 1.7, 0.05, 0.4, 0, 0, 0.9, 0.3, 0.55, 1.0),
        Look(0.45, 0.75, 1.0, 0.04, 0.25, 14, 0, 1.0, 0.1, 0.85, 0.85),
        Look(0.3, 0.88, 1.1, 0.03, 0.25, 0, 0.035, 1.0, 0.35, 0.75, 1.0),
        Look(0.6, 0.95, 1.15, 0.03, 0.25, 0, 0.012, 0.95, 0.4, 0.65, 1, 0, 0.55),
        Look(0.25, 0.9, 0.7, 0.04, 0.3, 0, 0, 1, 0.1, 0.9, 0.75, 0.45, 0),
        Look(0.2, 0.7, 0.35, 0.14, 0.22, 0, 0, 1.6, 0.25, 0.7, 1, 0, 0),
        Look(1.4, 0.92, 0.18, 0.03, 0.3, 0, 0, 0.8, 0.1, 0.8, 1, 0, 0),
        Look(0.28, 0.66, 1.4, 0.1, 0.15, 8, 0, 1.15, 0.1, 0.4, 1, 0.2, 0.25),
        Look(0.9, 1, 0.5, 0.03, 0.3, 0, 0, 1.1, 0.15, 0.75, 0.95, 0, 0.45),
        Look(0.1, 0.85, 0.95, 0.05, 0.2, 0, 0, 1, 0.2, 0.85, 0.9, 0.7, 0),
    ];

    /** The idle looks' names, in the order above, for the `idleLooksOff` setting. */
    public static readonly string[] IdleNames = ["calm", "breathe", "unwind", "open", "curl", "drift", "shimmer", "galaxy", "tendril", "bloom", "pinwheel", "deep", "orbit", "sway"];

    static readonly Dictionary<string, double[]> Looks = new()
    {
        ["offline"] = Look(0.18, 0.55, 1.1, 0.03, 0.2, 0, 0, 0.9, 0.3, 0.34, 0.42),
        ["listening"] = Look(1.6, 0.45, 1.8, 0.08, 1.2, 0, 0, 1.2, 0.15, 1.0, 0.55),
        ["thinking"] = Look(4.6, 0.78, 1.3, 0.05, 0.9, 0, 0.02, 0.9, 0.62, 0.4, 1.0),
        ["speaking"] = Look(1.1, 0.78, 0.75, 0.22, 2.4, 0, 0, 1.2, 0.55, 0.95, 1.0),
        ["error"] = Look(0.15, 0.62, 0.7, 0.12, 0.5, 5, 0, 1.0, 1.0, 0.18, 0.12),
    };

    /** A run that is held up while thinking, shown by how the face moves (docs/face.md section 9). */
    static readonly Dictionary<string, double[]> Held = new()
    {
        ["compacting"] = Look(0.9, 0.42, 2.4, 0.14, 0.5, 0, 0, 1.0, 0.35, 0.55, 1.0),
        ["retrying"] = Look(-2.2, 0.7, 1.0, 0.1, 1.6, 0, 0, 1.0, 1.0, 0.7, 0.25),
    };

    /** A filled circle to paint: centre, radius and colour (0 to 1), in the 240 square. */
    public readonly record struct Circle(double X, double Y, double Radius, double R, double G, double B);
    /** The icon drawn with a pen at the core: strokes of x, y pairs in the 240 square, its colour and how far it has faded in. */
    public sealed record Pen(List<double[]> Strokes, double Width, double R, double G, double B, double Alpha);

    readonly Random random = new();
    readonly double[] flash = new double[Arms * DotsPerArm];
    double[] now = (double[])Looks["offline"].Clone();
    double[] target = (double[])Looks["offline"].Clone();
    string mode = "offline";
    int idleIndex;
    double idleRemaining, phase, pulsePhase, wanderPhase, wavePhase, tiltPhase, flowPhase, iconShown;
    string? icon;
    FaceIcons.Icon? iconData;
    bool drawnAsDots;
    string iconStyle = "dots";
    int[] idleOn = Enumerable.Range(0, Idle.Length).ToArray();

    /** Loudness of the voice, 0 to 1. Negative: not known, the face pulses on its own. */
    public double Level { get; set; } = -1;
    /** How icons are shown: "dots" (as on the boards by default), "line" or "off" (the `toolIcons` setting). Anything else is "dots". */
    public string IconStyle { get => iconStyle; set => iconStyle = value is "off" or "line" ? value : "dots"; }
    /** How long an icon takes to form and to go, in milliseconds (the `toolIconMs` setting, 150 to 3000). */
    public double IconMs { get; private set; } = FaceIcons.Ms;
    /** How many of the 78 dots draw a dot shape (the `toolIconDots` setting, 12 to 78); the rest turn in a ring round it. */
    public int IconDots { get; private set; } = FaceIcons.Dots;
    /** The idle look on show or coming, by name. */
    public string IdleName => IdleNames[idleIndex];

    /** The icon timing and the dots in a shape; null, or not a number, is the usual. Out of range is brought in (web/vortex.js `setIconTuning`). */
    public void SetIconTuning(double? ms, double? dots)
    {
        IconMs = ms is double m && double.IsFinite(m) ? Math.Clamp(m, 150, 3000) : FaceIcons.Ms;
        IconDots = dots is double d && double.IsFinite(d) ? (int)Math.Clamp(Math.Round(d, MidpointRounding.AwayFromZero), FaceIcons.ShapeDotsMin, FaceIcons.Dots) : FaceIcons.Dots;
    }

    /**
     * Idle looks to leave out, their names separated by commas (the `idleLooksOff` setting; spaces and case aside, unknown
     * names ignored). If every look is named the first one stays, so there is always one.
     */
    public void SetIdleOff(string? names)
    {
        var off = (names ?? "").Split(',').Select(n => n.Trim().ToLowerInvariant()).Where(n => n.Length > 0).ToHashSet();
        idleOn = Enumerable.Range(0, Idle.Length).Where(i => !off.Contains(IdleNames[i])).ToArray();
        if (idleOn.Length == 0) idleOn = [0];
        // A look just switched off should not stay on screen until its time runs out.
        if (mode == "idle" && !idleOn.Contains(idleIndex)) PickIdle();
    }

    /** The face's settings from what Axis sends (all of them, resolved): `idleLooksOff`, `toolIcons`, `toolIconMs`, `toolIconDots`. A key not there is its usual. */
    public void UseSettings(IReadOnlyDictionary<string, JsonElement> values)
    {
        string? Text(string key) => values.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        double? Number(string key) => !values.TryGetValue(key, out var v) ? null
            : v.ValueKind == JsonValueKind.Number ? v.GetDouble()
            : v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : null;
        SetIdleOff(Text("idleLooksOff"));
        IconStyle = Text("toolIcons") ?? "dots";
        SetIconTuning(Number("toolIconMs"), Number("toolIconDots"));
    }

    /**
     * Where dot `n` (i * 3 + arm) goes in a dot shape drawn by `shapeDots` dots: the point of the 78 it takes, or -1 when it
     * is not in the shape and stays on its arm (docs/face.md section 8, Tuning).
     */
    public static int ShapePoint(int n, int shapeDots) => n < shapeDots ? n * FaceIcons.Dots / shapeDots : -1;

    /** offline, idle, listening, thinking, speaking or error. */
    public void SetMode(string next)
    {
        if (next == mode) return;
        mode = next;
        if (next == "idle") PickIdle();
        else target = (double[])(Looks.GetValueOrDefault(next) ?? Looks["offline"]).Clone();
    }

    /**
     * What Axis says the agent is doing while it thinks (`doing` on a `turn`): a kind of tool, shown as an
     * icon; a reason its run is held up, shown as a look; or nothing, which is plain thinking.
     */
    public void SetDoing(string? name)
    {
        var held = name != null ? Held.GetValueOrDefault(name) : null;
        var known = held == null && name != null && FaceIcons.All.TryGetValue(name, out var data) ? data : null;
        // The one on show stays drawn while it fades, so only a new one replaces it.
        if (known != null) iconData = known;
        icon = known != null ? name : null;
        if (mode == "thinking") target = (double[])(held ?? Looks["thinking"]).Clone();
    }

    void PickIdle()
    {
        var next = idleIndex;
        // Never the same look twice in a row, unless it is the only one left on.
        while (next == idleIndex || !idleOn.Contains(next))
        {
            next = idleOn[random.Next(idleOn.Length)];
            if (idleOn.Length == 1) break;
        }
        idleIndex = next;
        idleRemaining = 7 + random.NextDouble() * 10;
        target = (double[])Idle[next].Clone();
    }

    /** Moves the face on by `dt` seconds and says what to paint: the dots, back to front, then the core, then the pen icon if any. */
    public (List<Circle> Dots, Circle? Core, Pen? Icon) Frame(double dt)
    {
        dt = Math.Clamp(dt, 0, 0.1);
        if (mode == "idle")
        {
            idleRemaining -= dt;
            if (idleRemaining <= 0) PickIdle();
        }
        // Leaving idle should feel immediate; drifting between idle looks should not.
        var k = 1 - Math.Exp(-dt * (mode == "idle" ? 1.2 : 5.0));
        for (var i = 0; i < now.Length; i++) now[i] += (target[i] - now[i]) * k;
        // The icon is only ever there while thinking, and comes and goes quickly.
        var wantIcon = mode == "thinking" && icon != null && IconStyle != "off";
        iconShown += ((wantIcon ? 1 : 0) - iconShown) * (1 - Math.Exp(-dt * 4.2 * 1000 / IconMs));
        var eye = iconShown < 0.01 ? 0 : iconShown > 0.985 ? 1 : iconShown;
        if (wantIcon) drawnAsDots = IconStyle == "dots";
        var asDots = drawnAsDots && iconData != null;
        var hole = asDots ? 0 : FaceIcons.Hole * eye;
        flowPhase += 5 * dt;
        var shapeUnit = FaceIcons.ShapeSize / 24 * (1 + 0.05 * Math.Sin(pulsePhase));
        var sway = 0.07 * Math.Sin(wavePhase);
        double swayCos = Math.Cos(sway), swaySin = Math.Sin(sway);
        var tint = iconData?.Tint ?? [1, 1, 1];
        double[] shapeColor = [(0.55 + now[R] * 0.45) * 0.6 + tint[0] * 0.4, (0.55 + now[G] * 0.45) * 0.6 + tint[1] * 0.4, (0.55 + now[B] * 0.45) * 0.6 + tint[2] * 0.4];

        phase += now[Spin] * dt;
        pulsePhase += now[PulseHz] * 2 * Math.PI * dt;
        wanderPhase += 0.6 * dt;
        wavePhase += 1.3 * dt;
        tiltPhase += 0.15 * dt;

        // With a known loudness, the voice drives the size instead of a sine wave.
        var voiced = mode is "speaking" or "listening" && Level >= 0;
        var voiceSwell = mode == "listening" ? 0.4 : now[Pulse];
        var cx = Size / 2 + now[Wander] * Math.Sin(wanderPhase);
        var cy = Size / 2 + now[Wander] * Math.Sin(wanderPhase * 1.7 + 1);
        // A tipped figure is squashed along one axis, and that axis turns slowly.
        double axisCos = Math.Cos(tiltPhase), axisSin = Math.Sin(tiltPhase), squash = 1 - now[Tilt];

        var dots = new List<Circle>(Arms * DotsPerArm);
        for (var arm = 0; arm < Arms; arm++)
        {
            // Outer dots first, so the bright inner ones are drawn on top.
            for (var i = DotsPerArm - 1; i >= 0; i--)
            {
                var t = (i + 1.0) / DotsPerArm;
                var at = arm * DotsPerArm + i;
                if (now[Sparkle] > 0 && random.NextDouble() < now[Sparkle]) flash[at] = 1;
                flash[at] *= 0.86;
                var spark = flash[at];

                var swell = voiced ? voiceSwell * Level : now[Pulse] * Math.Sin(pulsePhase - t * 3);
                // The arms take turns along an icon's strokes, the inner dots first. With fewer dots in the
                // shape than there are, the outer ones stand off in a ring round it and go on turning.
                var n = i * Arms + arm;
                var point = asDots ? ShapePoint(n, IconDots) : -1;
                var inShape = point >= 0;
                var room = asDots ? (inShape ? 0 : FaceIcons.ShapeHalo * eye) : hole;
                var reach = MaxRadius * now[Radius] * (1 + swell);
                var radius = room + Math.Max(0, reach - room) * Math.Pow(t, 0.85);
                // The sway runs out along the arm like a wave, and is widest at the tip.
                var angle = phase + arm * (2 * Math.PI / Arms) - now[Twist] * 2 * Math.PI * t + now[Wave] * t * Math.Sin(wavePhase - t * 7);
                var glow = Math.Min(1, 1 - 0.72 * t + spark);
                double x = radius * Math.Cos(angle), y = radius * Math.Sin(angle);
                double along = x * axisCos + y * axisSin, across = (y * axisCos - x * axisSin) * squash;
                double px = cx + along * axisCos - across * axisSin, py = cy + along * axisSin + across * axisCos;
                var size = now[Dot] * (1.4 + 4.2 * t);
                double red = now[R] * glow + spark * 0.5, green = now[G] * glow + spark * 0.5, blue = now[B] * glow + spark * 0.5;
                if (inShape && eye > 0)
                {
                    // Each dot of the shape has a place on the icon; a wave of light runs along the strokes once it is there.
                    var points = iconData!.Points;
                    var ix = (points[point * 2] - 12) * shapeUnit;
                    var iy = (points[point * 2 + 1] - 12) * shapeUnit;
                    px += (Size / 2 + ix * swayCos - iy * swaySin - px) * eye;
                    py += (Size / 2 + ix * swaySin + iy * swayCos - py) * eye;
                    size += (FaceIcons.ShapeDot - size) * eye;
                    var lit = 0.62 + 0.38 * Math.Sin(flowPhase - point * 0.33) + spark * 0.5;
                    red += (shapeColor[0] * lit - red) * eye;
                    green += (shapeColor[1] * lit - green) * eye;
                    blue += (shapeColor[2] * lit - blue) * eye;
                }
                dots.Add(new Circle(px, py, size, Clamp(red), Clamp(green), Clamp(blue)));
            }
        }

        var coreSize = 7 + (mode == "listening" ? 6 : 3) * (voiced ? Level : Math.Sin(pulsePhase));
        double cr = 0.55 + now[R] * 0.45, cg = 0.55 + now[G] * 0.45, cb = 0.55 + now[B] * 0.45;
        Circle? core = eye < 1 ? new Circle(cx, cy, Math.Max(1, coreSize * (1 - eye)), cr, cg, cb) : null;
        Pen? pen = null;
        if (eye > 0 && !asDots && iconData != null)
        {
            // The icon takes the core's place and its colour, breathing a little with the figure.
            var unit = FaceIcons.Size * (1 + 0.04 * Math.Sin(pulsePhase)) / 24;
            var strokes = iconData.Strokes.Select(s => s.Select((v, i) => (i % 2 == 0 ? cx : cy) + (v - 12) * unit).ToArray()).ToList();
            pen = new Pen(strokes, FaceIcons.Pen, cr, cg, cb, eye);
        }
        return (dots, core, pen);
    }

    static double Clamp(double v) => Math.Min(1, Math.Max(0, v));
}

import Foundation

/**
 * The vortex face, the one the boards and the web client draw (docs/face.md; web/vortex.js is the copy this follows
 * line for line, through the Windows app's `Face.cs`): dots on three spiral arms that spin slowly when idle, pull in
 * and go green to listen, spin fast and violet to think, and open and pulse with the voice to speak. This class works
 * out where every dot is each frame, in a 240 by 240 square; the platform only paints the circles.
 * Change the specification, vortex.js, vortex.cpp, Face.cs and this together.
 */
public final class Face {
    public static let size = 240.0
    static let arms = 3, dotsPerArm = 26
    static let maxRadius = size / 2 - 14

    /** One look: spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b, wave, tilt. */
    static func look(_ spin: Double, _ radius: Double, _ twist: Double, _ pulse: Double, _ pulseHz: Double, _ wander: Double,
                     _ sparkle: Double, _ dot: Double, _ r: Double, _ g: Double, _ b: Double, _ wave: Double = 0, _ tilt: Double = 0) -> [Double] {
        [spin, radius, twist, pulse, pulseHz, wander, sparkle, dot, r, g, b, wave, tilt]
    }
    static let spin = 0, radius = 1, twist = 2, pulse = 3, pulseHz = 4, wander = 5, sparkle = 6, dot = 7, red = 8, green = 9, blue = 10,
               wave = 11, tilt = 12

    // Idle picks among these at random, so it does not look like a loop.
    static let idle: [[Double]] = [
        look(0.5, 0.85, 0.9, 0.03, 0.25, 0, 0, 1.0, 0.1, 0.78, 0.95),
        look(0.35, 0.8, 0.8, 0.2, 0.18, 0, 0, 1.1, 0.15, 0.6, 1.0),
        look(-0.4, 0.95, 1.25, 0.04, 0.3, 0, 0, 0.9, 0.2, 0.85, 0.8),
        look(0.8, 1.0, 0.45, 0.05, 0.3, 0, 0, 1.2, 0.05, 0.7, 1.0),
        look(1.1, 0.58, 1.7, 0.05, 0.4, 0, 0, 0.9, 0.3, 0.55, 1.0),
        look(0.45, 0.75, 1.0, 0.04, 0.25, 14, 0, 1.0, 0.1, 0.85, 0.85),
        look(0.3, 0.88, 1.1, 0.03, 0.25, 0, 0.035, 1.0, 0.35, 0.75, 1.0),
        look(0.6, 0.95, 1.15, 0.03, 0.25, 0, 0.012, 0.95, 0.4, 0.65, 1, 0, 0.55),
        look(0.25, 0.9, 0.7, 0.04, 0.3, 0, 0, 1, 0.1, 0.9, 0.75, 0.45, 0),
        look(0.2, 0.7, 0.35, 0.14, 0.22, 0, 0, 1.6, 0.25, 0.7, 1, 0, 0),
        look(1.4, 0.92, 0.18, 0.03, 0.3, 0, 0, 0.8, 0.1, 0.8, 1, 0, 0),
        look(0.28, 0.66, 1.4, 0.1, 0.15, 8, 0, 1.15, 0.1, 0.4, 1, 0.2, 0.25),
        look(0.9, 1, 0.5, 0.03, 0.3, 0, 0, 1.1, 0.15, 0.75, 0.95, 0, 0.45),
        look(0.1, 0.85, 0.95, 0.05, 0.2, 0, 0, 1, 0.2, 0.85, 0.9, 0.7, 0),
    ]

    static let looks: [String: [Double]] = [
        "offline": look(0.18, 0.55, 1.1, 0.03, 0.2, 0, 0, 0.9, 0.3, 0.34, 0.42),
        "listening": look(1.6, 0.45, 1.8, 0.08, 1.2, 0, 0, 1.2, 0.15, 1.0, 0.55),
        "thinking": look(4.6, 0.78, 1.3, 0.05, 0.9, 0, 0.02, 0.9, 0.62, 0.4, 1.0),
        "speaking": look(1.1, 0.78, 0.75, 0.22, 2.4, 0, 0, 1.2, 0.55, 0.95, 1.0),
        "error": look(0.15, 0.62, 0.7, 0.12, 0.5, 5, 0, 1.0, 1.0, 0.18, 0.12),
    ]

    /** A run that is held up while thinking, shown by how the face moves (docs/face.md section 9). */
    static let held: [String: [Double]] = [
        "compacting": look(0.9, 0.42, 2.4, 0.14, 0.5, 0, 0, 1.0, 0.35, 0.55, 1.0),
        "retrying": look(-2.2, 0.7, 1.0, 0.1, 1.6, 0, 0, 1.0, 1.0, 0.7, 0.25),
    ]

    /** A filled circle to paint: centre, radius and colour (0 to 1), in the 240 square. */
    public struct Circle: Equatable, Sendable {
        public var x, y, radius, r, g, b: Double
    }

    /** The icon drawn with a pen at the core: strokes of x, y pairs in the 240 square, its colour and how far it has faded in. */
    public struct Pen: Equatable, Sendable {
        public var strokes: [[Double]]
        public var width, r, g, b, alpha: Double
    }

    /** What to paint in one frame: the dots back to front, then the core, then the pen icon if any. */
    public struct Frame: Sendable {
        public var dots: [Circle]
        public var core: Circle?
        public var icon: Pen?
    }

    /** 0 up to 1; a test gives its own. */
    let random: () -> Double
    private var flash = [Double](repeating: 0, count: Face.arms * Face.dotsPerArm)
    private var now = Face.looks["offline"]!
    private var target = Face.looks["offline"]!
    private(set) var mode = "offline"
    private(set) var idleIndex = 0
    private(set) var idleRemaining = 0.0
    private var phase = 0.0, pulsePhase = 0.0, wanderPhase = 0.0, wavePhase = 0.0, tiltPhase = 0.0, flowPhase = 0.0
    private(set) var iconShown = 0.0
    private var icon: String?
    private var iconData: FaceIcons.Icon?
    private var drawnAsDots = false

    /** Loudness of the voice, 0 to 1. Negative: not known, the face pulses on its own. */
    public var level = -1.0
    /** How icons are shown: "dots" (as on the boards by default), "line" or "off". */
    public var iconStyle = "dots"
    /**
     * The person asked for less motion (Accessibility > Display > Reduce motion): the face turns at 30 % of its
     * speed and drops its sparkle (docs/face.md section 6, as the web client does).
     */
    public var reducedMotion = false

    public init(random: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        self.random = random
    }

    /** offline, idle, listening, thinking, speaking or error. */
    public func setMode(_ next: String) {
        if next == mode { return }
        mode = next
        if next == "idle" { pickIdle() } else { target = Self.looks[next] ?? Self.looks["offline"]! }
    }

    /**
     * What Axis says the agent is doing while it thinks (`doing` on a `turn`): a kind of tool, shown as an icon; a
     * reason its run is held up, shown as a look; or nothing, which is plain thinking.
     */
    public func setDoing(_ name: String?) {
        let heldLook = name.flatMap { Self.held[$0] }
        let known = heldLook == nil ? name.flatMap { FaceIcons.all[$0] } : nil
        // The one on show stays drawn while it fades, so only a new one replaces it.
        if let known { iconData = known }
        icon = known != nil ? name : nil
        if mode == "thinking" { target = heldLook ?? Self.looks["thinking"]! }
    }

    private func pickIdle() {
        var next = idleIndex
        while next == idleIndex { next = min(Self.idle.count - 1, Int(random() * Double(Self.idle.count))) }
        idleIndex = next
        idleRemaining = 7 + random() * 10
        target = Self.idle[next]
    }

    /** Moves the face on by `dt` seconds and says what to paint. */
    public func frame(_ elapsed: Double) -> Frame {
        var dt = min(max(elapsed, 0), 0.1)
        if reducedMotion { dt *= 0.3 }
        if mode == "idle" {
            idleRemaining -= dt
            if idleRemaining <= 0 { pickIdle() }
        }
        // Leaving idle should feel immediate; drifting between idle looks should not.
        let k = 1 - exp(-dt * (mode == "idle" ? 1.2 : 5.0))
        for i in 0..<now.count { now[i] += (target[i] - now[i]) * k }
        // The icon is only ever there while thinking, and comes and goes quickly.
        let wantIcon = mode == "thinking" && icon != nil && iconStyle != "off"
        iconShown += ((wantIcon ? 1 : 0) - iconShown) * (1 - exp(-dt * 4.2 * 1000 / FaceIcons.ms))
        let eye = iconShown < 0.01 ? 0 : iconShown > 0.985 ? 1 : iconShown
        if wantIcon { drawnAsDots = iconStyle == "dots" }
        let asDots = drawnAsDots && iconData != nil
        let hole = asDots ? 0 : FaceIcons.hole * eye
        flowPhase += 5 * dt
        let shapeUnit = FaceIcons.shapeSize / 24 * (1 + 0.05 * sin(pulsePhase))
        let sway = 0.07 * sin(wavePhase)
        let swayCos = cos(sway), swaySin = sin(sway)
        let tint = iconData?.tint ?? [1, 1, 1]
        var shapeColor: [Double] = []
        for (i, c) in [Self.red, Self.green, Self.blue].enumerated() {
            let base: Double = 0.55 + now[c] * 0.45
            shapeColor.append(base * 0.6 + tint[i] * 0.4)
        }

        phase += now[Self.spin] * dt
        pulsePhase += now[Self.pulseHz] * 2 * Double.pi * dt
        wanderPhase += 0.6 * dt
        wavePhase += 1.3 * dt
        tiltPhase += 0.15 * dt

        // With a known loudness, the voice drives the size instead of a sine wave.
        let voiced = (mode == "speaking" || mode == "listening") && level >= 0
        let voiceSwell = mode == "listening" ? 0.4 : now[Self.pulse]
        let cx = Self.size / 2 + now[Self.wander] * sin(wanderPhase)
        let cy = Self.size / 2 + now[Self.wander] * sin(wanderPhase * 1.7 + 1)
        // A tipped figure is squashed along one axis, and that axis turns slowly.
        let axisCos = cos(tiltPhase), axisSin = sin(tiltPhase), squash = 1 - now[Self.tilt]
        let sparkleChance = reducedMotion ? 0 : now[Self.sparkle]

        var dots: [Circle] = []
        dots.reserveCapacity(Self.arms * Self.dotsPerArm)
        for arm in 0..<Self.arms {
            // Outer dots first, so the bright inner ones are drawn on top.
            for i in stride(from: Self.dotsPerArm - 1, through: 0, by: -1) {
                let t = Double(i + 1) / Double(Self.dotsPerArm)
                let at = arm * Self.dotsPerArm + i
                if sparkleChance > 0 && random() < sparkleChance { flash[at] = 1 }
                flash[at] *= 0.86
                let spark = flash[at]

                let swell = voiced ? voiceSwell * level : now[Self.pulse] * sin(pulsePhase - t * 3)
                // The arms take turns along an icon's strokes, the inner dots first.
                let n = i * Self.arms + arm
                let inShape = asDots && n < FaceIcons.dots
                let room = asDots ? (inShape ? 0 : FaceIcons.shapeHalo * eye) : hole
                let reach = Self.maxRadius * now[Self.radius] * (1 + swell)
                let radius = room + max(0, reach - room) * pow(t, 0.85)
                // The sway runs out along the arm like a wave, and is widest at the tip.
                let armAngle: Double = Double(arm) * (2 * Double.pi / Double(Self.arms))
                let wound: Double = now[Self.twist] * 2 * Double.pi * t
                let swayed: Double = now[Self.wave] * t * sin(wavePhase - t * 7)
                let angle: Double = phase + armAngle - wound + swayed
                let glow = min(1, 1 - 0.72 * t + spark)
                let x: Double = radius * cos(angle), y: Double = radius * sin(angle)
                let along: Double = x * axisCos + y * axisSin
                let across: Double = (y * axisCos - x * axisSin) * squash
                var px: Double = cx + along * axisCos - across * axisSin
                var py: Double = cy + along * axisSin + across * axisCos
                var size = now[Self.dot] * (1.4 + 4.2 * t)
                var r: Double = now[Self.red] * glow + spark * 0.5
                var g: Double = now[Self.green] * glow + spark * 0.5
                var b: Double = now[Self.blue] * glow + spark * 0.5
                if inShape && eye > 0, let points = iconData?.points {
                    // Each dot of the shape has a place on the icon; a wave of light runs along the strokes once it is there.
                    let ix = (points[n * 2] - 12) * shapeUnit
                    let iy = (points[n * 2 + 1] - 12) * shapeUnit
                    let toX: Double = Self.size / 2 + ix * swayCos - iy * swaySin
                    let toY: Double = Self.size / 2 + ix * swaySin + iy * swayCos
                    px += (toX - px) * eye
                    py += (toY - py) * eye
                    size += (FaceIcons.shapeDot - size) * eye
                    let lit: Double = 0.62 + 0.38 * sin(flowPhase - Double(n) * 0.33) + spark * 0.5
                    r += (shapeColor[0] * lit - r) * eye
                    g += (shapeColor[1] * lit - g) * eye
                    b += (shapeColor[2] * lit - b) * eye
                }
                dots.append(Circle(x: px, y: py, radius: size, r: Self.clamp(r), g: Self.clamp(g), b: Self.clamp(b)))
            }
        }

        let coreSwing: Double = mode == "listening" ? 6 : 3
        let coreSize: Double = 7 + coreSwing * (voiced ? level : sin(pulsePhase))
        let cr = 0.55 + now[Self.red] * 0.45, cg = 0.55 + now[Self.green] * 0.45, cb = 0.55 + now[Self.blue] * 0.45
        let core: Circle? = eye < 1 ? Circle(x: cx, y: cy, radius: max(1, coreSize * (1 - eye)), r: cr, g: cg, b: cb) : nil
        var pen: Pen?
        if eye > 0 && !asDots, let data = iconData {
            // The icon takes the core's place and its colour, breathing a little with the figure.
            let unit = FaceIcons.size * (1 + 0.04 * sin(pulsePhase)) / 24
            var strokes: [[Double]] = []
            for stroke in data.strokes {
                var placed: [Double] = []
                for (i, v) in stroke.enumerated() { placed.append((i % 2 == 0 ? cx : cy) + (v - 12) * unit) }
                strokes.append(placed)
            }
            pen = Pen(strokes: strokes, width: FaceIcons.pen, r: cr, g: cg, b: cb, alpha: eye)
        }
        return Frame(dots: dots, core: core, icon: pen)
    }

    static func clamp(_ v: Double) -> Double { min(1, max(0, v)) }
}

/**
 * Which look the face shows on a computer and whether it is wanted on screen: the voice part's mode, and whether an
 * agent is using this computer, shown as thinking with the computer icon when nothing else is going on (the Windows
 * app's `FaceWindow.Set`). Pure, so it is tested off the Mac.
 */
public struct FaceShow: Equatable, Sendable {
    /** The face's mode: idle, listening, thinking, speaking or error. */
    public var mode: String
    /** The icon or held look while thinking. */
    public var doing: String?
    /** Whether the voice's loudness drives it (listening or speaking). */
    public var voiced: Bool
    /** Whether it should be on screen for this (it stays when kept, and leaves `leaveAfter` seconds after it is not wanted). */
    public var wanted: Bool

    /** How long the face stays after the turn is over, so it does not blink out between a reply and the next call. */
    public static let leaveAfter = 2.5

    public static func of(_ voice: VoiceMode, doing: String?, agentHere: Bool) -> FaceShow {
        let mode: String
        switch voice {
        case .listening: mode = "listening"
        case .transcribing, .thinking: mode = "thinking"
        case .speaking: mode = "speaking"
        case .error: mode = "error"
        case .idle: mode = agentHere ? "thinking" : "idle"
        }
        return FaceShow(mode: mode, doing: mode == "thinking" ? (agentHere ? "computer" : doing) : nil,
                        voiced: voice == .listening || voice == .speaking, wanted: mode != "idle")
    }
}

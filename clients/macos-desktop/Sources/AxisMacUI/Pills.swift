import AppKit
import SwiftUI
import AxisDesktopCore

/** What a pill's chrome needs to know, changed by its `PillHost` (the words are the pill's own view). */
@MainActor
final class PillStage: ObservableObject {
    @Published var expanded = false
    @Published var attached = false
    @Published var topInset: Double = 0
    @Published var width: Double = 120
    @Published var height: Double = 36
    @Published var collapsedWidth: Double = 96
    @Published var collapsedHeight: Double = 24
    @Published var tint: PillTint = .speaking
}

/**
 * One notice at the top middle of the main display (the Windows app's `Pill`): a dark pill with a soft shadow and a thin
 * edge in the colour of what is going on, the words its owner gives. On a MacBook with a notch the first pill grows out
 * of the notch, black and flush with the top, like the Dynamic Island, and draws back into it; elsewhere it floats under
 * the menu bar and grows from a small capsule. A spring either way, a quick fade with Reduce motion. Click-through
 * unless it has buttons; never takes the focus; out of every screen capture.
 */
@MainActor
final class PillHost {
    private let panel: FloatingPanel
    private let stage: PillStage
    private let host: FirstClickHostingView<PillChrome>
    private var words = AnyView(EmptyView())
    private var wordsSize = CGSize(width: 120, height: 36)
    /** Widest the words may be. */
    private let maxWidth: CGFloat
    /** Whether it is on screen or on its way in. */
    private(set) var up = false
    private var generation = 0
    /** The bottom (AppKit y) of the pill above this one, or nil when it is the first. */
    var under: () -> Double? = { nil }
    /** Where the pill itself is just now (to place one under it). */
    private(set) var pillRect: PanelRect?
    private var placed: PillLayout.Placed?

    init(maxWidth: CGFloat) {
        self.maxWidth = maxWidth
        let stage = PillStage()
        self.stage = stage
        panel = FloatingPanel.make(level: FloatingPanel.overMenuBar)
        host = FirstClickHostingView(rootView: PillChrome(stage: stage, words: AnyView(EmptyView())))
        // The panel's frame is set here, from PillLayout; the hosting view is not to resize it to its content.
        host.sizingOptions = []
        panel.contentView = host
    }

    /** New words: measured, the pill sized and placed for them. */
    func show(_ view: some View, tint: PillTint) {
        words = AnyView(view)
        stage.tint = tint
        let measure = NSHostingController(rootView: view)
        let fits = measure.sizeThatFits(in: CGSize(width: maxWidth, height: 600))
        wordsSize = CGSize(width: ceil(min(fits.width, maxWidth)), height: ceil(fits.height))
        host.rootView = PillChrome(stage: stage, words: words)
        place()
    }

    /** The same words in a new state that does not change their size (the dot swelling with the voice): not measured again. */
    func refresh(_ view: some View) {
        words = AnyView(view)
        host.rootView = PillChrome(stage: stage, words: words)
    }

    /** Lets clicks land on it (a question's buttons); off, it is click-through. */
    func clickable(_ on: Bool) { panel.ignoresMouseEvents = !on }

    /** Where it belongs now (the pill above came or went, the displays changed). */
    func place() {
        guard let screen = Screens.pillScreen else { return }
        let placed = PillLayout.place(w: Double(wordsSize.width), h: Double(wordsSize.height), on: screen, under: under())
        pillRect = placed.pill
        // The voice part reports with every frame of the microphone: nothing to do when nothing moved.
        guard placed != self.placed else { return }
        self.placed = placed
        stage.attached = placed.attached
        stage.topInset = placed.topInset
        stage.width = placed.pill.w
        stage.height = placed.pill.h
        stage.collapsedWidth = placed.collapsed.w
        stage.collapsedHeight = placed.collapsed.h
        panel.setFrame(Screens.nsRect(placed.panel), display: true)
    }

    func fadeIn() {
        place()
        guard !up else { return }
        up = true
        generation += 1
        stage.expanded = false
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { c in
            c.duration = 0.18
            panel.animator().alphaValue = 1
        }
        // Grown on the next turn of the run loop, so SwiftUI sees the change and springs it.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.up else { return }
            self.stage.expanded = true
        }
    }

    func fadeOut() {
        guard up else { return }
        up = false
        generation += 1
        let mine = generation
        stage.expanded = false
        // Drawn back in (into the notch, where it vanishes against the black), then faded.
        DispatchQueue.main.asyncAfter(deadline: .now() + (Screens.reduceMotion ? 0.05 : 0.3)) { [weak self] in
            guard let self, self.generation == mine else { return }
            NSAnimationContext.runAnimationGroup({ c in
                c.duration = 0.15
                self.panel.animator().alphaValue = 0
            }, completionHandler: { [weak self] in
                Task { @MainActor in
                    guard let self, self.generation == mine else { return }
                    self.panel.orderOut(nil)
                    self.pillRect = nil
                    self.placed = nil
                }
            })
        }
    }

    /** Gone at once. */
    func vanish() {
        up = false
        generation += 1
        stage.expanded = false
        panel.alphaValue = 0
        panel.orderOut(nil)
        pillRect = nil
        placed = nil
    }
}

/** A hosting view a click reaches even though its panel never becomes key (the question's buttons). */
final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/** Colours shared by the pills (the Windows app's). */
enum PillColour {
    static let bright = Color(red: 0xF2 / 255.0, green: 0xF3 / 255.0, blue: 0xF7 / 255.0)
    static let dim = Color(red: 0x9A / 255.0, green: 0x9C / 255.0, blue: 0xAA / 255.0)

    static func of(_ tint: PillTint) -> Color {
        let c = tint.rgb
        return Color(red: Double(c.r) / 255, green: Double(c.g) / 255, blue: Double(c.b) / 255)
    }
}

/** The pill's shape and surface around its words, growing and shrinking with the stage. */
struct PillChrome: View {
    @ObservedObject var stage: PillStage
    let words: AnyView
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let w = stage.expanded ? stage.width : stage.collapsedWidth
        let h = stage.expanded ? stage.height : stage.collapsedHeight
        let tint = PillColour.of(stage.tint)
        let shape = PillShape(radius: stage.attached ? 18 : min(16, h / 2), squareTop: stage.attached)
        ZStack(alignment: .top) {
            if stage.attached {
                // Black as the notch it grows from.
                shape.fill(Color.black)
            } else {
                // A little lighter at the top than at the bottom, like a surface lit from above.
                shape.fill(LinearGradient(colors: [Color(red: 0x1A / 255.0, green: 0x1B / 255.0, blue: 0x24 / 255.0),
                                                   Color(red: 0x0D / 255.0, green: 0x0D / 255.0, blue: 0x13 / 255.0)],
                                          startPoint: .top, endPoint: .bottom))
                    .opacity(0.96)
                shape.stroke(LinearGradient(colors: [tint.opacity(0.6), tint.opacity(0.2)], startPoint: .top, endPoint: .bottom), lineWidth: 1)
            }
            words
                .padding(.top, stage.topInset)
                .frame(width: stage.width, height: stage.height, alignment: .top)
                .opacity(stage.expanded ? 1 : 0)
        }
        .frame(width: w, height: h, alignment: .top)
        .clipShape(shape)
        .shadow(color: .black.opacity(stage.attached ? 0.35 : 0.5), radius: 9, x: 0, y: 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, stage.attached ? 0 : PillLayout.margin)
        .animation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.36, dampingFraction: 0.74), value: stage.expanded)
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: stage.width)
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.85), value: stage.height)
        .environment(\.colorScheme, .dark)
    }
}

/** A rounded rectangle, or one square at the top (grown out of the notch), for macOS 13 (no UnevenRoundedRectangle). */
struct PillShape: Shape {
    var radius: Double
    var squareTop: Bool

    func path(in rect: CGRect) -> Path {
        let r = min(CGFloat(radius), rect.width / 2, rect.height / 2)
        guard squareTop else { return Path(roundedRect: rect, cornerRadius: r) }
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - r), control: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath()
        return p
    }
}

/** The glowing dot in the colour of the moment. */
struct PillDot: View {
    let tint: PillTint
    var scale: Double = 1
    /** Breathes (the "using this computer" pill), unless Reduce motion is on. */
    var breathes = false
    @State private var dimmed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let c = PillColour.of(tint)
        Circle()
            .fill(c)
            .frame(width: 9, height: 9)
            .shadow(color: c.opacity(0.9), radius: 4.5)
            .scaleEffect(scale)
            .opacity(dimmed ? 0.4 : 1)
            .onAppear {
                guard breathes, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.75).repeatForever(autoreverses: true)) { dimmed = true }
            }
    }
}

// MARK: - The two pills

/**
 * While an agent is using this Mac (looking, clicking, typing): a rose dot that breathes, "VorteX is using this
 * computer" and the last thing it did. From the first desktop command until `ControlPillWords.linger` after the last.
 */
@MainActor
final class ControlPill {
    let host: PillHost
    private var doing = ""
    private var wanted = false
    private var generation = 0
    /** It came or went, or an agent arrived or left: what sits under it moves, the face and the menu bar icon follow. */
    var onChange: (() -> Void)?

    init() { host = PillHost(maxWidth: 560) }

    /** An agent is at this Mac just now. */
    var active: Bool { wanted }
    /** The bottom of the pill (AppKit y) when it is up, for the voice pill under it. */
    var bottom: Double? { host.up ? host.pillRect?.y : nil }

    /** An agent's command has just come in. */
    func touch() {
        let was = wanted
        wanted = true
        generation += 1
        let mine = generation
        redraw()
        host.fadeIn()
        DispatchQueue.main.asyncAfter(deadline: .now() + ControlPillWords.linger) { [weak self] in
            guard let self, self.generation == mine else { return }
            self.wanted = false
            self.host.fadeOut()
            self.onChange?()
        }
        if !was { onChange?() }
    }

    /** What it just did, in the app's own words. */
    func did(_ line: String) {
        doing = line
        if host.up { redraw() }
    }

    /** Away at once (paused, or the pill switched off). */
    func dismiss() {
        generation += 1
        let was = wanted
        wanted = false
        host.vanish()
        if was { onChange?() }
    }

    /** Back in place (the displays changed). */
    func replace() { if host.up { host.place() } }

    private func redraw() { host.show(ControlPillView(doing: doing), tint: .control) }
}

struct ControlPillView: View {
    let doing: String

    var body: some View {
        HStack(spacing: 0) {
            PillDot(tint: .control, breathes: true).padding(.trailing, 11)
            Text(ControlPillWords.title)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundColor(PillColour.bright)
                .lineLimit(1)
                .fixedSize()
            if !doing.isEmpty {
                Rectangle().fill(Color.white.opacity(0.25)).frame(width: 1, height: 13).padding(.horizontal, 11)
                Text(doing)
                    .font(.system(size: 12))
                    .foregroundColor(PillColour.dim)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 300, alignment: .leading)
            }
        }
        .padding(EdgeInsets(top: 9, leading: 15, bottom: 10, trailing: 17))
    }
}

/**
 * While talking from this Mac (under the "using this computer" pill when both show): a word in the colour of the
 * moment (the dot swells with the voice while listening), what was heard in quotes, and the reply; a question waiting
 * here with its choices as buttons. It goes `VoicePillWords.linger` seconds after the answer.
 */
@MainActor
final class VoicePill {
    let host: PillHost
    private var lingering = false
    private var generation = 0
    private var shown: VoicePillWords?
    /** Called with the choice a button was pressed for. */
    var onChoice: ((String) -> Void)?

    init() { host = PillHost(maxWidth: 480) }

    func show(_ snapshot: VoiceSnapshot, talkKey: String) {
        let w = VoicePillWords.of(snapshot, talkKey: talkKey)
        if w != shown {
            // While listening the dot swells with every frame of the microphone: only the words changing are measured again.
            var sized = w
            sized.dotScale = shown?.dotScale ?? w.dotScale
            let view = VoicePillView(words: w, chose: { [weak self] in self?.onChoice?($0) })
            if sized == shown { host.refresh(view) } else { host.show(view, tint: w.tint) }
            shown = w
            host.clickable(!w.choices.isEmpty)
        }
        switch w.then {
        case .show:
            stopLinger()
            host.fadeIn()
        case .showThenLeave:
            stopLinger()
            host.fadeIn()
            linger()
        case .leaveSoon:
            if host.up && !lingering { linger() }
        case .hide:
            stopLinger()
            host.fadeOut()
        }
    }

    /** Away at once (talking switched off). */
    func dismiss() {
        stopLinger()
        shown = nil
        host.vanish()
    }

    /** Back in place (the pill above came or went, the displays changed). */
    func replace() { if host.up { host.place() } }

    private func linger() {
        lingering = true
        generation += 1
        let mine = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + VoicePillWords.linger) { [weak self] in
            guard let self, self.generation == mine else { return }
            self.lingering = false
            self.host.fadeOut()
        }
    }

    private func stopLinger() {
        lingering = false
        generation += 1
    }
}

struct VoicePillView: View {
    let words: VoicePillWords
    let chose: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            PillDot(tint: words.tint, scale: words.dotScale).padding(.top, 4.5).padding(.trailing, 11)
            VStack(alignment: .leading, spacing: 0) {
                if !words.status.isEmpty {
                    Text(words.status)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(PillColour.of(words.tint))
                }
                if !words.heard.isEmpty {
                    Text(words.heard)
                        .font(.system(size: 12))
                        .italic(words.heardIsSpeech)
                        .foregroundColor(words.heardIsSpeech ? PillColour.dim : PillColour.bright)
                        .lineLimit(words.heardIsSpeech ? 2 : 4)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, words.status.isEmpty ? 0 : 3)
                }
                if !words.reply.isEmpty {
                    // The line between them only when there is something above it.
                    if !words.heard.isEmpty || !words.status.isEmpty {
                        Rectangle().fill(Color.white.opacity(0.15)).frame(height: 1).padding(.top, 7).padding(.bottom, 6)
                    }
                    Text(words.reply)
                        .font(.system(size: 13))
                        .foregroundColor(PillColour.bright)
                        .lineSpacing(2)
                        .lineLimit(5)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !words.choices.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(Array(words.choices.enumerated()), id: \.offset) { _, choice in
                            Button(action: { chose(choice) }) {
                                Text(choice)
                                    .font(.system(size: 12.5, weight: .medium))
                                    .foregroundColor(PillColour.bright)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 4)
                                    .background(RoundedRectangle(cornerRadius: 7).fill(PillColour.of(.question).opacity(0.2)))
                                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(PillColour.of(.question).opacity(0.6), lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 9)
                }
            }
            .frame(minWidth: 120, alignment: .leading)
        }
        .padding(EdgeInsets(top: 9, leading: 15, bottom: 10, trailing: 17))
    }
}

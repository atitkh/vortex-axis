import AppKit
import SwiftUI
import AxisDesktopCore

// MARK: - The task pill

/**
 * An agent's long task (`progress.show`): the title, how far, a thin bar when the steps are counted, "+N" for the
 * other tasks. A click opens the list (the other tasks, then the steps), as a tap does on a board; a finished task
 * has a × that puts it away. Short and clipped: the whole story is on the admin page's Live page.
 */
@MainActor
final class TaskPill {
    let host = PillHost(maxWidth: 360)
    private var shown: TaskPillWords?
    private var open = false
    /** The × on a finished task. */
    var onDismiss: (() -> Void)?

    func show(_ words: TaskPillWords?) {
        guard let words else {
            shown = nil
            open = false
            host.fadeOut()
            return
        }
        if words.rows.isEmpty { open = false }
        if words != shown { redraw(words) }
        host.clickable(true)
        host.fadeIn()
    }

    func vanish() {
        shown = nil
        host.vanish()
    }

    func replace() { if host.up { host.place() } }

    private func redraw(_ words: TaskPillWords) {
        shown = words
        host.show(TaskPillView(words: words, open: open,
                               toggle: { [weak self] in self?.toggle() },
                               dismiss: { [weak self] in self?.onDismiss?() }), tint: words.tint)
    }

    private func toggle() {
        guard let words = shown, !words.rows.isEmpty else { return }
        open.toggle()
        redraw(words)
    }
}

struct TaskPillView: View {
    let words: TaskPillWords
    let open: Bool
    let toggle: () -> Void
    let dismiss: () -> Void
    static let width: CGFloat = 300

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                PillDot(tint: words.tint, breathes: words.tint == .task).padding(.trailing, 10)
                Text(words.title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(PillColour.bright)
                    .lineLimit(1)
                    .layoutPriority(1)
                if !words.detail.isEmpty {
                    Text(words.detail)
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundColor(words.tint == .task ? PillColour.dim : PillColour.of(words.tint))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.leading, 8)
                }
                Spacer(minLength: 6)
                if !words.more.isEmpty {
                    Text(words.more)
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundColor(PillColour.dim)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.1)))
                }
                if !words.rows.isEmpty {
                    Image(systemName: open ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(PillColour.dim)
                        .padding(.leading, 6)
                }
                if words.dismissible {
                    Button(action: dismiss) {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(PillColour.bright)
                            .frame(width: 18, height: 18)
                            .background(Circle().fill(Color.white.opacity(0.14)))
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, 6)
                    .help("Put the finished tasks away (on every screen)")
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: toggle)
            if let fraction = words.fraction {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.12))
                        Capsule().fill(PillColour.of(words.tint)).frame(width: max(3, g.size.width * fraction))
                    }
                }
                .frame(height: 3)
                .padding(.top, 7)
            }
            if open {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(words.rows.enumerated()), id: \.offset) { _, row in
                        HStack(spacing: 7) {
                            Text(Self.mark(row.kind))
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(Self.colour(row.kind))
                                .frame(width: 12)
                            Text(row.text)
                                .font(.system(size: 12))
                                .foregroundColor(row.kind == .pending ? PillColour.dim : PillColour.bright)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                }
                .padding(.top, 8)
            }
        }
        .frame(width: Self.width, alignment: .leading)
        .padding(EdgeInsets(top: 9, leading: 15, bottom: 10, trailing: 13))
    }

    static func mark(_ kind: TaskPillWords.Row.Kind) -> String {
        switch kind {
        case .done: return "✓"
        case .running: return "▸"
        case .pending: return "·"
        case .needsYou: return "!"
        case .task: return "•"
        }
    }

    static func colour(_ kind: TaskPillWords.Row.Kind) -> Color {
        switch kind {
        case .done: return PillColour.of(.done)
        case .running: return PillColour.of(.task)
        case .needsYou: return PillColour.of(.needsYou)
        case .pending, .task: return PillColour.dim
        }
    }
}

// MARK: - The timer pill

/**
 * The next timer (`timer.next`): its name and the time left, "+N" for more, red in the last 10 s; a × cancels it as
 * the web client's does (Axis then sends the next one). At 0:00 Axis rings it: the chime, then the words.
 */
@MainActor
final class TimerPill {
    let host = PillHost(maxWidth: 300)
    private var timer: NextTimer?
    private var now: () -> UInt64 = { 0 }
    private var ticking: Timer?
    private var shown: TimerPillWords?
    /** The × pressed for the timer with this id. */
    var onCancel: ((Int) -> Void)?

    func show(_ next: NextTimer?, now: @escaping () -> UInt64) {
        self.now = now
        timer = next
        guard next != nil else {
            stopTicking()
            shown = nil
            host.fadeOut()
            return
        }
        tick()
        host.clickable(true)
        host.fadeIn()
        if ticking == nil {
            let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
            RunLoop.main.add(t, forMode: .common)
            ticking = t
        }
    }

    func vanish() {
        stopTicking()
        shown = nil
        timer = nil
        host.vanish()
    }

    func replace() { if host.up { host.place() } }

    private func tick() {
        guard let timer else { return }
        let words = TimerPillWords.of(timer, now: now())
        guard words != shown else { return }
        shown = words
        let id = timer.id
        host.show(TimerPillView(words: words, cancel: { [weak self] in if let id { self?.onCancel?(id) } }), tint: words.tint)
    }

    private func stopTicking() {
        ticking?.invalidate()
        ticking = nil
    }
}

struct TimerPillView: View {
    let words: TimerPillWords
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Image(systemName: "timer")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(PillColour.of(words.tint))
                .padding(.trailing, 8)
            Text(words.label)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundColor(PillColour.bright)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 150, alignment: .leading)
            Text(words.clock)
                .font(.system(size: 12.5, weight: .medium).monospacedDigit())
                .foregroundColor(PillColour.of(words.tint))
                .lineLimit(1)
                .fixedSize()
                .padding(.leading, 9)
            if words.cancellable {
                Button(action: cancel) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(PillColour.bright)
                        .frame(width: 18, height: 18)
                        .background(Circle().fill(Color.white.opacity(0.14)))
                }
                .buttonStyle(.plain)
                .padding(.leading, 10)
                .help("Cancel this timer")
            }
        }
        .padding(EdgeInsets(top: 8, leading: 14, bottom: 9, trailing: 12))
    }
}

// MARK: - The typing pill

/** What the typing pill shows and holds: the text, how many lines it takes, a question it would answer. */
@MainActor
final class TypingState: ObservableObject {
    @Published var lines = 1
    @Published var question: String?
    @Published var choices: [String] = []
    weak var field: TypingTextView?
    var text: String { field?.string ?? "" }
}

/**
 * Typing to the agent, in the voice pill's slot: a capsule with a field that grows from one line to three, then
 * scrolls. Return sends, Shift+Return (or Option+Return) starts a new line, Esc closes it, ↑ in an empty field brings
 * back the last message sent. Its panel takes the keyboard without bringing the app forward (`KeyablePanel`), and
 * lets go of it as soon as it closes, so the app in front gets its keys back.
 */
@MainActor
final class TypingPill {
    let host = PillHost(maxWidth: CGFloat(TypingLayout.width), keyable: true)
    let state = TypingState()
    private(set) var isOpen = false
    /** The last message sent, for ↑. */
    var last = ""
    var onSend: ((String) -> Void)?
    var onChoice: ((String) -> Void)?
    var onClose: (() -> Void)?
    private var resigned: Any?

    init() {
        resigned = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: host.panel, queue: .main) { [weak self] _ in
            // Clicked away with nothing typed: it goes, as Spotlight does; with words in it, it stays for a click back.
            Task { @MainActor in
                guard let self, self.isOpen, self.state.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                self.close()
            }
        }
    }

    func open(question: String?, choices: [String]) {
        state.question = question
        state.choices = choices
        if !isOpen {
            isOpen = true
            state.lines = 1
            state.field?.string = ""
        }
        redraw()
        host.clickable(true)
        host.fadeIn()
        focus()
    }

    /** A question came or went while it is open. */
    func ask(_ question: String?, choices: [String]) {
        guard isOpen, question != state.question || choices != state.choices else { return }
        state.question = question
        state.choices = choices
        redraw()
    }

    /** Away at once, giving the keyboard back first. */
    func close() {
        guard isOpen else { return }
        isOpen = false
        state.field?.string = ""
        if host.panel.isKeyWindow { host.panel.makeFirstResponder(nil) }
        host.vanish()
        onClose?()
    }

    func replace() { if host.up { host.place() } }

    func linesChanged(_ n: Int) {
        let lines = TypingLayout.lines(n)
        guard lines != state.lines else { return }
        state.lines = lines
        redraw()
    }

    func send() {
        let text = state.text
        guard TypedText.clean(text) != nil else { return }
        last = text
        // Sent first, so the voice pill that takes the slot back already says Thinking.
        onSend?(text)
        close()
    }

    func recall() -> String? { last.isEmpty ? nil : last }

    private func redraw() {
        let h = TypingLayout.height(lines: state.lines, questionLines: state.question == nil ? 0 : Self.questionLines(state.question!),
                                    choices: !state.choices.isEmpty)
        host.show(TypingPillView(state: state, pill: self, height: h), tint: state.question == nil ? .speaking : .question,
                  size: CGSize(width: TypingLayout.width, height: h))
    }

    /** About how many lines a question takes in the pill (at most 3, clipped). */
    static func questionLines(_ q: String) -> Int { min(3, max(1, Int((Double(q.count) / 62).rounded(.up)))) }

    /** The keyboard to the field: the panel becomes key (the app stays where it is), then the field first responder. */
    private func focus() {
        host.panel.makeKey()
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isOpen, let field = self.state.field else { return }
            self.host.panel.makeKey()
            self.host.panel.makeFirstResponder(field)
        }
    }
}

struct TypingPillView: View {
    @ObservedObject var state: TypingState
    let pill: TypingPill
    let height: Double

    var body: some View {
        let tint: PillTint = state.question == nil ? .speaking : .question
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                PillDot(tint: tint).padding(.trailing, 10)
                Text(TypingPillWords.status)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(PillColour.of(tint))
                Spacer()
                Text("esc")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(PillColour.dim)
            }
            .frame(height: TypingLayout.status, alignment: .top)
            if let q = state.question {
                Text(q)
                    .font(.system(size: 12))
                    .foregroundColor(PillColour.bright)
                    .lineLimit(TypingPill.questionLines(q))
                    .frame(height: Double(TypingPill.questionLines(q)) * TypingLayout.questionLine, alignment: .topLeading)
            }
            if !state.choices.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(state.choices.enumerated()), id: \.offset) { _, choice in
                        Button(action: { pill.onChoice?(choice) }) {
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
                .frame(height: TypingLayout.choicesRow, alignment: .center)
            }
            TypingField(pill: pill, placeholder: state.question == nil ? TypingPillWords.placeholder : TypingPillWords.answerPlaceholder)
                .frame(height: TypingLayout.fieldHeight(lines: state.lines))
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.07)))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(PillColour.of(tint).opacity(0.35), lineWidth: 1))
        }
        .padding(EdgeInsets(top: TypingLayout.padTop, leading: 15, bottom: TypingLayout.padBottom, trailing: 15))
        .frame(width: TypingLayout.width, height: height, alignment: .top)
    }
}

/** The field: an NSTextView in a scroll view (SwiftUI's TextField on macOS 13 does not grow, nor tell Return from Shift+Return). */
struct TypingField: NSViewRepresentable {
    let pill: TypingPill
    let placeholder: String

    func makeCoordinator() -> Coordinator { Coordinator(pill: pill) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let text = TypingTextView(frame: NSRect(x: 0, y: 0, width: TypingLayout.width - 30, height: TypingLayout.lineHeight + TypingLayout.fieldPad))
        text.delegate = context.coordinator
        text.isRichText = false
        text.importsGraphics = false
        text.allowsUndo = true
        text.drawsBackground = false
        text.font = TypingTextView.font
        text.textColor = NSColor(white: 0.95, alpha: 1)
        text.insertionPointColor = NSColor(red: 0x8C / 255.0, green: 0xF2 / 255.0, blue: 1, alpha: 1)
        text.textContainerInset = NSSize(width: 6, height: TypingLayout.fieldPad / 2)
        text.isAutomaticQuoteSubstitutionEnabled = false
        text.isAutomaticDashSubstitutionEnabled = false
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.minSize = NSSize(width: 0, height: 0)
        text.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.containerSize = NSSize(width: text.frame.width, height: CGFloat.greatestFiniteMagnitude)
        text.textContainer?.widthTracksTextView = true
        text.textContainer?.lineFragmentPadding = 2
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = CGFloat(TypingLayout.lineHeight)
        style.maximumLineHeight = CGFloat(TypingLayout.lineHeight)
        text.defaultParagraphStyle = style
        text.typingAttributes = [.font: TypingTextView.font, .foregroundColor: NSColor(white: 0.95, alpha: 1), .paragraphStyle: style]
        text.placeholder = placeholder
        scroll.documentView = text
        pill.state.field = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.pill = pill
        if let text = scroll.documentView as? TypingTextView, text.placeholder != placeholder {
            text.placeholder = placeholder
            text.needsDisplay = true
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var pill: TypingPill
        init(pill: TypingPill) { self.pill = pill }

        func textDidChange(_ notification: Notification) {
            guard let text = notification.object as? TypingTextView else { return }
            // Axis takes 4000 characters at most: a longer paste is cut, on a whole character.
            let clipped = TypedText.clip(text.string)
            if clipped != text.string { text.string = clipped }
            text.needsDisplay = true
            pill.linesChanged(text.lineCount)
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                } else {
                    pill.send()
                }
                return true
            case #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
                textView.insertNewlineIgnoringFieldEditor(nil)
                return true
            case #selector(NSResponder.cancelOperation(_:)):
                pill.close()
                return true
            case #selector(NSResponder.moveUp(_:)):
                // ↑ in an empty field (or at its very start) brings back the last message.
                guard textView.string.isEmpty || textView.selectedRange().location == 0, let last = pill.recall() else { return false }
                textView.string = last
                textView.setSelectedRange(NSRange(location: (last as NSString).length, length: 0))
                textDidChange(Notification(name: NSText.didChangeNotification, object: textView))
                return true
            default:
                return false
            }
        }
    }
}

/** The typing field's text view: a placeholder while empty, and how many lines its text takes. */
final class TypingTextView: NSTextView {
    static let font = NSFont.systemFont(ofSize: 13)
    var placeholder = ""

    var lineCount: Int {
        guard let layout = layoutManager, let container = textContainer else { return 1 }
        layout.ensureLayout(for: container)
        let used = layout.usedRect(for: container).height
        return max(1, Int((used / CGFloat(TypingLayout.lineHeight)).rounded()))
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty else { return }
        let origin = NSPoint(x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0), y: textContainerInset.height)
        (placeholder as NSString).draw(at: origin, withAttributes: [.font: Self.font, .foregroundColor: NSColor(white: 0.6, alpha: 0.8)])
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.makeFirstResponder(self)
    }
}

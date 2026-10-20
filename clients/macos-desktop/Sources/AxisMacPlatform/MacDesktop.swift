import AppKit
import AxisDesktopCore

/** Draws the agent's pointer. The UI supplies it (`PointerPanel`); it is called on the main thread. */
@MainActor
public protocol PointerDrawing: AnyObject {
    /**
     * Shows the pointer at (x, y), top-left points, with `text` beside it when there is any, for `seconds`. True when
     * it glides there from where it was (the caller gives it time to arrive), false when it appears on the spot.
     */
    @discardableResult
    func show(x: Int, y: Int, text: String?, seconds: Double) -> Bool
    func hide()
}

/** A value carried across a concurrency boundary it is safe to cross (an AX handle, a closure run on one queue). */
final class Carried<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/** An Accessibility or input call that did not come back in time. */
struct Stuck: SaysWhy {
    let what: String
    var message: String { "\(what) took too long (the app in front is not answering)" }
}

/**
 * The Mac as Core's `Desktop`: looks through Accessibility (`AXReader`), windows and displays from Quartz
 * (`WindowList`, `WindowPick`), text from the pixels (`TextReader`), pictures (`ScreenCapture`), input through
 * CGEvent (`InputEvents`) and AX actions (`AXActions`), apps through NSWorkspace (`Apps`), the clipboard
 * (`Pasteboard`), the pointer through the UI. The "intended window" of the Windows app is kept here: type and keys
 * go to the app the agent last opened, switched to or acted in, brought back first when something took the front.
 */
public final class MacDesktop: Desktop, @unchecked Sendable {
    /** Fewer named controls than this, and auto OCR reads the pixels too (the Windows app's rule). */
    static let sparseBelow = 8
    static let ocrPatienceMs = 4000
    /** How long the read of the focus may take; past it a state goes without the focus. */
    static let statePatienceMs = 1500
    /** Longest an app gets to show its window after open, and how long an open waits when its app already had the front. */
    static let openPatienceMs = 8000, sameAppMs = 1500
    /** How long the window the agent works in is remembered. */
    static let intendedFor: TimeInterval = 90
    /** How long a drag's move takes, after any hold. */
    static let dragMoveMs = 400
    /** The pointer's glide (PointerPanel); it gets this and a moment more before an action, so the person can follow it. */
    static let glideMs = 220

    let reader = AXReader()
    /** Mouse and keyboard events go one action at a time, never two interleaved. */
    let inputQueue = DispatchQueue(label: "VorteX Axis input", qos: .userInitiated)
    weak var pointerDrawing: PointerDrawing?
    private let lock = NSLock()
    private var intended: (pid: pid_t, title: String, box: Box, at: Date)?
    /** A window's box before "maximize", for "restore", by "pid title". */
    private var beforeFill: [String: Box] = [:]
    /** The window `window do=minimize` last put in the Dock, for a restore that names none. */
    private var minimisedLast: (pid: pid_t, title: String)?
    /** Windows taken out of macOS full screen to be minimised: a restore puts them back (0.2.1's live test). */
    private var fullScreenBefore = FullScreenMemory()

    public init() {}

    @MainActor public func usePointer(_ pointer: PointerDrawing) { pointerDrawing = pointer }

    // MARK: Running blocking work

    /** `work` on `queue` under a deadline; throws `Stuck` past it. The work itself is left to finish (AX cannot be cancelled). */
    func on<T>(_ queue: DispatchQueue, _ ms: Int, _ what: String, _ work: @escaping () throws -> T) async throws -> T {
        let job = Carried(work)
        let done = try await within(ms: ms, { () async throws -> Carried<T> in
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Carried<T>, Error>) in
                queue.async { c.resume(with: Result { Carried(try job.value()) }) }
            }
        })
        guard let done else { throw Stuck(what: what) }
        return done.value
    }

    /** Accessibility work on the reader's queue. */
    func ax<T>(_ ms: Int, _ what: String, _ work: @escaping () throws -> T) async throws -> T {
        try await on(reader.queue, ms, what, work)
    }

    /** Mouse and keyboard work, one at a time. */
    func input<T>(_ ms: Int, _ what: String, _ work: @escaping () throws -> T) async throws -> T {
        try await on(inputQueue, ms, what, work)
    }

    /** `work` on the accessibility queue under a deadline; nil when it has nothing, fails or takes too long. */
    func quick<T>(_ ms: Int, _ work: @escaping () -> T?) async -> T? {
        guard let got = try? await ax(ms, "reading", work) else { return nil }
        return got
    }

    static func axElement(_ ref: AnyObject?) -> AXUIElement? {
        guard let ref, CFGetTypeID(ref) == AXUIElementGetTypeID() else { return nil }
        return (ref as! AXUIElement)
    }

    static func middle(_ e: ScreenElement) -> (x: Int, y: Int) { (e.x + e.w / 2, e.y + e.h / 2) }

    // MARK: The window in front

    struct FrontRead: Sendable {
        let pid: pid_t
        let window: FocusedWindow?
    }

    /**
     * The window in front, one source of truth (`WindowPick.front`): the app Accessibility says has the focus (else
     * AppKit's front app), its focused window's box from Accessibility, checked against Quartz's windows on this
     * Space. Nothing when that app has no window here (Finder's desktop, an app on another Space).
     */
    func frontWindow() async -> (pid: pid_t, window: WindowInfo)? {
        let own = ProcessInfo.processInfo.processIdentifier
        var pid: pid_t?
        var focused: FocusedWindow?
        if Permissions.accessibility {
            let read: FrontRead? = await quick(800, { [reader] () -> FrontRead? in
                guard let p = reader.focusedPid() ?? NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
                return FrontRead(pid: p, window: p == own ? nil : reader.focusedWindow(pid: p))
            })
            pid = read?.pid
            focused = read?.window
        }
        if pid == nil { pid = NSWorkspace.shared.frontmostApplication?.processIdentifier }
        let list = WindowList.candidates(onScreenOnly: true)
        guard let pick = WindowPick.front(pid: pid, focused: focused, list: list, displays: WindowList.displays(), ownPid: own) else { return nil }
        let owner = list.first(where: { $0.pid == pick.pid })?.owner
        return (pick.pid, info(pid: pick.pid, title: pick.title, box: pick.box, owner: owner))
    }

    func info(pid: pid_t, title: String, box: Box, owner: String?) -> WindowInfo {
        let running = NSRunningApplication(processIdentifier: pid)
        return WindowInfo(title: title, app: running?.localizedName ?? owner ?? "", x: box.x, y: box.y, w: box.w, h: box.h,
                          bundleID: running?.bundleIdentifier)
    }

    func info(_ w: WindowCandidate) -> WindowInfo { info(pid: w.pid, title: w.title, box: w.box, owner: w.owner) }

    public func inFront() async -> WindowInfo? { await frontWindow()?.window }

    // MARK: Reading

    public func look(scope: String, ocr: OcrMode) async throws -> LookResult {
        let started = DispatchTime.now()
        let displays = WindowList.displays()
        let screen = Coordinates.union(displays)
        let mouse = WindowList.mouse()
        func result(_ window: WindowInfo?, _ elements: [ScreenElement]) -> LookResult {
            LookResult(window: window, mouseX: mouse.x, mouseY: mouse.y, elements: elements, screenX: screen.x, screenY: screen.y,
                       screenW: screen.w, screenH: screen.h, monitors: displays)
        }

        if scope == "screen" {
            // The windows open, not what is in them. Quartz for the list; no OCR.
            let frontNow = await frontWindow()
            var look = result(frontNow?.window, WindowList.windows())
            look.readMs = Int(Self.ms(since: started))
            // Asked for pixels but there are none to read: say so instead of leaving the agent to wonder.
            if ocr == .always {
                look.ocrFailed = "a look at the screen only lists the open windows; look at a window or at the mouse for its text, or take a screenshot"
            }
            return look
        }
        guard Permissions.accessibility else { throw TextReader.Refused(message: Permissions.accessibilityRefusal) }
        let frontNow = await frontWindow()
        let elements: [ScreenElement]
        let area: Box?
        if scope == "mouse" {
            elements = try await reader.run { [reader] in reader.readAtMouse(x: mouse.x, y: mouse.y) }
            let around = Box(x: mouse.x - 300, y: mouse.y - 120, w: 601, h: 241)
            area = frontNow.flatMap { around.within($0.window.box) } ?? around
        } else {
            guard let pid = frontNow?.pid else { return result(nil, []) }
            let read = try await reader.run { [reader] in reader.readWindow(pid: pid) }
            elements = read.elements
            area = read.window ?? frontNow.map { $0.window.box }
        }
        var look = result(frontNow?.window, elements)
        look.readMs = Int(Self.ms(since: started))

        // Only when asked, or when the window says little: never on a look that already has its controls.
        let named = elements.filter { !AXKinds.containers.contains($0.kind) && !$0.name.isEmpty }.count
        let wanted = ocr == .always || (ocr == .auto && named < Self.sparseBelow)
        if wanted, let box = area, box.w > 8, box.h > 8 {
            // Under its own deadline: a stuck capture leaves the text out, not the look.
            do {
                if let lines = try await within(ms: Self.ocrPatienceMs, { try await TextReader.read(area: box) }) {
                    look.elements += lines
                    look.ocr = true
                } else {
                    look.ocrFailed = "took longer than \(Self.ocrPatienceMs / 1000) s"
                }
            } catch {
                look.ocrFailed = describeError(error)
            }
        }
        look.ocrMs = Int(Self.ms(since: started)) - look.readMs
        return look
    }

    public func state() async throws -> ScreenState {
        guard let frontNow = await frontWindow() else { return ScreenState(window: nil, focus: nil) }
        var focus: ScreenElement?
        if Permissions.accessibility {
            let pid = frontNow.pid
            // A window that will not answer leaves the focus out, not the answer.
            focus = await quick(Self.statePatienceMs, { [reader] in reader.focus(pid: pid) })
        }
        return ScreenState(window: frontNow.window, focus: focus)
    }

    public func refresh(_ e: ScreenElement) async throws -> ScreenElement? {
        guard let element = Self.axElement(e.ref) else { return nil }
        let spot = try await ax(3000, "reading the control again", { AXReader.spot(element) })
        guard spot.full != nil, let shown = spot.visible else { return nil }
        return Geometry.shown(e, shown)
    }

    // MARK: The pointer

    public func point(x: Int, y: Int, text: String?, seconds: Double) async throws {
        await MainActor.run { [weak self] in
            _ = self?.pointerDrawing?.show(x: x, y: y, text: text, seconds: seconds)
        }
    }

    public func hide() async {
        await MainActor.run { [weak self] in self?.pointerDrawing?.hide() }
    }

    public func centre() async -> (x: Int, y: Int) {
        let main = WindowList.displays().first { $0.primary } ?? Display(x: 0, y: 0, w: 1440, h: 900, primary: true)
        return (main.x + main.w / 2, main.y + main.h / 2)
    }

    /**
     * Shows the pointer where it is about to act, and gives it time to get there so the person can follow: its glide
     * and a moment more, or a short moment when it appears on the spot.
     */
    func showAt(_ x: Int, _ y: Int, _ words: String, seconds: Double = 3) async {
        let glides = await MainActor.run { [weak self] () -> Bool in
            self?.pointerDrawing?.show(x: x, y: y, text: words, seconds: seconds) ?? false
        }
        try? await Task.sleep(nanoseconds: UInt64(glides ? Self.glideMs + 30 : 100) * 1_000_000)
    }

    /** The pointer on a window's title bar, after an open, switch or window command, says which window is in front. */
    func showOnWindow(_ w: WindowInfo, _ words: String) async {
        let x = w.x + w.w / 2, y = w.y + min(60, max(w.h / 2, 1))
        await MainActor.run { [weak self] in
            _ = self?.pointerDrawing?.show(x: x, y: y, text: words, seconds: 3)
        }
    }

    func windowMiddle() async -> (x: Int, y: Int) {
        guard let w = await frontWindow()?.window else { return await centre() }
        return (w.x + w.w / 2, w.y + w.h / 2)
    }

    /** A bare x,y must be on a display: macOS would otherwise move it to the nearest edge and click there. */
    static func onADisplay(_ x: Int, _ y: Int) throws {
        guard Coordinates.display(at: x, y, in: WindowList.displays()) != nil else {
            throw DesktopError("\(x),\(y) is not on any display (a look's monitors say where they are)")
        }
    }

    // MARK: The window the agent works in

    func intend(pid: pid_t, title: String, box: Box) {
        lock.withLock { intended = (pid, title, box, Date()) }
    }

    func intendFront() async {
        if let f = await frontWindow() { intend(pid: f.pid, title: f.window.title, box: f.window.box) }
    }

    func forgetIntended(pid: pid_t? = nil) {
        lock.withLock {
            if pid == nil || intended?.pid == pid { intended = nil }
        }
    }

    /**
     * Before typing or keys: makes sure the app the agent is working in is in front (a sheet or dialog of it counts:
     * same app), bringing its window back if something else took the front. Throws, so nothing is typed, when it cannot.
     */
    func ensureFront() async throws {
        guard let want = lock.withLock({ intended }), Date().timeIntervalSince(want.at) <= Self.intendedFor,
              NSRunningApplication(processIdentifier: want.pid) != nil else { return }
        if let f = await frontWindow(), f.pid == want.pid { return }
        let pid = want.pid, box = want.box, title = want.title
        try await ax(3000, "bringing the window forward", {
            Apps.bringForward(pid: pid, window: Apps.axWindow(pid: pid, box: box, title: title))
        })
        let now = await frontWindow()
        if now?.pid != pid {
            let name = title.isEmpty ? (NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the window") : title
            throw DesktopError("\"\(name)\" could not be brought back to the front (\"\(now?.window.title ?? "nothing")\" is there); nothing was typed")
        }
    }

    // MARK: Clicking and dragging

    public func click(target: ScreenElement?, x: Int, y: Int, kind: ClickKind) async throws -> (how: String, x: Int, y: Int) {
        let words = kind == .right ? "Right-click" : kind == .double ? "Double-click" : "Click"
        let element = Self.axElement(target?.ref)
        var x = x, y = y
        // Where the control shows now, not where the look saw it: the page may have scrolled, or it sits half under its top.
        var spot: AXReader.Spot?
        if let element {
            let now = try await ax(3000, "finding the control", { AXReader.spot(element) })
            spot = now
            if let v = now.visible { (x, y) = (v.centre.x, v.centre.y) }
        }
        await showAt(x, y, words)
        do {
            let done = try await clickHere(target: target, element: element, spot: spot, x: x, y: y, kind: kind, words: words)
            try? await Task.sleep(nanoseconds: 150_000_000)
            await intendFront()
            return done
        } catch {
            try? await Task.sleep(nanoseconds: 150_000_000)
            await intendFront()
            throw error
        }
    }

    func clickHere(target: ScreenElement?, element: AXUIElement?, spot: AXReader.Spot?, x: Int, y: Int, kind: ClickKind, words: String)
        async throws -> (how: String, x: Int, y: Int) {
        var x = x, y = y
        var spot = spot
        if let element, let target {
            let role: String = (try? await ax(1000, "reading the control", { (AXReader.attribute(element, kAXRoleAttribute) as String?) ?? "" })) ?? ""
            if kind == .left {
                // A field is given the focus directly, as for typing: the mouse could land on whatever covers it.
                let takesText = target.kind == "edit" || target.kind == "password" || (target.kind == "combobox" && role == "AXComboBox")
                if takesText {
                    let focused = (try? await ax(3000, "focusing the field", { AXActions.focus(element) })) ?? false
                    if focused { return ("focused", x, y) }
                } else {
                    // A control that can be pressed directly is, and the pointer stays where the person left it.
                    do {
                        let pressed = try await ax(3000, "pressing the control", { AXActions.press(element) })
                        if pressed { return ("invoked", x, y) }
                    } catch is Stuck {
                        // A press that opens a dialog may not come back until it closes; it has happened by then.
                        return ("invoked", x, y)
                    }
                }
            } else if kind == .right, spot?.inPage != true {
                // The control's own menu, outside web pages (where AXShowMenu is less sure than a real right click).
                let shown = (try? await ax(3000, "opening its menu", { AXActions.showMenu(element) })) ?? false
                if shown { return ("invoked", x, y) }
            }
        }
        if let element, let s = spot, let full = s.full, !Geometry.enough(full, s.visible) {
            // Too little of it shows to click it surely: scrolled into view and read again, else refused.
            let again = try await ax(3000, "scrolling it into view", { AXActions.scrollIntoView(element) ? AXReader.spot(element) : s })
            spot = again
            guard let againFull = again.full, Geometry.enough(againFull, again.visible), let v = again.visible else {
                let share = Int(Geometry.fraction(again.full ?? full, again.visible) * 100)
                throw DesktopError("only \(share)% of \"\(target?.name ?? "it")\" shows (the rest is past the edge of the page or window) and it could not be scrolled into view; scroll until it shows, look again, then click")
            }
            (x, y) = (v.centre.x, v.centre.y)
            await showAt(x, y, words)
        }
        // The last guard: a click meant for the page never lands on the browser's own bar.
        let frontNow = await inFront()
        if let why = Geometry.chromeRefusal(frontNow, y: y, inPage: spot?.inPage == true, page: spot?.page) { throw DesktopError(why) }
        try Self.onADisplay(x, y)
        let point = CGPoint(x: x, y: y)
        try await input(3000, "clicking", { InputEvents.click(at: point, kind: kind) })
        return ("mouse", x, y)
    }

    public func drag(from: ScreenElement?, x1: Int, y1: Int, to: ScreenElement?, x2: Int, y2: Int, holdMs: Int) async throws -> String {
        try Self.onADisplay(x1, y1)
        try Self.onADisplay(x2, y2)
        await showAt(x1, y1, "Drag")
        let start = CGPoint(x: x1, y: y1), end = CGPoint(x: x2, y: y2)
        let moveMs = Self.dragMoveMs
        // The pointer glides to the drop as the mouse moves there.
        let moving = Task {
            try await self.input(3000 + holdMs + moveMs, "dragging", { InputEvents.drag(from: start, to: end, holdMs: holdMs, moveMs: moveMs) })
        }
        try? await Task.sleep(nanoseconds: UInt64(max(80, holdMs)) * 1_000_000)
        await MainActor.run { [weak self] in
            _ = self?.pointerDrawing?.show(x: x2, y: y2, text: "Drop", seconds: 3)
        }
        var failure: Error?
        do { try await moving.value } catch { failure = error }
        try? await Task.sleep(nanoseconds: 150_000_000)
        await intendFront()
        if let failure { throw failure }
        return "mouse"
    }

    // MARK: Typing, keys, the clipboard

    /**
     * Before typing or pasting: the app the agent works in in front (when no field is named), the named field
     * focused, and never a password field (the one named, or whatever has the focus). Returns where to show the pointer.
     */
    func prepareInput(_ target: ScreenElement?) async throws -> (x: Int, y: Int) {
        if target == nil { try await ensureFront() }
        var at: (x: Int, y: Int)
        if let target { at = Self.middle(target) } else { at = await windowMiddle() }
        if let element = Self.axElement(target?.ref) {
            let secure = try await ax(3000, "finding where to type", { AXReader.isSecure(element) })
            if secure { throw DesktopError("the app never types into a password field") }
            _ = try? await ax(3000, "focusing the field", { AXActions.focus(element) })
        }
        try await refuseSecureFocus()
        if target == nil, let focus = await quick(1500, { [reader] in reader.focusBox() }) {
            at = (focus.x + min(focus.w / 2, 120), focus.y + min(focus.h / 2, 40))
        }
        return at
    }

    /** Refuses when the control with the focus, in any app, is a password field. */
    func refuseSecureFocus() async throws {
        let secure = try await ax(3000, "checking the focus", { [reader] in reader.focusIsSecure() == true })
        if secure { throw DesktopError("the field with the focus is a password field; the app never types there") }
    }

    public func type(target: ScreenElement?, text: String) async throws {
        let at = try await prepareInput(target)
        let shown = text.count > 24 ? String(text.prefix(23)) + "…" : text
        await showAt(at.x, at.y, "Typing \"\(shown)\"", seconds: 3 + Double(text.count) / 60)
        // Checked again right before the keys go: the pointer's moment is long enough for the focus to wander.
        if target == nil { try await ensureFront() }
        try await refuseSecureFocus()
        try await input(30000, "typing", { InputEvents.type(text) })
        await intendFront()
    }

    public func keys(_ combo: KeyCombo) async throws {
        try await ensureFront()
        let at = await windowMiddle()
        await showAt(at.x, at.y, combo.description)
        try await input(3000, "pressing keys", { try InputEvents.press(combo) })
        // Keys may move to another window on purpose (cmd+tab, cmd+n): wherever they land is where the agent is now.
        try? await Task.sleep(nanoseconds: 150_000_000)
        await intendFront()
    }

    public func readClipboard() async throws -> (text: String?, why: String?) {
        await MainActor.run { Pasteboard.read() }
    }

    public func paste(target: ScreenElement?, text: String) async throws {
        let at = try await prepareInput(target)
        await showAt(at.x, at.y, "Pasting \(text.count) characters")
        if target == nil { try await ensureFront() }
        try await refuseSecureFocus()
        // What the person had copied is kept, and put back once the paste has landed.
        let saved = await MainActor.run { () -> [[String: Data]] in
            let kept = Pasteboard.save()
            Pasteboard.put(text)
            return kept
        }
        do {
            try await input(3000, "pasting", { try InputEvents.press(KeyCombo(cmd: true, key: "v")) })
        } catch {
            await MainActor.run { Pasteboard.restore(saved) }
            throw error
        }
        try? await Task.sleep(nanoseconds: 400_000_000)
        await MainActor.run { Pasteboard.restore(saved) }
        await intendFront()
    }

    // MARK: Scrolling

    public func scroll(target: ScreenElement?, go: String, pages: Int) async throws -> String {
        if target == nil { try await ensureFront() }
        var at: (x: Int, y: Int)
        if let target { at = Self.middle(target) } else { at = await windowMiddle() }
        await showAt(at.x, at.y, "Scroll \(go)", seconds: 2)
        // The control itself first (no mouse involved): the scroll area holding the target, when its bar can be set.
        if let element = Self.axElement(target?.ref) {
            let moved = (try? await ax(3000, "scrolling", { AXActions.scrollBar(element, go: go, pages: pages) })) ?? false
            if moved { return "scrolled" }
        }
        // The wheel over it: a page is most of what is scrolled (the window when the target is small).
        let window = await inFront()
        var view = window?.box ?? Box(x: 0, y: 0, w: 800, h: 600)
        if let t = target, t.h >= 200 { view = t.box }
        try Self.onADisplay(at.x, at.y)
        let d = Scrolling.wheel(go: go, pages: pages, width: view.w, height: view.h)
        let point = CGPoint(x: at.x, y: at.y)
        try await input(8000, "scrolling", { InputEvents.wheel(at: point, wheel1: d.wheel1, wheel2: d.wheel2) })
        return "wheel"
    }

    // MARK: Apps and windows

    /** Normal windows on this Space, then titled ones elsewhere (another Space, minimised), front to back. */
    func allWindows() -> [WindowCandidate] {
        WindowPick.listed(onScreen: WindowList.candidates(onScreenOnly: true), all: WindowList.candidates(onScreenOnly: false),
                          displays: WindowList.displays(), ownPid: WindowList.ownPid).map { $0.window }
    }

    public func findWindow(_ query: String) async throws -> WindowInfo? {
        WindowPick.find(query, in: allWindows()).map { info($0) }
    }

    public func open(app: String?, url: String?) async throws -> (opened: String, window: WindowInfo?) {
        let before = Set(WindowList.onScreen().map { $0.number })
        let frontBefore = await frontWindow()
        let name: String
        var started: pid_t?
        if let url {
            try Apps.browse(url)
            name = url
        } else {
            let query = app ?? ""
            let running = NSWorkspace.shared.runningApplications.first(where: {
                $0.activationPolicy == .regular && Fuzzy.score($0.localizedName ?? "", query) >= 85
            })
            if let found = Apps.find(query) {
                let launched = try await Apps.launch(found.url)
                name = found.name
                started = launched.processIdentifier
            } else if let running {
                // Running, but not from an Applications folder (a helper, a copy in Downloads): brought forward.
                let pid = running.processIdentifier
                try await ax(3000, "bringing the app forward", { Apps.bringForward(pid: pid, window: nil) })
                name = running.localizedName ?? query
                started = pid
            } else {
                throw DesktopError("no app in the Applications folders is called \"\(query)\"")
            }
        }
        // Waits for what was opened to show, then makes sure it is in front, so the next step types into it.
        guard let opened = await waitForWindow(before: before, frontBefore: frontBefore, app: url == nil ? name : nil, pid: started) else {
            return (name, nil)
        }
        let frontPid = await frontWindow()?.pid
        if frontPid != opened.pid {
            let pid = opened.pid, box = opened.box, title = opened.title
            _ = try? await ax(3000, "bringing the window forward", {
                Apps.bringForward(pid: pid, window: Apps.axWindow(pid: pid, box: box, title: title))
            })
        }
        let window = await frontWindow()?.window ?? info(opened)
        intend(pid: opened.pid, title: window.title, box: window.box)
        await showOnWindow(window, "Opened \(name.count > 30 ? String(name.prefix(29)) + "…" : name)")
        return (name, window)
    }

    /**
     * The window an open produced: a new window (of the app started, when known), else (apps that reuse theirs, a
     * browser opening a tab) the window in front once it changed, else an open window matching the app's name. Nil
     * if nothing showed. An app whose window was in front already and stays so is taken after `sameAppMs`.
     */
    func waitForWindow(before: Set<Int>, frontBefore: (pid: pid_t, window: WindowInfo)?, app: String?, pid: pid_t?) async -> WindowCandidate? {
        let started = DispatchTime.now()
        while Self.ms(since: started) < UInt64(Self.openPatienceMs) {
            try? await Task.sleep(nanoseconds: 100_000_000)
            let now = WindowList.onScreen()
            if let fresh = now.first(where: { !before.contains($0.number) && (pid == nil || $0.pid == pid) }) { return fresh }
            guard let f = await frontWindow() else { continue }
            guard let shown = now.first(where: { $0.pid == f.pid && $0.box == f.window.box }) ?? now.first(where: { $0.pid == f.pid }) else { continue }
            let changed = f.pid != frontBefore?.pid || f.window.title != frontBefore?.window.title || f.window.box != frontBefore?.window.box
            if changed { return shown }
            if let app, Self.ms(since: started) > UInt64(Self.sameAppMs), max(Fuzzy.score(shown.owner, app), Fuzzy.score(shown.title, app)) > 0 {
                return shown
            }
        }
        guard let app else { return nil }
        return WindowPick.find(app, in: WindowList.onScreen())
    }

    public func switchTo(_ window: String) async throws -> WindowInfo {
        let all = allWindows()
        guard let w = WindowPick.find(window, in: all) else {
            var open: [String] = []
            for c in all where !c.owner.isEmpty && !open.contains(c.owner) { open.append(c.owner) }
            throw DesktopError("no open window matches \"\(window)\" (open: \(open.prefix(8).joined(separator: ", ")))")
        }
        let pid = w.pid, box = w.box, title = w.title
        try await ax(4000, "switching windows", { Apps.bringForward(pid: pid, window: Apps.axWindow(pid: pid, box: box, title: title)) })
        let now = await frontWindow()
        let result: WindowInfo
        if let now, now.pid == pid { result = now.window } else { result = info(w) }
        intend(pid: pid, title: result.title, box: result.box)
        await showOnWindow(result, "Switched to \(result.app)")
        return result
    }

    /** Each display's area without the menu bar and Dock, top-left points, in the order of `WindowList.displays()`. */
    func visibleAreas() async -> [Box] {
        let displays = WindowList.displayIDs()
        let byID: [UInt32: Box] = await MainActor.run { () -> [UInt32: Box] in
            let mainHeight = Double(NSScreen.screens.first?.frame.height ?? 0)
            var areas: [UInt32: Box] = [:]
            for s in NSScreen.screens {
                guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
                let f = s.visibleFrame
                areas[n.uint32Value] = Coordinates.topLeft(x: Double(f.minX), y: Double(f.minY), w: Double(f.width), h: Double(f.height),
                                                           mainHeight: mainHeight)
            }
            return areas
        }
        return displays.map { d in
            byID[d.id] ?? Box(x: d.display.x, y: d.display.y, w: d.display.w, h: d.display.h)
        }
    }

    /** What `window` acted on and how it is now, read back from the window. */
    struct Arranged {
        let title: String
        let box: Box?
        let minimised: Bool
        let fullScreen: Bool
        let leftFullScreen: Bool
    }

    /**
     * Minimize, maximize, restore or move a window: the one named (Spaces included; for restore, minimised windows
     * too, found through each app's AX windows when Quartz has no title for them), else for restore the window this
     * app last minimised, else the window in front. It acts on the app's real top-level window (`Apps.realWindow`),
     * not Chromium's page window, and the answer says what the window says afterwards (`minimized`).
     */
    public func window(op: String, window: String?, display: Int?) async throws -> WindowInfo {
        let w: WindowCandidate
        let lastMinimised = lock.withLock { minimisedLast }
        if let window {
            if let found = WindowPick.find(window, in: allWindows()) {
                w = found
            } else if op == "restore", let m = await quick(4000, { Apps.minimisedWindow(matching: window) }) {
                w = WindowCandidate(pid: m.pid, owner: m.owner, title: m.title, box: Box(x: 0, y: 0, w: 0, h: 0))
            } else {
                throw DesktopError("no open window matches \"\(window)\"")
            }
        } else if op == "restore", let last = lastMinimised, NSRunningApplication(processIdentifier: last.pid) != nil,
                  await quick(2000, { () -> Bool? in Apps.hasMinimised(pid: last.pid, title: last.title) }) == true {
            let owner = NSRunningApplication(processIdentifier: last.pid)?.localizedName ?? ""
            w = WindowCandidate(pid: last.pid, owner: owner, title: last.title, box: Box(x: 0, y: 0, w: 0, h: 0))
        } else {
            guard let f = await frontWindow() else { throw DesktopError("no window is in front") }
            w = WindowCandidate(pid: f.pid, owner: f.window.app, title: f.window.title, box: f.window.box)
        }
        let areas = await visibleAreas()
        var area: Box?
        if op == "move" {
            guard let n = display, n >= 1, n <= areas.count else { throw DesktopError("display must be 1 to \(areas.count)") }
            area = areas[n - 1]
        } else if op == "maximize" {
            // The display holding the window's middle, else the main one.
            let c = w.box.centre
            if let i = Coordinates.display(at: c.x, c.y, in: WindowList.displays()), i < areas.count { area = areas[i] } else { area = areas.first }
        }
        let key = "\(w.pid) \(w.title)"
        let previous = lock.withLock { beforeFill[key] }
        if op == "maximize" { lock.withLock { beforeFill[key] = w.box } }
        let pid = w.pid, title = w.title, fill = area
        let remembered = lock.withLock { fullScreenBefore.had(pid: pid, title: title) }
        let wasFullScreen = op == "restore" && remembered
        // A box of 0x0 is a window known only by its title (minimised, found through Accessibility).
        let box: Box? = w.box.w > 0 && w.box.h > 0 ? w.box : nil
        // Back into full screen takes its animation twice (out of the Dock, into its Space): more time.
        let patience = wasFullScreen ? 12000 : 8000
        let done: Arranged = try await ax(patience, "arranging the window", { () throws -> Arranged in
            guard let real = Apps.realWindow(pid: pid, box: box, title: title, minimised: op == "restore") else {
                throw DesktopError("that window does not answer Accessibility")
            }
            if op != "minimize" { Apps.bringForward(pid: pid, window: real.element) }
            let now = try Apps.arrange(real.element, op: op, displayArea: fill, previous: previous, wasFullScreen: wasFullScreen)
            if now.minimised {
                return Arranged(title: real.title, box: nil, minimised: true, fullScreen: false, leftFullScreen: now.leftFullScreen)
            }
            // The whole window again (toolbar strips included), now that it has moved or come back.
            let whole = Apps.realWindow(pid: pid, box: now.box, title: real.title)?.box ?? now.box
            return Arranged(title: real.title, box: whole, minimised: false, fullScreen: now.fullScreen, leftFullScreen: false)
        })
        if op == "restore" { lock.withLock { beforeFill[key] = nil } }
        let shownTitle = done.title.isEmpty ? title : done.title
        var result = info(pid: pid, title: shownTitle, box: done.box ?? box ?? w.box, owner: w.owner)
        result.minimised = done.minimised
        result.fullScreen = done.fullScreen
        lock.withLock {
            if op == "minimize" && done.leftFullScreen { fullScreenBefore.note(pid: pid, title: shownTitle) }
            else if op == "restore" { fullScreenBefore.forget(pid: pid, title: title) }
            else if op == "move" { fullScreenBefore.forget(pid: pid, title: title, exactly: true) }
        }
        if op == "minimize" {
            lock.withLock { minimisedLast = (pid, shownTitle) }
            forgetIntended(pid: pid)
        } else {
            lock.withLock {
                if let m = minimisedLast, m.pid == pid, m.title == shownTitle || m.title == title { minimisedLast = nil }
            }
            intend(pid: pid, title: shownTitle, box: result.box)
            let label = op == "move" ? "Moved to display \(display ?? 0)" : op.prefix(1).uppercased() + String(op.dropFirst())
            await showOnWindow(result, label)
        }
        return result
    }

    /**
     * The next or previous Space: control+right or control+left, the Mission Control shortcuts ("Move right a
     * space"), which are on by default but can be switched off in System Settings > Keyboard > Keyboard Shortcuts.
     */
    public func desktop(next: Bool) async throws {
        let combo = KeyCombo(ctrl: true, key: next ? "right" : "left")
        try await input(3000, "changing Space", { try InputEvents.press(combo) })
        forgetIntended()
    }

    // MARK: Pictures

    public func screenshot(scope: String, region: ScreenElement?, maxSide: Int) async throws -> Shot {
        // Never a picture of a password being typed: checked first, and refused when it cannot be checked.
        let secure: Bool?
        do {
            secure = try await ax(1500, "checking for a password field", { [reader] in reader.focusIsSecure() })
        } catch {
            throw DesktopError("could not check whether a password field has the focus, so no picture was taken")
        }
        if secure == true { throw DesktopError("a password field has the focus; the app never takes a picture then") }

        let desktopArea = Coordinates.union(WindowList.displays())
        let window = await frontWindow()?.window
        var area: Box
        if let region {
            // The element and a margin around it, so its label and neighbours show.
            let pad = max(24, min(region.w, region.h) / 2)
            area = Box(x: region.x - pad, y: region.y - pad, w: region.w + 2 * pad, h: region.h + 2 * pad)
        } else if let window, scope != "screen" {
            area = window.box
        } else {
            area = desktopArea
        }
        guard let clipped = area.within(desktopArea), clipped.w >= 8, clipped.h >= 8 else {
            throw DesktopError("there is nothing on screen there to take a picture of")
        }
        area = clipped
        if #unavailable(macOS 14.0) {
            // The older capture sees the app's own pointer: it steps out of the picture first.
            await hide()
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        let (image, shown) = try await ScreenCapture.capture(area: area, maxSide: maxSide)
        guard let jpeg = ScreenCapture.jpeg(image) else { throw DesktopError("the picture could not be made into a JPEG") }
        return Shot(jpeg: jpeg, w: image.width, h: image.height, x: shown.x, y: shown.y, areaW: shown.w, areaH: shown.h, window: window)
    }

    static func ms(since t: DispatchTime) -> UInt64 { (DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1_000_000 }
}

import Foundation

/**
 * Turns Axis's `desktop.*` commands into calls on the desktop and answers, as the Windows app's
 * `DesktopCommands.cs` does, so the wire stays the same. Keeps the elements of the last look by id, so an agent
 * can point at "17". Refuses everything while the person has paused the app, or switched looking off.
 * M1: look, find, point, hide, hello and the window list. The input commands answer that they are not here yet.
 */
public final class DesktopCommands: @unchecked Sendable {
    /** Most elements a look sends back; the busiest windows have thousands. */
    public static let maxElements = 250
    static let maxText = 160
    /** Axis waits 15 s for a look; past this the app answers anyway, so the agent hears why instead of a timeout. */
    static let readDeadlineMs = 12000

    let desktop: Desktop
    private let lock = NSLock()
    private var last: [ScreenElement] = []
    private var settings: [String: JSONValue] = [:]
    private var _paused = false

    /** Set by the person in the app. While true, nothing is read and nothing is shown. */
    public var paused: Bool {
        get { lock.withLock { _paused } }
        set { lock.withLock { _paused = newValue } }
    }

    /** Told after each command, for the app's own list of what was done. */
    public var onDid: (@Sendable (String) -> Void)?

    public init(desktop: Desktop) { self.desktop = desktop }

    public func useSettings(_ values: [String: JSONValue]) { lock.withLock { settings = values } }

    /** A setting read leniently: true/false, a number not 0, or "1"/"true"; missing, `fallback`. */
    func toggle(_ key: String, _ fallback: Bool) -> Bool {
        switch lock.withLock({ settings[key] }) {
        case .bool(let b)?: return b
        case .number(let n)?: return n != 0
        case .string(let s)?: return s == "1" || s == "true"
        default: return fallback
        }
    }

    func did(_ text: String) { onDid?(text) }

    public func handle(_ name: String, _ p: JSONValue) async -> CommandAnswer {
        do {
            if let hit = try await blockedFront(name, p) {
                did("Refused \(name.dropFirst("desktop.".count)): the window in front is on the user's block list")
                return .fail("the window in front is blocked by the user (it matches \"\(hit)\"): the app neither reads it nor acts on it. Tell the person; do not try another way")
            }
            if name == "desktop.look" || name == "desktop.find" {
                let ms = Self.readDeadlineMs
                if let answer = try await within(ms: ms, { try await self.run(name, p) }) { return answer }
                let why = "reading the screen took longer than \(ms / 1000) s (the window in front is not answering); try again, or switch to another window"
                did("\(name) failed: \(why)")
                return .fail(why)
            }
            return try await run(name, p)
        } catch {
            // Said in the app as well as to the agent, so the person sees why it failed.
            let why = describeError(error)
            did("\(name) failed: \(why)")
            return .fail(why)
        }
    }

    /** The user's block list, sent by Axis with each command as `blocked` ("bank|keepass"), lower case. */
    static func blocked(_ p: JSONValue) -> [String] {
        (str(p, "blocked") ?? "").lowercased().split(separator: "|")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /** The block list's entry a window's title or app contains, any case, or nil. */
    static func blockedBy(_ blocked: [String], title: String?, app: String?) -> String? {
        let name = "\(title ?? "") \(app ?? "")".lowercased()
        return blocked.first { name.contains($0) }
    }

    /**
     * The block list's entry the window in front matches, when a command would read it or act on it; nil to go on.
     * Open, switch, window and a look at the whole screen are let through: they name or list other windows.
     */
    func blockedFront(_ name: String, _ p: JSONValue) async throws -> String? {
        let blocked = Self.blocked(p)
        if blocked.isEmpty || ["desktop.hello", "desktop.hide", "desktop.open", "desktop.switch", "desktop.window"].contains(name)
            || (name == "desktop.look" && Self.str(p, "scope") == "screen") { return nil }
        guard let front = try? await desktop.state().window else { return nil }
        return Self.blockedBy(blocked, title: front.title, app: front.app)
    }

    /** Commands Axis knows that this app does not do yet (M2). */
    static let later: Set<String> = [
        "desktop.click", "desktop.drag", "desktop.type", "desktop.keys", "desktop.open", "desktop.switch", "desktop.window",
        "desktop.desktop", "desktop.scroll", "desktop.paste", "desktop.steps", "desktop.wait", "desktop.clipboard", "desktop.screenshot",
    ]

    func run(_ name: String, _ p: JSONValue) async throws -> CommandAnswer {
        if name.hasPrefix("desktop."), paused { return .fail("the person at the computer has paused the VorteX Axis desktop app") }
        switch name {
        case "desktop.look":
            guard toggle("allowLook", true) else { return .fail("reading the screen is switched off for this computer") }
            let scope = Self.str(p, "scope") ?? "window"
            guard ["window", "mouse", "screen"].contains(scope) else { return .fail("scope must be window, mouse or screen") }
            let ocr: OcrMode = Self.bool(p, "ocr") ? .always : toggle("autoOcr", true) ? .auto : .never
            let started = DispatchTime.now()
            var look = try await desktop.look(scope: scope, ocr: ocr)
            let blocked = Self.blocked(p)
            if scope == "screen", !blocked.isEmpty {
                look.elements = look.elements.map { e in
                    guard e.kind == "window", Self.blockedBy(blocked, title: e.name, app: nil) != nil else { return e }
                    var hidden = e
                    hidden.name = "blocked by the user"
                    hidden.value = nil
                    hidden.ref = nil
                    return hidden
                }
            }
            let elements = Self.pick(look.elements, mouseX: look.mouseX, mouseY: look.mouseY, max: Self.maxElements)
            lock.withLock { last = elements }
            let pixels = look.ocr ? ", text read from the pixels" : look.ocrFailed.map { ", pixels skipped (\($0))" } ?? ""
            did("Looked at the \(scope): \(elements.count) things\(pixels) in \(AxisLink.ms(since: started)) ms (controls \(look.readMs), pixels \(look.ocrMs))")
            return .done(data: Self.lookData(look, elements))

        case "desktop.find":
            guard toggle("allowLook", true) else { return .fail("reading the screen is switched off for this computer") }
            let query = Self.str(p, "name") ?? ""
            let look = try await freshLook()
            let found = Self.match(look.elements, query, kind: Self.str(p, "kind")).prefix(5)
            did("Looked for \"\(Self.clip(query, 40))\": \(found.count) found")
            var data: [String: JSONValue] = ["matches": .array(found.map { .string(Self.line(look.elements[$0.index], id: $0.index + 1)) })]
            if let w = look.window { data["window"] = .string("\(Self.clip(w.title, 200)) (\(w.app))") }
            return .done(data: .object(data))

        case "desktop.point":
            let (target, fail) = try await self.target(p)
            if let fail { return .fail(fail) }
            var x = 0, y = 0
            var label: String?
            if let t = target {
                x = t.x + t.w / 2
                y = t.y + t.h / 2
                label = t.name
            } else if let px = Self.int(p, "x"), let py = Self.int(p, "y") {
                x = px
                y = py
            } else { return .fail("point needs a name, an id, or x and y") }
            let words = toggle("bubble", true) ? Self.str(p, "text") : nil
            let seconds = min(max(Self.int(p, "seconds") ?? 6, 1), 60)
            try await desktop.point(x: x, y: y, text: words, seconds: Double(seconds))
            did("Pointed at \(label ?? "\(x), \(y)")\(words.map { ": \"\($0)\"" } ?? "")")
            var payload: [String: JSONValue] = ["x": .int(x), "y": .int(y)]
            if let label { payload["name"] = .string(Self.clip(label, 200)) }
            return .done(payload: payload)

        case "desktop.hide":
            await desktop.hide()
            return .done()

        case "desktop.window" where Self.str(p, "do") == "list":
            // The windows open, as a look at the screen sees them (blocked ones named only as blocked).
            guard toggle("allowLook", true) else { return .fail("reading the screen is switched off for this computer") }
            let look = try await desktop.look(scope: "screen", ocr: .never)
            let blocked = Self.blocked(p)
            let windows: [JSONValue] = look.elements.filter { $0.kind == "window" && !$0.name.isEmpty }.map { e in
                .string(Self.blockedBy(blocked, title: e.name, app: nil) != nil ? "blocked by the user" : "\(Self.clip(e.name, 120)) \(e.x),\(e.y) \(e.w)x\(e.h)")
            }
            did("Listed \(windows.count) open windows")
            return .done(data: ["windows": .array(windows)])

        case "desktop.hello":
            // The admin page's "Show the pointer": proof the app is there and drawing.
            let c = await desktop.centre()
            try await desktop.point(x: c.x, y: c.y, text: "Hi, I'm here", seconds: 4)
            did("Showed the pointer for the admin page")
            return .done()

        case let n where Self.later.contains(n):
            return .fail("not implemented on this device yet: the Mac app reads the screen and points (look, find, point, window list); clicking and typing come in a later version")

        default:
            return .fail("not implemented on this device")
        }
    }

    /** The window in front, read afresh, every element kept (not just the 250 a look sends), for finding by name. */
    func freshLook() async throws -> LookResult {
        let look = try await desktop.look(scope: "window", ocr: toggle("autoOcr", true) ? .auto : .never)
        lock.withLock { last = look.elements }
        return look
    }

    /**
     * The element a command means: `id` from the last look or find, or `name` (with `kind`) matched in a fresh look
     * at the window in front. Neither: no element, and no failure. A name that matches nothing, or several equally,
     * is a failure that lists what it found, with ids that hold for the next call.
     */
    func target(_ p: JSONValue) async throws -> (ScreenElement?, String?) {
        if let id = Self.int(p, "id") {
            let e: ScreenElement? = lock.withLock { id >= 1 && id <= last.count ? last[id - 1] : nil }
            return e == nil ? (nil, "no element \(id) in the last look; look again") : (e, nil)
        }
        guard let query = Self.str(p, "name") else { return (nil, nil) }
        let look = try await freshLook()
        let matches = Self.match(look.elements, query, kind: Self.str(p, "kind"))
        guard let top = matches.first else {
            return (nil, "nothing called \"\(query)\" in the window in front (\(look.window?.title ?? "none")); try find, look, or switch first")
        }
        let tied = Array(matches.prefix { $0.score == top.score })
        if tied.count > 1, !Self.nested(look.elements, tied) {
            let which = tied.prefix(5).map { "id \($0.index + 1): \(look.elements[$0.index].kind) \"\(Self.clip(look.elements[$0.index].name, 40))\"" }
                .joined(separator: "; ")
            return (nil, "\"\(query)\" matches \(tied.count) things equally (\(which)); use one of the ids")
        }
        // Several the same, one inside another (a button and its own label): the innermost.
        let chosen = tied.count > 1 ? tied.min { look.elements[$0.index].box.area < look.elements[$1.index].box.area }! : top
        return (look.elements[chosen.index], nil)
    }

    static func nested(_ all: [ScreenElement], _ tied: [(index: Int, score: Int)]) -> Bool {
        let boxes = tied.map { all[$0.index].box }
        guard let inner = boxes.min(by: { $0.area < $1.area }) else { return false }
        return boxes.allSatisfy { inner.inside($0) }
    }

    /**
     * Elements whose name fits `query`, best first: the same name, then starting with it, then holding it at a word,
     * then anywhere, then all its words. Things that can be used and things of the `kind` asked come before the
     * rest; big containers (a window, a pane, a page) after.
     */
    public static func match(_ all: [ScreenElement], _ query: String, kind: String?) -> [(index: Int, score: Int)] {
        let q = Fuzzy.norm(query)
        if q.isEmpty { return [] }
        let words = q.split(separator: " ").map(String.init)
        let k = kind?.lowercased()
        var found: [(index: Int, score: Int)] = []
        for (i, e) in all.enumerated() {
            let n = Fuzzy.norm(e.name)
            if n.isEmpty { continue }
            var score = n == q ? 100
                : n.hasPrefix(q + " ") || (n.hasPrefix(q) && q.count >= 3) ? 85
                : n.contains(" " + q) ? 75
                : q.count >= 3 && n.contains(q) ? 65
                : words.count > 1 && words.allSatisfy({ n.contains($0) }) ? 55
                : 0
            if score == 0 { continue }
            if actionable.contains(e.kind) { score += 8 }
            if let k, e.kind == k { score += 12 }
            if ["window", "pane", "group", "document", "titlebar"].contains(e.kind) { score -= 15 }
            found.append((i, score))
        }
        // Stable: equal scores keep list order, as LINQ's OrderByDescending does.
        return found.enumerated().sorted { ($0.element.score, -$0.offset) > ($1.element.score, -$1.offset) }.map(\.element)
    }

    /**
     * One element as one short line, about half the text of an object with named fields: `id kind x,y wxh name`,
     * then `= value`, `*focus`, `(ocr)` when they apply. "17 button 1510,-100 60x40 Send".
     */
    public static func line(_ e: ScreenElement, id: Int) -> String {
        var line = "\(id) \(e.kind) \(e.x),\(e.y) \(e.w)x\(e.h) \(clip(e.name, maxText))"
        while line.last == " " { line.removeLast() }
        if let v = e.value, !v.isEmpty { line += " = \(clip(v, maxText))" }
        if e.focused { line += " *focus" }
        if e.source != "ui" { line += " (\(e.source))" }
        return line
    }

    static let actionable: Set<String> = [
        "button", "edit", "hyperlink", "menuitem", "checkbox", "radiobutton", "combobox", "tabitem", "listitem",
        "treeitem", "slider", "spinner", "splitbutton", "menubaritem", "dataitem", "password", "document",
    ]

    /**
     * The `max` elements most worth sending, kept in the order the window listed them. The window itself, what has
     * the focus and what holds the mouse always go; then things that can be used, nearest the mouse first; then the
     * rest, nearest the mouse first.
     */
    public static func pick(_ all: [ScreenElement], mouseX: Int, mouseY: Int, max: Int) -> [ScreenElement] {
        if all.count <= max { return all }
        func distance(_ e: ScreenElement) -> Double {
            let dx = Swift.max(Swift.max(e.x - mouseX, 0), mouseX - (e.x + e.w))
            let dy = Swift.max(Swift.max(e.y - mouseY, 0), mouseY - (e.y + e.h))
            return (Double(dx * dx) + Double(dy * dy)).squareRoot()
        }
        func rank(_ e: ScreenElement, _ i: Int) -> Int {
            if i == 0 || e.kind == "window" || e.focused { return 0 }
            if distance(e) == 0 && actionable.contains(e.kind) { return 0 }
            return actionable.contains(e.kind) ? 1 : 2
        }
        return all.enumerated()
            .map { (i: $0.offset, e: $0.element, rank: rank($0.element, $0.offset), far: distance($0.element)) }
            .sorted { ($0.rank, $0.far, $0.i) < ($1.rank, $1.far, $1.i) }
            .prefix(max)
            .sorted { $0.i < $1.i }
            .map(\.e)
    }

    static func lookData(_ look: LookResult, _ elements: [ScreenElement]) -> JSONValue {
        var under: Int?
        // The smallest element holding the mouse is the one it is on.
        var best = Int64.max
        var list: [JSONValue] = []
        for (i, e) in elements.enumerated() {
            if look.mouseX >= e.x, look.mouseX < e.x + e.w, look.mouseY >= e.y, look.mouseY < e.y + e.h, Int64(e.w) * Int64(e.h) < best {
                best = Int64(e.w) * Int64(e.h)
                under = i + 1
            }
            list.append(.string(line(e, id: i + 1)))
        }
        // Boxes as "x,y wxh", the same form as the element lines.
        var data: [String: JSONValue] = [
            "screen": .string("\(look.screenX),\(look.screenY) \(look.screenW)x\(look.screenH)"),
            "mouse": .string("\(look.mouseX),\(look.mouseY)"),
        ]
        if let w = look.window { data["window"] = .string("\(clip(w.title, 200)) (\(w.app)) \(w.x),\(w.y) \(w.w)x\(w.h)") }
        if !look.monitors.isEmpty {
            data["monitors"] = .array(look.monitors.map { .string("\($0.x),\($0.y) \($0.w)x\($0.h)\($0.primary ? " main" : "")") })
        }
        if let under { data["underMouse"] = .int(under) }
        data["elements"] = .array(list)
        if look.elements.count > elements.count { data["more"] = .int(look.elements.count - elements.count) }
        if let failed = look.ocrFailed { data["ocr"] = .string("text from the pixels skipped: \(failed)") }
        else if elements.contains(where: { $0.source == "ocr" }) {
            data["ocr"] = "the window exposes few controls, so its text was read from the pixels: lines marked (ocr), positions approximate; click them by name"
        }
        return .object(data)
    }

    static func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n - 1)) + "…" : s }
    static func str(_ p: JSONValue, _ key: String) -> String? {
        guard let s = p[key]?.stringValue, !s.isEmpty else { return nil }
        return s
    }
    static func bool(_ p: JSONValue, _ key: String) -> Bool { p[key]?.boolValue == true }
    static func int(_ p: JSONValue, _ key: String) -> Int? { p[key]?.intValue }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
}

/**
 * The result of `work`, or nil when it takes longer than `ms`. The work is left to finish on its own: an
 * Accessibility call into a hung app cannot be cancelled, and a task group would wait for it.
 */
public func within<T: Sendable>(ms: Int, _ work: @escaping @Sendable () async throws -> T) async throws -> T? {
    let once = Once()
    return try await withCheckedThrowingContinuation { (c: CheckedContinuation<T?, Error>) in
        Task {
            do {
                let value = try await work()
                if once.claim() { c.resume(returning: value) }
            } catch {
                if once.claim() { c.resume(throwing: error) }
            }
        }
        Task {
            try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            if once.claim() { c.resume(returning: nil) }
        }
    }
}

/** How well a name fits what someone asked for, 0 for not at all. Shared by element, app and window matching. */
public enum Fuzzy {
    public static func norm(_ s: String) -> String {
        let joined = s.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return joined.trimmingCharacters(in: CharacterSet(charactersIn: ".…: "))
    }

    public static func score(_ name: String, _ query: String) -> Int {
        let n = norm(name), q = norm(query)
        if n.isEmpty || q.isEmpty { return 0 }
        if n == q { return 100 }
        if n.hasPrefix(q) { return 85 }
        if n.contains(" " + q) { return 75 }
        if q.count >= 3 && n.contains(q) { return 65 }
        let words = q.split(separator: " ")
        return words.count > 1 && words.allSatisfy({ n.contains($0) }) ? 55 : 0
    }
}

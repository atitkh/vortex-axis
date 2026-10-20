import Foundation

/**
 * Turns Axis's `desktop.*` commands into calls on the desktop and answers, as the Windows app's
 * `DesktopCommands.cs` does, so the wire stays the same. Keeps the elements of the last look by id, so an agent
 * can point at "17". Refuses everything while the person has paused the app, or switched looking off; refuses
 * every input while input is switched off, and checks the block list against the window in front again right
 * before each input and before each step.
 */
public final class DesktopCommands: @unchecked Sendable {
    /** Most elements a look sends back; the busiest windows have thousands. */
    public static let maxElements = 250
    static let maxText = 160
    /** Axis waits 15 s for a look; past this the app answers anyway, so the agent hears why instead of a timeout. */
    static let readDeadlineMs = 12000
    /** Most text one type sends. */
    public static let maxTyped = 500
    /** Most text one paste sends, and most clipboard text read back. */
    public static let maxPasted = 20000, maxClipboard = 4000
    public static let maxSteps = 10
    /** A moment between steps, for the screen to catch up with the last one. */
    static let settleMs = 150
    /** How long the screen gets to catch up before it is read again; an app being started takes longer. */
    static let afterMs = 300, afterOpenMs = 400
    /**
     * Longest side of a picture, by `detail`. A model reads about w*h/750 tokens from one, so normal (1024) on a
     * 16:9 window is about 800; low suits "what is this window showing", high small text (or use an id to crop).
     */
    public static let shotSides = ["low": 640, "normal": 1024, "high": 1568]

    /** Commands that change the screen: their answer says what is in front afterwards, so the agent need not look again. */
    static let changes: Set<String> = [
        "desktop.click", "desktop.drag", "desktop.type", "desktop.keys", "desktop.open", "desktop.switch", "desktop.window", "desktop.desktop",
        "desktop.steps", "desktop.scroll", "desktop.paste",
    ]
    /** What a step in `steps` may be. */
    static let stepActions: Set<String> = ["click", "drag", "type", "keys", "open", "switch", "window", "desktop", "wait", "point", "find", "scroll", "paste"]

    let desktop: Desktop
    private let lock = NSLock()
    private var last: [ScreenElement] = []
    /** A scroll since the last look: the ids still name the same things, but their boxes may have moved. */
    private var scrolled = false
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
            if let hit = await blockedFront(name, p) { return refusedBlocked(name, hit) }
            if name == "desktop.look" || name == "desktop.find" || name == "desktop.screenshot" {
                let ms = Self.readDeadlineMs
                if let answer = try await within(ms: ms, { try await self.run(name, p) }) { return answer }
                let why = "reading the screen took longer than \(ms / 1000) s (the window in front is not answering); try again, or switch to another window"
                did("\(name) failed: \(why)")
                return .fail(why)
            }
            guard Self.changes.contains(name) else { return try await run(name, p) }
            let before = await stateOrNil()
            let answer = try await run(name, p)
            return await withAfter(answer, name, p, before)
        } catch {
            // Said in the app as well as to the agent, so the person sees why it failed.
            let why = describeError(error)
            did("\(name) failed: \(why)")
            return .fail(why)
        }
    }

    func refusedBlocked(_ name: String, _ hit: String) -> CommandAnswer {
        did("Refused \(name.dropFirst("desktop.".count)): the window in front is on the user's block list")
        return .fail("the window in front is blocked by the user (it matches \"\(hit)\"): the app neither reads it nor acts on it. Tell the person; do not try another way")
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
    func blockedFront(_ name: String, _ p: JSONValue) async -> String? {
        if ["desktop.hello", "desktop.hide", "desktop.open", "desktop.switch", "desktop.window"].contains(name)
            || (name == "desktop.look" && Self.str(p, "scope") == "screen") { return nil }
        return await blockedNow(p)
    }

    /** The block list's entry the window in front matches now, whatever the command. Read again right before each input. */
    func blockedNow(_ p: JSONValue) async -> String? {
        let blocked = Self.blocked(p)
        if blocked.isEmpty { return nil }
        guard let front = await desktop.inFront() else { return nil }
        return Self.blockedBy(blocked, title: front.title, app: front.app)
    }

    func stateOrNil() async -> ScreenState? { try? await desktop.state() }

    /**
     * Adds `after` to an action's answer: the window in front (with `new` when it is not the one in front before),
     * what has the focus and its value. A few dozen characters instead of a look.
     */
    func withAfter(_ answer: CommandAnswer, _ name: String, _ p: JSONValue, _ before: ScreenState?) async -> CommandAnswer {
        let opened = name == "desktop.open" || (name == "desktop.steps" && Self.stepsInclude(p, "open"))
        try? await Task.sleep(nanoseconds: UInt64(opened ? Self.afterOpenMs : Self.afterMs) * 1_000_000)
        guard let now = await stateOrNil() else { return answer }
        var after: [String: JSONValue] = [:]
        if let w = now.window {
            after["window"] = .string("\(Self.clip(w.title, 120)) (\(w.app))")
            if let b = before?.window, b.title != w.title || b.app != w.app { after["new"] = true }
        }
        if let f = now.focus {
            var focus = "\(f.kind) \(Self.clip(f.name, 80))"
            while focus.last == " " { focus.removeLast() }
            after["focus"] = .string(focus)
            if let v = f.value, !v.isEmpty { after["value"] = .string(Self.clip(v, 120)) }
        }
        var data = answer.data?.objectValue ?? [:]
        data["after"] = .object(after)
        return CommandAnswer(ok: answer.ok, error: answer.error, payload: answer.payload, data: .object(data))
    }

    static func stepsInclude(_ p: JSONValue, _ action: String) -> Bool {
        (p["data"]?["steps"]?.arrayValue ?? []).contains { str($0, "action") == action }
    }

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
            lock.withLock { last = elements; scrolled = false }
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

        case "desktop.screenshot":
            guard toggle("allowScreenshot", false) else {
                return .fail("screenshots are switched off for this computer (admin page, the computer's settings)")
            }
            let scope = Self.str(p, "scope") ?? "window"
            guard scope == "window" || scope == "screen" else { return .fail("scope must be window or screen") }
            var region: ScreenElement?
            if let id = Self.int(p, "id") {
                let (e, fail) = try await byId(id)
                if let fail { return .fail(fail) }
                region = e
            }
            let detail = Self.str(p, "detail") ?? "normal"
            guard let side = Self.shotSides[detail] else { return .fail("detail must be low, normal or high") }
            let shot = try await desktop.screenshot(scope: scope, region: region, maxSide: side)
            let what = region.map { Self.clip($0.name, 40) } ?? (scope == "screen" ? "the screen" : shot.window.map { Self.clip($0.title, 40) } ?? "the window")
            did("Took a \(shot.w)x\(shot.h) picture of \(what)")
            var data: [String: JSONValue] = [
                "image": ["data": .string(shot.jpeg.base64EncodedString()), "mimeType": "image/jpeg"],
                "picture": .string("\(shot.w)x\(shot.h) of \(shot.x),\(shot.y) \(shot.areaW)x\(shot.areaH)"),
            ]
            if let w = shot.window { data["window"] = .string("\(Self.clip(w.title, 200)) (\(w.app))") }
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

        case "desktop.wait":
            if Self.str(p, "name") != nil || Self.str(p, "window") != nil { return try await waitFor(p) }
            let ms = min(max(Self.int(p, "ms") ?? 500, 50), 3000)
            try await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            return .done()

        case "desktop.clipboard":
            guard toggle("allowLook", true) else { return .fail("reading the screen is switched off for this computer") }
            let (text, why) = try await desktop.readClipboard()
            guard let text else {
                did("Clipboard: \(why ?? "nothing")")
                return .done(data: ["clipboard": .null, "why": .string(why ?? "the clipboard has no text")])
            }
            did("Read the clipboard: \(text.count) characters")
            var data: [String: JSONValue] = ["clipboard": .string(Self.clip(text, Self.maxClipboard))]
            if text.count > Self.maxClipboard { data["more"] = .int(text.count - Self.maxClipboard) }
            return .done(data: .object(data))

        case "desktop.steps":
            return try await steps(p)

        case "desktop.window" where Self.str(p, "do") == "list":
            // The windows open, as a look at the screen sees them (blocked ones named only as blocked).
            guard toggle("allowLook", true) else { return .fail("reading the screen is switched off for this computer") }
            let look = try await desktop.look(scope: "screen", ocr: .never)
            let blocked = Self.blocked(p)
            let windows: [JSONValue] = look.elements.filter { $0.kind == "window" && !$0.name.isEmpty }.map { e -> JSONValue in
                if Self.blockedBy(blocked, title: e.name, app: nil) != nil { return "blocked by the user" }
                let flag = e.value.map { " (\($0))" } ?? ""
                return .string("\(Self.clip(e.name, 120)) \(e.x),\(e.y) \(e.w)x\(e.h)\(flag)")
            }
            did("Listed \(windows.count) open windows")
            return .done(data: ["windows": .array(windows)])

        case "desktop.click", "desktop.drag", "desktop.type", "desktop.keys", "desktop.open", "desktop.switch", "desktop.window",
             "desktop.desktop", "desktop.scroll", "desktop.paste":
            return try await act(name, p)

        case "desktop.hello":
            // The admin page's "Show the pointer": proof the app is there and drawing.
            let c = await desktop.centre()
            try await desktop.point(x: c.x, y: c.y, text: "Hi, I'm here", seconds: 4)
            did("Showed the pointer for the admin page")
            return .done()

        default:
            return .fail("not implemented on this device")
        }
    }

    /** Runs steps in order, stopping at the first that fails. Says how each went. */
    func steps(_ p: JSONValue) async throws -> CommandAnswer {
        guard let list = p["data"]?["steps"]?.arrayValue else { return .fail("steps needs a list of steps") }
        if list.count > Self.maxSteps { return .fail("at most \(Self.maxSteps) steps in one call") }
        let blocked = p["blocked"]
        var report: [JSONValue] = []
        var i = 0
        for raw in list {
            i += 1
            let action = Self.str(raw, "action") ?? ""
            guard Self.stepActions.contains(action) else { return stepsFailed(report, i, action, "\(action) cannot be a step") }
            // Each step carries the block list, so it is checked against the window in front at that step.
            var step = raw.objectValue ?? [:]
            if step["blocked"] == nil, let blocked { step["blocked"] = blocked }
            let params = JSONValue.object(step)
            if i > 1 { try await Task.sleep(nanoseconds: UInt64(Self.settleMs) * 1_000_000) }
            var answer: CommandAnswer
            if let hit = await blockedFront("desktop.\(action)", params) {
                answer = .fail("the window in front is blocked by the user (it matches \"\(hit)\"): the app neither reads it nor acts on it. Tell the person; do not try another way")
            } else {
                do { answer = try await run("desktop.\(action)", params) } catch { answer = .fail(describeError(error)) }
            }
            var line: [String: JSONValue] = ["action": .string(action), "ok": .bool(answer.ok)]
            for (k, v) in answer.payload ?? [:] { line[k] = v }
            if let m = answer.data?["matches"] { line["matches"] = m }
            if !answer.ok { return stepsFailed(report, i, action, answer.error ?? "failed", line) }
            report.append(.object(line))
        }
        did("Ran \(i) steps")
        return .done(data: ["steps": .array(report), "done": .int(i), "of": .int(i)])
    }

    func stepsFailed(_ report: [JSONValue], _ at: Int, _ action: String, _ error: String, _ line: [String: JSONValue]? = nil) -> CommandAnswer {
        var line = line ?? ["action": .string(action), "ok": false]
        line["error"] = .string(error)
        did("Steps stopped at step \(at) (\(action)): \(error)")
        return CommandAnswer(ok: false, error: "step \(at) (\(action)) failed: \(error)", payload: nil,
                             data: ["steps": .array(report + [.object(line)]), "done": .int(at - 1), "failed": .int(at), "error": .string(error)])
    }

    /** The window in front, read afresh, every element kept (not just the 250 a look sends), for finding by name. */
    func freshLook() async throws -> LookResult {
        let look = try await desktop.look(scope: "window", ocr: toggle("autoOcr", true) ? .auto : .never)
        lock.withLock { last = look.elements; scrolled = false }
        return look
    }

    /**
     * The element a command means: `id` from the last look or find, or `name` (with `kind`) matched in a fresh look
     * at the window in front. Neither: no element, and no failure. A name that matches nothing, or several equally,
     * is a failure that lists what it found, with ids that hold for the next call.
     */
    func target(_ p: JSONValue) async throws -> (ScreenElement?, String?) {
        if let id = Self.int(p, "id") { return try await byId(id) }
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

    /**
     * Element `id` of the last look. After a scroll its box is read again where the platform can (it may have moved
     * under the page's top, or off it); text read from the pixels cannot be, and is a failure.
     */
    func byId(_ id: Int) async throws -> (ScreenElement?, String?) {
        let (e, moved): (ScreenElement?, Bool) = lock.withLock { (id >= 1 && id <= last.count ? last[id - 1] : nil, scrolled) }
        guard let e else { return (nil, "no element \(id) in the last look; look again") }
        if !moved { return (e, nil) }
        if e.ref == nil { return (nil, "scrolled since the last look, so element \(id) may have moved; look again") }
        guard let now = try await desktop.refresh(e) else { return (nil, "element \(id) is off the screen since the scroll; look again") }
        return (now, nil)
    }

    static func nested(_ all: [ScreenElement], _ tied: [(index: Int, score: Int)]) -> Bool {
        let boxes = tied.map { all[$0.index].box }
        guard let inner = boxes.min(by: { $0.area < $1.area }) else { return false }
        return boxes.allSatisfy { inner.inside($0) }
    }

    /** Everything that changes the screen: switched off by the person (Axis's allowInput), and held to the app's own limits. */
    func act(_ name: String, _ p: JSONValue) async throws -> CommandAnswer {
        guard toggle("allowInput", true) else { return .fail("clicking and typing are switched off for this computer") }
        switch name {
        case "desktop.click":
            let (target, fail) = try await self.target(p)
            if let fail { return .fail(fail) }
            guard let at = Self.spot(target, p, "x", "y") else { return .fail("click needs a name, an id, or x and y") }
            let button = Self.str(p, "button") ?? "left"
            guard let kind = ClickKind(rawValue: button) else { return .fail("button must be left, right or double, not \(button)") }
            if let hit = await blockedNow(p) { return refusedBlocked(name, hit) }
            // Where it was clicked: where the control shows now, which may not be where the look saw it.
            let done = try await desktop.click(target: target, x: at.x, y: at.y, kind: kind)
            let x = done.x, y = done.y
            let verb = kind == .left ? "Clicked" : kind == .right ? "Right-clicked" : "Double-clicked"
            did("\(verb) \(target.map { Self.clip($0.name, 60) } ?? "\(x), \(y)")")
            var payload: [String: JSONValue] = ["x": .int(x), "y": .int(y), "how": .string(done.how)]
            if let t = target { payload["name"] = .string(Self.clip(t.name, 200)) }
            return .done(payload: payload)

        case "desktop.drag":
            let (from, fail) = try await self.target(p)
            if let fail { return .fail(fail) }
            guard let start = Self.spot(from, p, "x", "y") else { return .fail("drag needs where from: a name, an id, or x and y") }
            let x1 = start.x, y1 = start.y
            // Where to: by id from the last look, by name (read afresh), or a point.
            var toward: [String: JSONValue] = [:]
            if let toId = Self.int(p, "toId") { toward["id"] = .int(toId) } else if let toName = Self.str(p, "toName") { toward["name"] = .string(toName) }
            let (to, toFail) = try await self.target(.object(toward))
            if let toFail { return .fail(toFail) }
            guard let end = Self.spot(to, p, "toX", "toY") else { return .fail("drag needs where to: toName, toId, or toX and toY") }
            let x2 = end.x, y2 = end.y
            let hold = min(max(Self.int(p, "holdMs") ?? 0, 0), 2000)
            if let hit = await blockedNow(p) { return refusedBlocked(name, hit) }
            let how = try await desktop.drag(from: from, x1: x1, y1: y1, to: to, x2: x2, y2: y2, holdMs: hold)
            did("Dragged \(from.map { Self.clip($0.name, 60) } ?? "\(x1), \(y1)") to \(to.map { Self.clip($0.name, 60) } ?? "\(x2), \(y2)")\(hold > 0 ? " after holding \(hold) ms" : "")")
            var payload: [String: JSONValue] = ["x": .int(x1), "y": .int(y1), "toX": .int(x2), "toY": .int(y2), "how": .string(how)]
            if let f = from { payload["name"] = .string(Self.clip(f.name, 200)) }
            if let t = to { payload["toName"] = .string(Self.clip(t.name, 200)) }
            return .done(payload: payload)

        case "desktop.type":
            let text = p["text"]?.stringValue ?? ""
            if text.isEmpty { return .fail("type needs text") }
            if text.count > Self.maxTyped { return .fail("at most \(Self.maxTyped) characters at a time") }
            let (target, fail) = try await self.target(p)
            if let fail { return .fail(fail) }
            if target?.kind == "password" { return .fail("the app never types into a password field") }
            if let hit = await blockedNow(p) { return refusedBlocked(name, hit) }
            try await desktop.type(target: target, text: text)
            did("Typed \(text.count) characters\(target.map { " into \(Self.clip($0.name, 60))" } ?? "")")
            var payload: [String: JSONValue] = ["typed": .int(text.count)]
            if let t = target { payload["into"] = .string(Self.clip(t.name, 200)) }
            return .done(payload: payload)

        case "desktop.keys":
            let combo = try KeyCombo.parse(Self.str(p, "keys") ?? "")
            if let why = combo.blocked() {
                did("Refused to press \(combo) (\(why))")
                return .fail("the app never presses \(combo) (\(why))")
            }
            if let hit = await blockedNow(p) { return refusedBlocked(name, hit) }
            try await desktop.keys(combo)
            did("Pressed \(combo)")
            return .done(payload: ["pressed": .string(combo.description)])

        case "desktop.open":
            let url = Self.str(p, "url")
            if let url, !(url.lowercased().hasPrefix("http://") || url.lowercased().hasPrefix("https://")) {
                return .fail("the app only opens http and https addresses")
            }
            let app = Self.str(p, "app")
            if (url == nil) == (app == nil) { return .fail("open needs app or url") }
            let (opened, window) = try await desktop.open(app: app, url: url)
            did("Opened \(Self.clip(opened, 60))\(window == nil ? " (no window showed yet)" : "")")
            var payload: [String: JSONValue] = ["opened": .string(Self.clip(opened, 200))]
            // No window: the next type or keys would land wherever the focus already is, so the agent is told.
            if window == nil { payload["note"] = "no window showed within 8 s; check before typing" }
            return .done(payload: payload)

        case "desktop.switch":
            guard let to = Self.str(p, "window") else { return .fail("switch needs window") }
            let w = try await desktop.switchTo(to)
            did("Switched to \(Self.clip(w.title.isEmpty ? w.app : w.title, 60))")
            return .done(payload: Self.windowPayload(w))

        case "desktop.window":
            let op = Self.str(p, "do") ?? ""
            guard ["minimize", "maximize", "restore", "move"].contains(op) else { return .fail("window needs do: minimize, maximize, restore or move") }
            let display = Self.int(p, "display")
            if op == "move", (display ?? 0) < 1 { return .fail("move needs display, 1 or more") }
            let w = try await desktop.window(op: op, window: Self.str(p, "window"), display: display)
            did("\(op.prefix(1).uppercased())\(op.dropFirst())\(op == "move" ? " to display \(display ?? 0)" : ""): \(Self.clip(w.title.isEmpty ? w.app : w.title, 60))")
            return .done(payload: Self.windowPayload(w))

        case "desktop.scroll":
            let go = Self.str(p, "go") ?? "down"
            guard ["up", "down", "left", "right", "top", "bottom"].contains(go) else { return .fail("scroll needs go: up, down, left, right, top or bottom") }
            let pages = min(max(Self.int(p, "pages") ?? 1, 1), 10)
            let (target, fail) = try await self.target(p)
            if let fail { return .fail(fail) }
            if let hit = await blockedNow(p) { return refusedBlocked(name, hit) }
            let how = try await desktop.scroll(target: target, go: go, pages: pages)
            lock.withLock { scrolled = true }
            let amount = go == "top" || go == "bottom" ? "" : " \(pages) page\(pages == 1 ? "" : "s")"
            did("Scrolled \(go)\(amount)\(target.map { " in \(Self.clip($0.name, 40))" } ?? "")")
            var payload: [String: JSONValue] = ["scrolled": .string(go), "how": .string(how)]
            if let t = target { payload["in"] = .string(Self.clip(t.name, 200)) }
            return .done(payload: payload)

        case "desktop.paste":
            // Its text comes as the command's data (a direct call) or as the step's own text.
            let text = Self.str(p, "text") ?? p["data"].flatMap { Self.str($0, "text") } ?? ""
            if text.isEmpty { return .fail("paste needs text") }
            if text.count > Self.maxPasted { return .fail("at most \(Self.maxPasted) characters in one paste") }
            let (target, fail) = try await self.target(p)
            if let fail { return .fail(fail) }
            if target?.kind == "password" { return .fail("the app never pastes into a password field") }
            if let hit = await blockedNow(p) { return refusedBlocked(name, hit) }
            try await desktop.paste(target: target, text: text)
            did("Pasted \(text.count) characters\(target.map { " into \(Self.clip($0.name, 60))" } ?? "")")
            var payload: [String: JSONValue] = ["pasted": .int(text.count)]
            if let t = target { payload["into"] = .string(Self.clip(t.name, 200)) }
            return .done(payload: payload)

        default:
            let go = Self.str(p, "go")
            guard go == "next" || go == "previous" else { return .fail("desktop needs go: next or previous") }
            if let hit = await blockedNow(p) { return refusedBlocked(name, hit) }
            try await desktop.desktop(next: go == "next")
            did("Went to the \(go!) Space")
            return .done(payload: ["went": .string(go!)])
        }
    }

    /** The middle of `target`, else the point the params give under `xKey`, `yKey`; nil with neither. */
    static func spot(_ target: ScreenElement?, _ p: JSONValue, _ xKey: String, _ yKey: String) -> (x: Int, y: Int)? {
        if let t = target { return (t.x + t.w / 2, t.y + t.h / 2) }
        guard let x = int(p, xKey), let y = int(p, yKey) else { return nil }
        return (x, y)
    }

    static func windowPayload(_ w: WindowInfo) -> [String: JSONValue] {
        var payload: [String: JSONValue] = ["window": .string("\(clip(w.title, 200)) (\(w.app)) \(w.x),\(w.y) \(w.w)x\(w.h)")]
        // Read back from the window after `window`, so the answer says what happened, not only what was asked.
        if let m = w.minimised { payload["minimized"] = .bool(m) }
        return payload
    }

    /**
     * Waits until an element called `name` is in the window in front, or a window called `window` is open (`gone`:
     * until it is not), looking twice a second, for up to `seconds`. Not finding it in time is a failure that says
     * what is there instead.
     */
    func waitFor(_ p: JSONValue) async throws -> CommandAnswer {
        let name = Self.str(p, "name")
        let window = Self.str(p, "window")
        let gone = Self.int(p, "gone") == 1 || Self.bool(p, "gone")
        let seconds = min(max(Self.int(p, "seconds") ?? 10, 1), 20)
        let started = DispatchTime.now()
        var lastWindow: String?
        while true {
            let there: Bool
            if let name {
                let look = try await freshLook()
                lastWindow = look.window?.title
                there = !Self.match(look.elements, name, kind: Self.str(p, "kind")).isEmpty
            } else {
                there = try await desktop.findWindow(window ?? "") != nil
            }
            let waited = Int(AxisLink.ms(since: started))
            if there != gone {
                let waitedFor = name.map { "\"\(Self.clip($0, 40))\"" } ?? "window \"\(Self.clip(window ?? "", 40))\""
                did("Waited \(waited) ms for \(waitedFor)\(gone ? " to go" : "")")
                return .done(payload: ["waited": .int(waited)])
            }
            if waited >= seconds * 1000 {
                let what = name.map { "\"\($0)\" \(gone ? "is still" : "did not appear") in \(lastWindow ?? "the window in front")" }
                    ?? "window \"\(window ?? "")\" \(gone ? "is still open" : "did not open")"
                return .fail("\(what) after \(seconds) s")
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
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

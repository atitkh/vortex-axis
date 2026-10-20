import AppKit
import ApplicationServices
import AxisDesktopCore

/**
 * Reads the controls of the app in front through Accessibility: breadth first from its focused window, under a time
 * budget and an element cap, every call with a short messaging timeout so a hung app costs a fraction of a second,
 * not six. Electron apps are asked to expose their controls (AXManualAccessibility), and Chromium and Firefox
 * browsers too (AXEnhancedUserInterface): without it Brave gave a look with nothing but the window and the menu
 * bar (0.1.0's live test). A secure text field's value is never read. Positions come from AX as they are: points,
 * top-left of the main display, y down (the wire's space).
 * Every call runs on `queue`, never the main thread: AX calls cross into other processes and can block.
 */
public final class AXReader: @unchecked Sendable {
    /** How long one look may walk the window's tree; what is left unvisited is left out. */
    public static var budget: TimeInterval = 1.0
    /** Longest one AX message may take before it is given up. */
    static let messagingTimeout: Float = 0.25
    /** Most controls taken from one window; the best of them are picked to send (DesktopCommands.pick). */
    static let maxCollected = 1500
    static let maxVisited = 6000
    static let maxChildren = 400
    /** Menu bar titles sent after the window's own controls (Apple, File, Edit...): the first this many. */
    static let maxMenuBar = 14
    /** How long an app gets to build its tree the first time it is asked to (Chromium builds it on request). */
    static let settleMs: UInt32 = 300
    /** Fewer controls than this from a window just switched on, and it is read once more after another settle. */
    static let sparse = 4

    let queue = DispatchQueue(label: "VorteX Axis accessibility", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    /** Apps already asked to expose their tree, by pid: the first look at each waits for it to be built. */
    private var switchedOn = Set<pid_t>()

    public init() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Self.messagingTimeout)
    }

    /** Runs `work` on the accessibility queue. */
    public func run<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { c in
            queue.async { c.resume(with: Result { try work() }) }
        }
    }

    /** The app element for `pid`, with the short timeout. */
    static func app(_ pid: pid_t) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        return app
    }

    /**
     * Asks app `pid` to build its accessibility tree, once per pid: Electron apps (Slack, VS Code, Discord) with
     * AXManualAccessibility, browsers other than Safari (Chrome, Brave, Edge, Arc, Firefox) with
     * AXEnhancedUserInterface as well, which is what a screen reader sets. Returns true the first time, when the
     * caller should give the app a moment before reading. AXEnhancedUserInterface is not set on other apps: some
     * animate their windows differently while it is on.
     */
    func switchOn(_ pid: pid_t, _ app: AXUIElement) -> Bool {
        let first = lock.withLock { switchedOn.insert(pid).inserted }
        // Set every time (cheap): an app that restarted under the same pid, or turned it off again, gets it back.
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        let running = NSRunningApplication(processIdentifier: pid)
        let bundle = running?.bundleIdentifier?.lowercased()
        if Geometry.isBrowser(running?.localizedName) || Geometry.isBrowser(bundle), bundle?.hasPrefix("com.apple.") != true {
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        return first
    }

    // MARK: Reading one element

    static let batch = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue",
                        kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXFocusedAttribute] as CFArray

    struct Facts {
        var role = "", subrole: String?, label = "", box: Box?, focused = false
    }

    /** Role, label, box and focus in one round trip. Never the value: a password field's must not be asked for. */
    static func facts(_ e: AXUIElement) -> Facts? {
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(e, batch, [], &values) == .success, let raw = values as? [AnyObject], raw.count == 9 else { return nil }
        let v = raw.map { item -> AnyObject? in
            if CFGetTypeID(item) == AXValueGetTypeID(), AXValueGetType(item as! AXValue) == .axError { return nil }
            return item
        }
        var f = Facts()
        f.role = v[0] as? String ?? ""
        f.subrole = v[1] as? String
        // A label from the title, else the description, the placeholder, the help: the first that says something.
        for i in 2...5 {
            if let s = (v[i] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                f.label = s.replacingOccurrences(of: "\n", with: " ")
                break
            }
        }
        if let p = v[6], let s = v[7] { f.box = box(position: p, size: s) }
        f.focused = (v[8] as? Bool) ?? false
        return f
    }

    static func box(position: AnyObject, size: AnyObject) -> Box? {
        guard CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, extent = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent),
              point.x.isFinite, point.y.isFinite, extent.width.isFinite, extent.height.isFinite else { return nil }
        return Box(x: Int(point.x.rounded(.down)), y: Int(point.y.rounded(.down)), w: Int(extent.width.rounded()), h: Int(extent.height.rounded()))
    }

    static func attribute<T>(_ e: AXUIElement, _ name: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success, let value else { return nil }
        return value as? T
    }

    static func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success, let value,
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    static func children(_ e: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &value) == .success, let list = value as? [AnyObject] else { return [] }
        return list.prefix(maxChildren).compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    }

    /**
     * The element as Core sees it, its box cut to `areas` (the pages and scroll areas holding it, and its window), or
     * nil when it says nothing or none of it shows. The rules of the Windows reader's `Add`: tiny things out, a
     * container with no name out, a field kept even unnamed; a secure field is `password` and its value is never read.
     */
    static func screenElement(_ e: AXUIElement, _ f: Facts, parentRole: String?, areas: [Box]) -> ScreenElement? {
        guard let full = f.box, full.w >= 2, full.h >= 2 else { return nil }
        guard let shown = Geometry.visible(full, areas) else { return nil }
        let secure = f.subrole == "AXSecureTextField" || f.role == "AXSecureTextField"
        let kind = secure ? "password" : AXKinds.kind(role: f.role, subrole: f.subrole, parentRole: parentRole)
        var name = f.label
        var value: String?
        if !secure, kind != "document", AXKinds.fields.contains(kind) || (name.isEmpty && !AXKinds.containers.contains(kind)) {
            if let s: String = attribute(e, kAXValueAttribute) {
                let clean = String(s.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
                // Static text keeps its words in its value: that is its name. A field's value is its contents.
                if AXKinds.fields.contains(kind) { value = clean.isEmpty ? nil : clean } else { name = clean.replacingOccurrences(of: "\n", with: " ") }
            }
        }
        if name.isEmpty && (value ?? "").isEmpty && !AXKinds.fields.contains(kind) { return nil }
        return ScreenElement(kind: kind, name: name, x: shown.x, y: shown.y, w: shown.w, h: shown.h, value: value, focused: f.focused, ref: e)
    }

    // MARK: Looks

    struct Node {
        let element: AXUIElement
        let parentRole: String?
        let areas: [Box]
    }

    /**
     * The window in front and its controls: the window first, then any open menu (so a context menu's items can be
     * clicked by name right after a right click), then the window's controls in reading order, one per box, then the
     * menu bar's first titles (last, so a busy window's own controls come before them when the 250 are picked).
     * The first look at an app switches its tree on and waits for it (and once more if it is still nearly empty).
     */
    func readWindow(pid: pid_t) -> (elements: [ScreenElement], window: Box?, cut: Bool) {
        let app = Self.app(pid)
        let first = switchOn(pid, app)
        if first { usleep(Self.settleMs * 1000) }
        var read = readWindowOnce(app)
        if first, read.inside < Self.sparse {
            usleep(Self.settleMs * 1000)
            read = readWindowOnce(app)
        }
        return (read.elements, read.window, read.cut)
    }

    func readWindowOnce(_ app: AXUIElement) -> (elements: [ScreenElement], window: Box?, cut: Bool, inside: Int) {
        guard let window = Self.element(app, kAXFocusedWindowAttribute) ?? Self.element(app, kAXMainWindowAttribute)
            ?? (Self.attribute(app, kAXWindowsAttribute) as [AXUIElement]?)?.first else { return ([], nil, false, 0) }
        var deadline = Date().addingTimeInterval(Self.budget)
        var visited = 0
        var cut = false

        func walk(_ roots: [Node], into list: inout [ScreenElement], skipRoot: Bool = false, cap: Int = AXReader.maxCollected) {
            var queue = roots
            var head = 0
            while head < queue.count {
                if visited >= Self.maxVisited || list.count >= cap || Date() >= deadline { cut = cut || list.count < cap; return }
                let node = queue[head]
                head += 1
                visited += 1
                guard let f = Self.facts(node.element) else { continue }
                if !(skipRoot && head == 1), let e = Self.screenElement(node.element, f, parentRole: node.parentRole, areas: node.areas) {
                    list.append(e)
                }
                // A menu bar title holds a whole closed menu: not walked into.
                if f.role == "AXMenuBarItem" { continue }
                var areas = node.areas
                // What is inside a web page or a scroll area shows only within it (macOS has no "offscreen" flag).
                if f.role == "AXWebArea" || f.role == "AXScrollArea", let b = f.box { areas.append(b) }
                for child in Self.children(node.element) { queue.append(Node(element: child, parentRole: f.role, areas: areas)) }
            }
        }

        var top: [ScreenElement] = []
        var windowBox: Box?
        if let f = Self.facts(window), let b = f.box {
            windowBox = b
            top.append(ScreenElement(kind: "window", name: f.label, x: b.x, y: b.y, w: b.w, h: b.h, focused: f.focused, ref: window))
        }
        // (U) Where an open context or pop-up menu sits in the tree differs per app; children of the app element are tried.
        var menus: [ScreenElement] = []
        let openMenus = Self.children(app).filter { (Self.attribute($0, kAXRoleAttribute) as String?) == "AXMenu" }
        walk(openMenus.map { Node(element: $0, parentRole: nil, areas: []) }, into: &menus)
        var inside: [ScreenElement] = []
        walk([Node(element: window, parentRole: nil, areas: windowBox.map { [$0] } ?? [])], into: &inside, skipRoot: true)
        // The menu bar has its own small allowance, after the window: a slow window never leaves it out, nor it the window.
        var bar: [ScreenElement] = []
        if let menuBar = Self.element(app, kAXMenuBarAttribute) {
            deadline = Date().addingTimeInterval(0.15)
            visited = 0
            walk([Node(element: menuBar, parentRole: nil, areas: [])], into: &bar, skipRoot: true, cap: Self.maxMenuBar)
        }
        let all = ReadingOrder.dedupe(top + menus + ReadingOrder.sort(inside) + bar)
        return (all, windowBox, cut, inside.count)
    }

    /** What the mouse is on, what that holds, and what holds it, a few levels up. */
    func readAtMouse(x: Int, y: Int) -> [ScreenElement] {
        let system = AXUIElementCreateSystemWide()
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &hit) == .success, let at = hit else { return [] }
        AXUIElementSetMessagingTimeout(at, Self.messagingTimeout)
        var list: [ScreenElement] = []
        func add(_ e: AXUIElement, parentRole: String? = nil) -> Facts? {
            guard let f = Self.facts(e) else { return nil }
            if let s = Self.screenElement(e, f, parentRole: parentRole, areas: []) { list.append(s) }
            return f
        }
        let f = add(at)
        for child in Self.children(at).prefix(200) { _ = add(child, parentRole: f?.role) }
        var up: AXUIElement? = Self.element(at, kAXParentAttribute)
        for _ in 0..<4 {
            guard let u = up, let uf = add(u), uf.role != "AXApplication" else { break }
            up = Self.element(u, kAXParentAttribute)
        }
        return ReadingOrder.dedupe(list)
    }

    /** The focused control of app `pid`, for the state after an action and the password checks. */
    func focus(pid: pid_t) -> ScreenElement? {
        let app = Self.app(pid)
        guard let e = Self.element(app, kAXFocusedUIElementAttribute), let f = Self.facts(e) else { return nil }
        return Self.screenElement(e, f, parentRole: nil, areas: [])
    }

    /** The box of the control with the keyboard focus, in whichever app: where typing goes, to show the pointer there. */
    func focusBox() -> Box? {
        let system = AXUIElementCreateSystemWide()
        guard let e = Self.element(system, kAXFocusedUIElementAttribute) else { return nil }
        AXUIElementSetMessagingTimeout(e, Self.messagingTimeout)
        guard let f = Self.facts(e), let box = f.box, box.w > 0, box.h > 0 else { return nil }
        return box
    }

    /**
     * Whether the control with the keyboard focus, in whichever app, is a password field (role or subrole
     * AXSecureTextField). Nil when that cannot be told (no focused element answered).
     */
    func focusIsSecure() -> Bool? {
        let system = AXUIElementCreateSystemWide()
        guard let e = Self.element(system, kAXFocusedUIElementAttribute) else { return nil }
        AXUIElementSetMessagingTimeout(e, Self.messagingTimeout)
        return Self.isSecure(e)
    }

    static func isSecure(_ e: AXUIElement) -> Bool {
        let role: String? = attribute(e, kAXRoleAttribute)
        let subrole: String? = attribute(e, kAXSubroleAttribute)
        return role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    /**
     * App `pid`'s focused window as Accessibility gives it (else its main window): the one source of truth for the
     * window in front's box (`WindowPick.front`). Nil when the app has none.
     */
    func focusedWindow(pid: pid_t) -> FocusedWindow? {
        let app = Self.app(pid)
        guard let w = Self.element(app, kAXFocusedWindowAttribute) ?? Self.element(app, kAXMainWindowAttribute),
              let p: AnyObject = Self.attribute(w, kAXPositionAttribute), let s: AnyObject = Self.attribute(w, kAXSizeAttribute),
              let box = Self.box(position: p, size: s) else { return nil }
        let title: String = Self.attribute(w, kAXTitleAttribute) ?? ""
        let minimised: Bool = Self.attribute(w, kAXMinimizedAttribute) ?? false
        return FocusedWindow(title: title, box: box, minimised: minimised)
    }

    /** The pid of the app Accessibility says has the focus: the same as the front app, read from the system instead of AppKit. */
    func focusedPid() -> pid_t? {
        let system = AXUIElementCreateSystemWide()
        guard let app = Self.element(system, kAXFocusedApplicationAttribute) else { return nil }
        var pid: pid_t = 0
        return AXUIElementGetPid(app, &pid) == .success && pid > 0 ? pid : nil
    }

    /** Where a control is now: its whole box, the part that shows, and the web page it is in (the click guard needs that). */
    public struct Spot: Sendable {
        public var full: Box?
        public var visible: Box?
        public var inPage: Bool
        public var page: Box?
    }

    /**
     * Reads `e` again: its box now, cut to every web page and scroll area holding it and to its window, walking up
     * at most 60 parents (the Windows reader's `Where`).
     */
    static func spot(_ e: AXUIElement) -> Spot {
        AXUIElementSetMessagingTimeout(e, messagingTimeout)
        guard let f = facts(e), let full = f.box else { return Spot(full: nil, visible: nil, inPage: false, page: nil) }
        var areas: [Box] = []
        var page: Box?
        var up = element(e, kAXParentAttribute)
        var depth = 0
        while let u = up, depth < 60 {
            depth += 1
            let role: String = attribute(u, kAXRoleAttribute) ?? ""
            if role == "AXApplication" { break }
            if role == "AXWebArea" || role == "AXScrollArea" || role == "AXWindow" {
                if let p: AnyObject = attribute(u, kAXPositionAttribute), let s: AnyObject = attribute(u, kAXSizeAttribute), let b = box(position: p, size: s) {
                    areas.append(b)
                    if role == "AXWebArea", page == nil { page = b }
                }
            }
            if role == "AXWindow" { break }
            up = element(u, kAXParentAttribute)
        }
        let inPage = page != nil || f.role == "AXWebArea"
        return Spot(full: full, visible: Geometry.visible(full, areas), inPage: inPage, page: page)
    }
}

import AppKit
import ApplicationServices
import AxisDesktopCore

/**
 * Reads the controls of the app in front through Accessibility: breadth first from its focused window, under a time
 * budget and an element cap, every call with a short messaging timeout so a hung app costs a fraction of a second,
 * not six. Electron apps are asked to expose their controls (AXManualAccessibility). A secure text field's value is
 * never read. Positions come from AX as they are: points, top-left of the main display, y down (the wire's space).
 * Every call runs on `queue`, never the main thread: AX calls cross into other processes and can block.
 */
public final class AXReader: @unchecked Sendable {
    /** How long one look may walk the tree; what is left unvisited is left out. (U) may need raising for big windows. */
    public static var budget: TimeInterval = 0.45
    /** Longest one AX message may take before it is given up. */
    static let messagingTimeout: Float = 0.25
    /** Most controls taken from one window; the best of them are picked to send (DesktopCommands.pick). */
    static let maxCollected = 1500
    static let maxVisited = 5000
    static let maxChildren = 400

    let queue = DispatchQueue(label: "VorteX Axis accessibility", qos: .userInitiated, attributes: .concurrent)

    public init() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Self.messagingTimeout)
    }

    /** Runs `work` on the accessibility queue. */
    public func run<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { c in
            queue.async { c.resume(with: Result { try work() }) }
        }
    }

    /** The app element for `pid`, with the short timeout and Electron's switch set. */
    static func app(_ pid: pid_t) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, messagingTimeout)
        // Electron apps (Slack, VS Code, Discord...) only build their accessibility tree when asked. Harmless elsewhere.
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        return app
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
        let secure = f.subrole == "AXSecureTextField"
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
     * clicked by name right after a right click), then the window's controls and the menu bar's titles in reading
     * order, one per box. Returns whether the time budget ran out.
     */
    func readWindow(pid: pid_t) -> (elements: [ScreenElement], window: Box?, cut: Bool) {
        let app = Self.app(pid)
        guard let window = Self.element(app, kAXFocusedWindowAttribute)
            ?? (Self.attribute(app, kAXWindowsAttribute) as [AXUIElement]?)?.first else { return ([], nil, false) }
        let deadline = Date().addingTimeInterval(Self.budget)
        var visited = 0
        var cut = false

        func walk(_ roots: [Node], into list: inout [ScreenElement], skipRoot: Bool = false) {
            var queue = roots
            var head = 0
            while head < queue.count {
                if visited >= Self.maxVisited || list.count >= Self.maxCollected || Date() >= deadline { cut = true; return }
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
                if (f.role == "AXWebArea" || f.role == "AXScrollArea"), let b = f.box { areas.append(b) }
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
        if let bar = Self.element(app, kAXMenuBarAttribute) { walk([Node(element: bar, parentRole: nil, areas: [])], into: &inside) }
        return (ReadingOrder.dedupe(top + menus + ReadingOrder.sort(inside)), windowBox, cut)
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

    /** The title of app `pid`'s focused window, when the window list gives none (no Screen Recording access). */
    func windowTitle(pid: pid_t) -> String? {
        let app = Self.app(pid)
        guard let w = Self.element(app, kAXFocusedWindowAttribute) else { return nil }
        return Self.attribute(w, kAXTitleAttribute)
    }
}

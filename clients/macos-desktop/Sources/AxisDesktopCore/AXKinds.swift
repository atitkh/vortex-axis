import Foundation

/**
 * Accessibility roles to the element kinds Axis and Core know (the Windows app's UI Automation names, lower case).
 * Strings only, so it is tested off the Mac. Every kind is one token with no spaces: Axis reads element lines with
 * `^(\d+) \S+ ...`. `document` means a web page only: the clip and the browser-bar guard key on it.
 * A starting table (docs/mac-port.md 3.2); AX trees differ per toolkit, so expect to tune it on a real Mac.
 */
public enum AXKinds {
    static let byRole: [String: String] = [
        "AXWindow": "window", "AXSheet": "window", "AXDrawer": "window",
        "AXButton": "button", "AXMenuButton": "button", "AXDisclosureTriangle": "button",
        "AXPopUpButton": "combobox", "AXComboBox": "combobox",
        "AXTextField": "edit", "AXTextArea": "edit", "AXSearchField": "edit",
        "AXLink": "hyperlink",
        "AXMenuItem": "menuitem", "AXMenuBarItem": "menubaritem", "AXMenu": "menu", "AXMenuBar": "menubar",
        "AXCheckBox": "checkbox", "AXRadioButton": "radiobutton",
        "AXTabGroup": "tab",
        "AXCell": "dataitem",
        "AXSlider": "slider", "AXIncrementor": "spinner", "AXStepper": "spinner",
        "AXWebArea": "document",
        "AXGroup": "group", "AXRadioGroup": "group",
        "AXSplitGroup": "pane", "AXScrollArea": "pane", "AXLayoutArea": "pane", "AXSplitter": "pane",
        "AXToolbar": "toolbar",
        "AXStaticText": "text", "AXHeading": "text",
        "AXImage": "image",
        "AXList": "list", "AXTable": "table", "AXOutline": "tree", "AXBrowser": "tree",
        "AXScrollBar": "scrollbar", "AXProgressIndicator": "progressbar", "AXBusyIndicator": "progressbar",
        "AXValueIndicator": "thumb", "AXColorWell": "button", "AXDateField": "edit",
    ]

    /** Subroles that decide the kind whatever the role. */
    static let bySubrole: [String: String] = [
        "AXSecureTextField": "password",
        "AXSearchField": "edit",
        "AXTabButton": "tabitem",
        "AXSwitch": "checkbox",
        "AXToggle": "checkbox",
        "AXOutlineRow": "treeitem",
        "AXTableRow": "listitem",
    ]

    /**
     * The kind for an element. `parentRole` tells a row in an outline (a tree) from one in a list or table.
     * An unknown role becomes its own name without "AX", lower case, letters and digits only ("AXRuler" → "ruler").
     */
    public static func kind(role: String, subrole: String?, parentRole: String? = nil) -> String {
        if let s = subrole, let k = bySubrole[s] { return k }
        if role == "AXRow" { return parentRole == "AXOutline" || parentRole == "AXBrowser" ? "treeitem" : "listitem" }
        if let k = byRole[role] { return k }
        var bare = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
        bare = String(bare.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII })
        return bare.isEmpty ? "custom" : bare
    }

    /** Kinds that take text: kept even unnamed, and their value is read (never a password's). */
    public static let fields: Set<String> = ["edit", "combobox", "password", "document"]
    /** Containers that say nothing without a name. */
    public static let containers: Set<String> = ["window", "pane", "group"]
}

/** Tidying a collected list of elements: one per box, then in reading order. */
public enum ReadingOrder {
    /** Leaves out an element whose box another already has (a button and its own label), keeping the first. */
    public static func dedupe(_ elements: [ScreenElement]) -> [ScreenElement] {
        var seen = Set<Box>()
        return elements.filter { seen.insert($0.box).inserted }
    }

    /**
     * Top to bottom, then left to right: elements whose tops are within `tolerance` points of a line's first one
     * are on that line. Lines, not a pairwise "close enough" test, so the order is always well defined. Stable for ties.
     */
    public static func sort(_ elements: [ScreenElement], tolerance: Int = 6) -> [ScreenElement] {
        let byTop = elements.enumerated().sorted { ($0.element.y, $0.offset) < ($1.element.y, $1.offset) }
        var lines: [[(offset: Int, element: ScreenElement)]] = []
        for item in byTop {
            if let first = lines.last?.first, item.element.y - first.element.y <= tolerance { lines[lines.count - 1].append(item) }
            else { lines.append([item]) }
        }
        return lines.flatMap { line in line.sorted { ($0.element.x, $0.offset) < ($1.element.x, $1.offset) }.map(\.element) }
    }
}

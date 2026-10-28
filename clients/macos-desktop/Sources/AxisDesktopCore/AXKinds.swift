import Foundation

/**
 * Accessibility roles to the element kinds Axis and Core know (the Windows app's UI Automation names, lower case).
 * Strings only, so it is tested off the Mac. Every kind is one token with no spaces: Axis reads element lines with
 * `^(\d+) \S+ ...`. `document` means a web page only: the clip and the browser-bar guard key on it.
 * A starting table; AX trees differ per toolkit, so expect to tune it on a real Mac.
 */
public enum AXKinds {
    static let byRole: [String: String] = [
        "AXWindow": "window", "AXSheet": "window", "AXDrawer": "window",
        "AXButton": "button", "AXMenuButton": "button", "AXDisclosureTriangle": "button",
        "AXPopUpButton": "combobox", "AXComboBox": "combobox",
        "AXTextField": "edit", "AXTextArea": "edit", "AXSearchField": "edit",
        "AXLink": "hyperlink",
        // A menu bar title is a `menuitem`, as the tool's kind hints and the Windows app say (UIA's MenuItem).
        "AXMenuItem": "menuitem", "AXMenuBarItem": "menuitem", "AXMenu": "menu", "AXMenuBar": "menubar",
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
        // A tab that does not say it is one (no AXTabButton subrole) still is when a tab group holds it.
        if role == "AXRadioButton", parentRole == "AXTabGroup" { return "tabitem" }
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

    /** Kinds a person acts on: they keep their name, and the label inside them goes. */
    static let actionable: Set<String> = ["hyperlink", "button", "menuitem", "tabitem", "checkbox", "radiobutton", "listitem", "treeitem",
                                          "combobox", "dataitem", "edit"]
    /** Kinds that only say what an actionable control around them already says. */
    static let echoes: Set<String> = ["text", "image"]

    /** A name compared: lower case, runs of spaces as one. */
    static func plain(_ s: String) -> String {
        s.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /**
     * Leaves out what only repeats another element (the 0.2.0 live test on a Wikipedia page had `hyperlink Contents`,
     * `text Contents` and `group Contents`, and `hyperlink Wikipedia The Free Encyclopedia` with `image Wikipedia`,
     * spending the 250 on long pages): a `text` or `image` lying inside (or on) an actionable control whose name is
     * the same or holds it, and a `group` whose name is that of an element inside it. The actionable one stays; an
     * element with the focus always stays; OCR lines are never touched. Order is kept.
     */
    public static func dropEchoes(_ elements: [ScreenElement]) -> [ScreenElement] {
        let slack = 2
        let names = elements.map { plain($0.name) }
        var drop = Set<Int>()
        for (i, e) in elements.enumerated() where !e.focused && e.source == "ui" && !names[i].isEmpty {
            if echoes.contains(e.kind) {
                let inner = e.box
                let echoed = elements.indices.contains { j in
                    j != i && actionable.contains(elements[j].kind) && elements[j].source == "ui"
                        && (names[j] == names[i] || names[j].contains(names[i])) && inner.inside(elements[j].box, slack: slack)
                }
                if echoed { drop.insert(i) }
            } else if e.kind == "group" {
                let outer = e.box
                let echoed = elements.indices.contains { j in
                    j != i && elements[j].kind != "group" && elements[j].kind != "window" && elements[j].source == "ui" && names[j] == names[i]
                        && elements[j].box.inside(outer, slack: slack)
                }
                if echoed { drop.insert(i) }
            }
        }
        return elements.indices.filter { !drop.contains($0) }.map { elements[$0] }
    }

    /** Thinner than this either way (what shows of it), an element is a sliver: a line half under a toolbar. */
    public static let minShown = 10
    /** A group narrower than this holds a letter or an icon, never something an agent asks for by name. */
    public static let minGroupWidth = 20

    /** A name with only letters and digits, lower case: how a gloss is compared with the text it repeats. */
    static func bare(_ s: String) -> String {
        String(s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    /**
     * Leaves out what 0.2.1's live test still showed on a long Wikipedia page (about 240 elements), after `dropEchoes`:
     * - **slivers**: any element of which less than 10 pt shows in height or width (the boxes are already cut to
     *   what shows; `text 264,156 153x8` was a line half under the toolbar);
     * - **narrow groups**: a `group` under 20 pt wide;
     * - **glosses**: a `group` whose name is one character, or whose name only repeats the text inside it (its
     *   letters and digits are those of one element inside it, or of all of them in order: a pronunciation or a
     *   word split into spans);
     * - **double lines**: an element with the same kind and name as an earlier one, its box the same or one inside
     *   the other (two `text Contents`); the earlier stays.
     * The element with the focus always stays, and so do windows, fields and OCR lines. Order is kept.
     */
    public static func dropNoise(_ elements: [ScreenElement]) -> [ScreenElement] {
        let slack = 2
        let names = elements.map { plain($0.name) }
        let keep: (ScreenElement) -> Bool = { e in
            e.focused || e.source != "ui" || e.kind == "window" || AXKinds.fields.contains(e.kind)
        }
        var drop = Set<Int>()
        for (i, e) in elements.enumerated() where !keep(e) {
            if e.w < minShown || e.h < minShown { drop.insert(i); continue }
            guard e.kind == "group" else { continue }
            if e.w < minGroupWidth || names[i].count <= 1 { drop.insert(i); continue }
            let inside = elements.indices.filter { j in
                j != i && elements[j].kind != "group" && elements[j].kind != "window" && elements[j].source == "ui"
                    && !names[j].isEmpty && elements[j].box.inside(e.box, slack: slack)
            }
            let mine = bare(e.name)
            guard !inside.isEmpty, !mine.isEmpty else { continue }
            if inside.contains(where: { bare(elements[$0].name) == mine }) || inside.map({ bare(elements[$0].name) }).joined() == mine {
                drop.insert(i)
            }
        }
        // Double lines: compared only among those still kept, so a pair is never both dropped.
        var kept: [Int] = []
        for i in elements.indices where !drop.contains(i) {
            let e = elements[i]
            if !keep(e), !names[i].isEmpty, kept.contains(where: { j in
                let o = elements[j]
                return o.kind == e.kind && names[j] == names[i] && (e.box.inside(o.box, slack: slack) || o.box.inside(e.box, slack: slack))
            }) { continue }
            kept.append(i)
        }
        return kept.map { elements[$0] }
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

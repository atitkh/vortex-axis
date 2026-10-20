import AppKit
import ApplicationServices
import AxisDesktopCore

/**
 * Acting on a control through Accessibility, with no mouse: press it, open its menu, give it the focus, scroll it
 * into view, move a scroll bar. The Windows app's UI Automation patterns (Invoke, Toggle, SelectionItem,
 * ExpandCollapse, ScrollItem, Scroll) map to AXPress, AXPick, AXShowMenu, AXFocused, AXScrollToVisible and a scroll
 * bar's AXValue. Every call blocks and must run on the accessibility queue.
 */
enum AXActions {
    static func actionNames(_ e: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String] else { return [] }
        return list
    }

    /** How an action went: done, refused or not offered, or no answer in time (a press that opened a dialog may not come back until it closes). */
    enum Outcome { case done, no, noAnswer }

    static func perform(_ e: AXUIElement, _ action: String) -> Outcome {
        switch AXUIElementPerformAction(e, action as CFString) {
        case .success: return .done
        case .cannotComplete: return .noAnswer
        default: return .no
        }
    }

    /**
     * A left click without the mouse: AXPress when the control offers it, AXPick for menu items. A press with no
     * answer counts as done, as on Windows (it has happened by the time a dialog it opened closes).
     */
    static func press(_ e: AXUIElement) -> Bool {
        let offered = actionNames(e)
        for action in [kAXPressAction, kAXPickAction] where offered.contains(action) {
            switch perform(e, action) {
            case .done, .noAnswer: return true
            case .no: continue
            }
        }
        return false
    }

    /** A right click without the mouse: the control's own menu (AXShowMenu), when it offers one. */
    static func showMenu(_ e: AXUIElement) -> Bool {
        guard actionNames(e).contains(kAXShowMenuAction) else { return false }
        return perform(e, kAXShowMenuAction) != .no
    }

    /** Gives a field the focus. True only when it says it has it afterwards. */
    static func focus(_ e: AXUIElement) -> Bool {
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(e, kAXFocusedAttribute as CFString, &settable) == .success, settable.boolValue else { return false }
        guard AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { return false }
        usleep(60_000)
        return (AXReader.attribute(e, kAXFocusedAttribute) as Bool?) == true
    }

    /** Asks the control's scroll area to bring it into view, and gives it a moment. False when it offers no way to. */
    static func scrollIntoView(_ e: AXUIElement) -> Bool {
        guard actionNames(e).contains("AXScrollToVisible") else { return false }
        guard perform(e, "AXScrollToVisible") != .no else { return false }
        usleep(200_000)
        return true
    }

    /**
     * Scrolls the scroll area holding `start` (it, or up to five parents) by moving its scroll bar: top and bottom
     * exactly, pages by the share of the content one view is (`Scrolling.barValue`). False when there is no scroll
     * area, no bar that way, or the bar cannot be set (web pages often): the caller turns the wheel instead.
     */
    static func scrollBar(_ start: AXUIElement, go: String, pages: Int) -> Bool {
        var e: AXUIElement? = start
        for _ in 0..<6 {
            guard let current = e else { return false }
            let role: String = AXReader.attribute(current, kAXRoleAttribute) ?? ""
            if role == "AXApplication" || role == "AXWindow" { return false }
            if role == "AXScrollArea" { return moveBar(current, go: go, pages: pages) }
            e = AXReader.element(current, kAXParentAttribute)
        }
        return false
    }

    static func moveBar(_ area: AXUIElement, go: String, pages: Int) -> Bool {
        let sideways = go == "left" || go == "right"
        guard let bar = AXReader.element(area, sideways ? kAXHorizontalScrollBarAttribute : kAXVerticalScrollBarAttribute) else { return false }
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(bar, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue else { return false }
        let current = (AXReader.attribute(bar, kAXValueAttribute) as NSNumber?)?.doubleValue ?? 0
        // How much shows of how much there is: the scroll area's box and its content's.
        guard let p: AnyObject = AXReader.attribute(area, kAXPositionAttribute), let s: AnyObject = AXReader.attribute(area, kAXSizeAttribute),
              let view = AXReader.box(position: p, size: s) else { return false }
        let contents: [AXUIElement] = AXReader.attribute(area, kAXContentsAttribute) ?? []
        var content = sideways ? view.w : view.h
        if let first = contents.first, let cp: AnyObject = AXReader.attribute(first, kAXPositionAttribute),
           let cs: AnyObject = AXReader.attribute(first, kAXSizeAttribute), let box = AXReader.box(position: cp, size: cs) {
            content = sideways ? box.w : box.h
        }
        guard let value = Scrolling.barValue(current: current, go: go, pages: pages, visible: Double(sideways ? view.w : view.h), content: Double(content)) else {
            return false
        }
        guard AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: value)) == .success else { return false }
        usleep(100_000)
        return true
    }
}

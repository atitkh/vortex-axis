import AppKit
import AxisDesktopCore

/**
 * The clipboard (`NSPasteboard.general`): read as text with the reasons it is not, and borrowed for a paste with
 * every item and every type put back after. Call on the main thread (`MainActor.run`). What password managers copy
 * carries the cross-app marker `org.nspasteboard.ConcealedType` (nspasteboard.org): it is never read. The app's own
 * pasted text carries `org.nspasteboard.TransientType`, so clipboard managers do not keep it.
 */
enum Pasteboard {
    static let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    /** The text on the clipboard, or nil and why not. */
    static func read() -> (text: String?, why: String?) {
        let board = NSPasteboard.general
        let types = board.types ?? []
        if types.isEmpty { return (nil, "the clipboard is empty") }
        if types.contains(concealed) { return (nil, "what is on the clipboard is marked private (a password manager put it there); not read") }
        if let text = board.string(forType: .string), !text.isEmpty { return (text, nil) }
        if types.contains(.fileURL) { return (nil, "the clipboard holds files, not text") }
        if types.contains(.tiff) || types.contains(.png) { return (nil, "the clipboard holds a picture, not text") }
        return (nil, "the clipboard has no text")
    }

    /** Every item on the clipboard, every type of each, by the type's name: what a paste puts back. */
    static func save() -> [[String: Data]] {
        (NSPasteboard.general.pasteboardItems ?? []).map { item in
            var kept: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { kept[type.rawValue] = data }
            }
            return kept
        }
    }

    static func restore(_ items: [[String: Data]]) {
        let board = NSPasteboard.general
        board.clearContents()
        let objects: [NSPasteboardItem] = items.filter { !$0.isEmpty }.map { kept in
            let item = NSPasteboardItem()
            for (type, data) in kept { item.setData(data, forType: NSPasteboard.PasteboardType(type)) }
            return item
        }
        if !objects.isEmpty { board.writeObjects(objects) }
    }

    /** Puts `text` on the clipboard, marked as passing through. */
    static func put(_ text: String) {
        let board = NSPasteboard.general
        board.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setData(Data(), forType: transient)
        board.writeObjects([item])
    }
}

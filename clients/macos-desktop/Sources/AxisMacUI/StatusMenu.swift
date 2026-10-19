import AppKit

/** The menu bar item: the link's state, open the window, pause, show the pointer, quit. Refreshed as it opens. */
@MainActor
public final class StatusMenu: NSObject, NSMenuDelegate {
    let model: AppModel
    let settings: SettingsWindow
    private let item: NSStatusItem
    private let menu: NSMenu

    public init(model: AppModel, settings: SettingsWindow) {
        self.model = model
        self.settings = settings
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu = NSMenu()
        super.init()
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "VorteX Axis")
            button.image?.isTemplate = true
        }
        menu.delegate = self
        item.menu = menu
    }

    public func menuWillOpen(_ menu: NSMenu) {
        menu.removeAllItems()
        let state = NSMenuItem(title: model.stateLine, action: nil, keyEquivalent: "")
        state.isEnabled = false
        menu.addItem(state)
        menu.addItem(.separator())
        menu.addItem(entry("Open VorteX Axis…", #selector(open)))
        let pause = entry(model.paused ? "Resume" : "Pause", #selector(togglePause))
        menu.addItem(pause)
        menu.addItem(entry("Show the pointer", #selector(showPointer)))
        menu.addItem(.separator())
        menu.addItem(entry("Quit VorteX Axis", #selector(quit), key: "q"))
    }

    func entry(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc func open() { settings.show() }
    @objc func togglePause() { model.setPaused(!model.paused) }
    @objc func showPointer() { model.showPointer() }
    @objc func quit() { NSApp.terminate(nil) }
}

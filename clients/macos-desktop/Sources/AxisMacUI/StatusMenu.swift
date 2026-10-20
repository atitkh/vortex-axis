import AppKit
import Combine
import AxisDesktopCore

/**
 * The menu bar item: the link's state, open the window, pause, show the pointer, quit. Refreshed as it opens. Its icon
 * (`MenuBarIcon`, drawn in code) follows the app's state: idle, listening, speaking, using this Mac, paused, offline.
 */
@MainActor
public final class StatusMenu: NSObject, NSMenuDelegate {
    let model: AppModel
    let settings: SettingsWindow
    private let item: NSStatusItem
    private let menu: NSMenu
    private var watching: AnyCancellable?
    private var shown: MenuIconState?

    public init(model: AppModel, settings: SettingsWindow) {
        self.model = model
        self.settings = settings
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu = NSMenu()
        super.init()
        refreshIcon()
        // objectWillChange comes before the change: the icon is read on the next turn.
        watching = model.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in self?.refreshIcon() }
        }
        menu.delegate = self
        // Items say for themselves whether they can be used (Talk now only while online).
        menu.autoenablesItems = false
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
        let voice = entry("Talk from this Mac", #selector(toggleVoice))
        voice.state = model.saved.voice ? .on : .off
        menu.addItem(voice)
        if model.saved.voice {
            let talk = entry("Talk now (\(model.talkKey.label))", #selector(talkNow))
            talk.isEnabled = model.state == .online && !model.paused
            menu.addItem(talk)
        }
        let keepFace = entry("Keep the face on screen", #selector(toggleKeepFace))
        keepFace.state = model.saved.keepFace && model.saved.showFace ? .on : .off
        keepFace.isEnabled = model.saved.showFace
        menu.addItem(keepFace)
        menu.addItem(.separator())
        menu.addItem(entry("Quit VorteX Axis", #selector(quit), key: "q"))
    }

    func refreshIcon() {
        let state = model.iconState
        guard state != shown, let button = item.button else { return }
        shown = state
        button.image = MenuBarIcon.image(state)
        button.toolTip = state.words
    }

    func entry(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    @objc func open() { settings.show() }
    @objc func togglePause() { model.setPaused(!model.paused) }
    @objc func showPointer() { model.showPointer() }
    @objc func toggleVoice() { Task { await model.setVoice(!model.saved.voice) } }
    @objc func talkNow() { model.talkNow() }
    @objc func toggleKeepFace() { model.setKeepFace(!model.saved.keepFace) }
    @objc func quit() { NSApp.terminate(nil) }
}

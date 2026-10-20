import AppKit
import AxisMacUI

/** The app's own version: what Axis sees in hello. Bump it with every build meant to go out, and scripts/build-mac.sh's. */
let appVersion = "0.3.0"

/** A menu bar app (LSUIElement in Info.plist, and accessory here for `swift run`): no Dock icon, no main window. */
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel(version: appVersion)
    lazy var settings = SettingsWindow(model: model)
    var menu: StatusMenu?

    func applicationDidFinishLaunching(_ notification: Notification) {
        menu = StatusMenu(model: model, settings: settings)
        model.start()
        // First run, or a pairing that is gone: the window says what to do.
        if !model.paired { settings.show() }
    }
}

@main
enum Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

import AppKit
import SwiftUI
import AxisDesktopCore
import AxisMacPlatform

/** The app's window: the link's state, pairing, the permissions macOS must give, and what was done recently. */
@MainActor
public struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var address = ""
    @State private var code = ""
    @State private var name = Host.current().localizedName ?? ""
    @State private var message: String?
    @State private var pairing = false

    public init(model: AppModel) { self.model = model }

    public var body: some View {
        Form {
            Section("VorteX Axis") {
                LabeledContent("State", value: model.stateLine)
                if let a = model.saved.address, model.paired { LabeledContent("Axis", value: "\(a) as \(model.saved.name ?? "")") }
                Toggle("Pause (agents can neither read nor point)", isOn: Binding(get: { model.paused }, set: { model.setPaused($0) }))
                LabeledContent("Version", value: model.version)
            }
            Section("Pair with Axis") {
                TextField("Address or setup string (axis://host:port/code)", text: $address)
                TextField("Pairing code (Add a device on the admin page)", text: $code)
                TextField("Name for this Mac", text: $name)
                HStack {
                    Button(pairing ? "Pairing…" : "Pair") { pair() }.disabled(pairing || address.isEmpty)
                    if model.paired { Button("Forget this pairing") { Task { await model.forget() } } }
                }
                if let message { Text(message).font(.callout).foregroundStyle(.secondary) }
            }
            Section("macOS permissions") {
                permission("Accessibility (read and, later, use other apps)", granted: model.accessibility,
                           ask: Permissions.askAccessibility, open: Permissions.openAccessibilitySettings)
                permission("Screen Recording (text from the pixels, window titles)", granted: model.screenRecording,
                           ask: Permissions.askScreenRecording, open: Permissions.openScreenRecordingSettings)
                Button("Check again") { model.refreshPermissions() }
            }
            Section("Recently") {
                if model.recently.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) }
                ForEach(Array(model.recently.prefix(12).enumerated()), id: \.offset) { _, line in
                    Text(line).font(.system(.caption, design: .monospaced)).lineLimit(2)
                }
            }
        }
        .formStyle(.grouped)
        .frame(minWidth: 460, minHeight: 520)
        .onAppear { model.refreshPermissions() }
    }

    func permission(_ label: String, granted: Bool, ask: @escaping () -> Void, open: @escaping () -> Void) -> some View {
        HStack {
            Image(systemName: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(granted ? Color.green : Color.orange)
            Text(label)
            Spacer()
            if !granted {
                Button("Ask") { ask(); model.refreshPermissions() }
                Button("Open Settings") { open() }
            }
        }
    }

    func pair() {
        pairing = true
        message = nil
        Task { @MainActor in
            do {
                try await model.pair(address: address, code: code, name: name)
                message = "Paired. The Mac shows on the admin page as \(model.saved.name ?? name)."
                code = ""
            } catch {
                message = (error as? LocalizedError)?.errorDescription ?? describeError(error)
            }
            pairing = false
        }
    }
}

/** Opens the settings window, one at a time. An agent app (no Dock icon) has to bring itself forward. */
@MainActor
public final class SettingsWindow {
    private var window: NSWindow?
    let model: AppModel

    public init(model: AppModel) { self.model = model }

    public func show() {
        if window == nil {
            let w = NSWindow(contentViewController: NSHostingController(rootView: SettingsView(model: model)))
            w.title = "VorteX Axis"
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

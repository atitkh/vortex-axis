import AppKit
import SwiftUI
import AxisDesktopCore
import AxisMacPlatform

/** The app's window: the link's state, pairing, talking, the face and notices, the permissions macOS must give, what was done recently, and About. */
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
                Toggle("Pause (agents can neither read, point nor act)", isOn: Binding(get: { model.paused }, set: { model.setPaused($0) }))
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
            VoiceSettings(model: model)
            FaceSettings(model: model)
            Section("macOS permissions") {
                permission("Accessibility (read other apps, press their controls)", granted: model.accessibility,
                           ask: Permissions.askAccessibility, open: Permissions.openAccessibilitySettings)
                permission("Mouse and keyboard (clicks, typing, keys; granted with Accessibility)", granted: model.postEvents,
                           ask: Permissions.askPostEvents, open: Permissions.openAccessibilitySettings)
                permission("Screen Recording (screenshots, text from the pixels, window titles)", granted: model.screenRecording,
                           ask: Permissions.askScreenRecording, open: Permissions.openScreenRecordingSettings)
                permission("Microphone (talking from this Mac)", granted: model.microphone,
                           ask: { let m = model; Permissions.askMicrophone { _ in Task { @MainActor in m.refreshPermissions() } } },
                           open: Permissions.openMicrophoneSettings)
                Text("The talk and typing keys need no permission: they are hot keys, not a key monitor (no Input Monitoring). The typing field takes your keys only while it is open.")
                    .font(.callout).foregroundStyle(.secondary)
                Button("Check again") { model.refreshPermissions() }
            }
            Section("Recently") {
                if model.recently.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) }
                ForEach(Array(model.recently.prefix(12).enumerated()), id: \.offset) { _, line in
                    Text(line).font(.system(.caption, design: .monospaced)).lineLimit(2)
                }
            }
            AboutSection(version: model.version)
        }
        .formStyle(.grouped)
        .frame(minWidth: 480, minHeight: 560)
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

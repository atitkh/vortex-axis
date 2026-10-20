import AppKit
import SwiftUI
import AxisDesktopCore
import AxisMacPlatform

/** The window's "Face and notices" section: the face's switches, size and place, and the "using this computer" pill. */
@MainActor
struct FaceSettings: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Section("Face and notices") {
            Toggle("Show the face (for voice turns, and while an agent uses this Mac)",
                   isOn: Binding(get: { model.saved.showFace }, set: { model.setShowFace($0) }))
            if model.saved.showFace {
                Toggle("Keep it on screen (click it to talk)", isOn: Binding(get: { model.saved.keepFace }, set: { model.setKeepFace($0) }))
                Picker("Size", selection: Binding(get: { model.saved.faceSize }, set: { model.setFaceSize($0) })) {
                    ForEach(FaceLayout.sizes.map { $0.id }, id: \.self) { id in
                        Text(FaceLayout.sizes.first { $0.id == id }?.label ?? id).tag(id)
                    }
                }
                Picker("Place", selection: Binding(get: { model.saved.facePlace }, set: { model.setFacePlace($0) })) {
                    // "Where you put it" only once it has been put somewhere.
                    ForEach(FaceLayout.places.map { $0.id }.filter { $0 != FaceLayout.custom || model.saved.faceX != nil }, id: \.self) { id in
                        Text(FaceLayout.places.first { $0.id == id }?.label ?? id).tag(id)
                    }
                }
                if model.saved.keepFace {
                    Text("Drag it with the right mouse button, or with Control held, to put it anywhere.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            Toggle("Show \"\(ControlPillWords.title)\" at the top of the screen while an agent acts here",
                   isOn: Binding(get: { model.saved.showControl }, set: { model.setShowControl($0) }))
            HStack {
                Button("Try them") { model.tryFaceAndPills() }
                Text("Shows the pill and the face with the computer icon for a few seconds.").font(.callout).foregroundStyle(.secondary)
            }
        }
    }
}

/** The window's "About" section: the logo, the name and the version. */
@MainActor
struct AboutSection: View {
    let version: String

    var body: some View {
        Section("About") {
            HStack(alignment: .center, spacing: 14) {
                Image(nsImage: NSApp.applicationIconImage ?? NSImage())
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 56, height: 56)
                VStack(alignment: .leading, spacing: 3) {
                    Text("VorteX Axis for Mac").font(.headline)
                    Text("Version \(version) (experimental)").font(.callout).foregroundStyle(.secondary)
                    Text("Lets your VorteX agents read, point at and use this Mac, and talk with you from it.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }
}

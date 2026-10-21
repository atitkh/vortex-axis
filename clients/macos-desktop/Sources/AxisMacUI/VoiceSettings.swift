import AppKit
import Carbon.HIToolbox
import SwiftUI
import AxisDesktopCore
import AxisMacPlatform

/** The window's "Talking from this Mac" section: the switch, the talk key, the microphone and the speaker. */
@MainActor
struct VoiceSettings: View {
    @ObservedObject var model: AppModel
    @State private var inputs: [AudioDevice] = []
    @State private var outputs: [AudioDevice] = []
    @State private var keyMessage: String?
    @State private var typingMessage: String?

    var body: some View {
        Section("Talking from this Mac") {
            Toggle("Talk from this Mac", isOn: Binding(get: { model.saved.voice }, set: { on in Task { await model.setVoice(on) } }))
            Text("The Mac becomes a voice device like a board: a microphone, its speakers, and Axis's questions shown at the top of the screen.")
                .font(.callout).foregroundStyle(.secondary)
            if model.saved.voice {
                LabeledContent("Talk key") {
                    HStack {
                        Picker("Talk key", selection: Binding(get: { model.talkKey.description }, set: { pick($0) })) {
                            ForEach(keyChoices, id: \.description) { Text($0.label).tag($0.description) }
                        }
                        .labelsHidden()
                        .frame(maxWidth: 170)
                        TalkKeyRecorder { key in keyMessage = model.setTalkKey(key) }
                    }
                }
                if let trouble = keyMessage ?? model.talkKeyTrouble {
                    Text(trouble).font(.callout).foregroundStyle(.orange)
                }
                Text(model.talkKey.isFn
                     ? "Hold Fn (Globe) to talk, tap it to type. Set System Settings > Keyboard > \"Press 🌐 key to\" to Do Nothing, or macOS acts on it too."
                     : "Hold it and talk: it listens until you let go. Tap it: a field opens at the top of the screen to type to the agent. Press it while the agent speaks: it stops.")
                    .font(.callout).foregroundStyle(.secondary)
                LabeledContent("Typing key") {
                    HStack {
                        Picker("Typing key", selection: Binding(get: { model.typingKey?.description ?? "" }, set: { pickTyping($0) })) {
                            Text("None: tap the talk key").tag("")
                            ForEach(typingChoices, id: \.description) { Text($0.label).tag($0.description) }
                        }
                        .labelsHidden()
                        .frame(maxWidth: 170)
                        TalkKeyRecorder { key in typingMessage = model.setTypingKey(key) }
                    }
                }
                if let trouble = typingMessage ?? model.typingKeyTrouble {
                    Text(trouble).font(.callout).foregroundStyle(.orange)
                }
                Text(model.typingKey == nil
                     ? "Typing: Return sends, Shift+Return starts a new line, Esc closes, ↑ brings back the last message. The answer is spoken and shown as for talking."
                     : "With a typing key of its own, a tap of the talk key listens until you pause, as before.")
                    .font(.callout).foregroundStyle(.secondary)
                Picker("Microphone", selection: Binding(get: { model.saved.micDevice },
                                                        set: { model.setDevices(mic: $0, speaker: model.saved.speakerDevice) })) {
                    Text("System default").tag("")
                    ForEach(listed(inputs, model.saved.micDevice)) { Text($0.name).tag($0.uid) }
                }
                Picker("Speaker", selection: Binding(get: { model.saved.speakerDevice },
                                                     set: { model.setDevices(mic: model.saved.micDevice, speaker: $0) })) {
                    Text("System default").tag("")
                    ForEach(listed(outputs, model.saved.speakerDevice)) { Text($0.name).tag($0.uid) }
                }
            }
        }
        .onAppear(perform: reload)
    }

    /** The presets, and the saved key when it is one recorded. */
    var keyChoices: [TalkKey] {
        let now = model.talkKey
        return TalkKey.presets.contains(now) ? TalkKey.presets : TalkKey.presets + [now]
    }

    func pick(_ id: String) {
        guard let key = TalkKey.parse(id) else { return }
        keyMessage = model.setTalkKey(key)
    }

    /** The presets that can be the typing key (not the talk key, not Fn), and a recorded one. */
    var typingChoices: [TalkKey] {
        let presets = TalkKey.presets.filter { !$0.isFn && $0 != model.talkKey }
        guard let now = model.typingKey, !presets.contains(now) else { return presets }
        return presets + [now]
    }

    func pickTyping(_ id: String) {
        typingMessage = model.setTypingKey(id.isEmpty ? nil : TalkKey.parse(id))
    }

    /** The devices there are, and the chosen one marked when it is not connected (it is used again once it is). */
    func listed(_ devices: [AudioDevice], _ chosen: String) -> [AudioDevice] {
        guard !chosen.isEmpty, !devices.contains(where: { $0.uid == chosen }) else { return devices }
        return devices + [AudioDevice(uid: chosen, name: "Not connected (the default is used)")]
    }

    func reload() {
        inputs = AudioDevices.inputs()
        outputs = AudioDevices.outputs()
    }
}

/**
 * Records a talk key: the next key pressed with its modifiers while the window has the focus (Esc cancels), or Fn
 * held alone. A combination that would swallow typing or take one of macOS's own is refused with words.
 */
@MainActor
struct TalkKeyRecorder: View {
    let recorded: (TalkKey) -> Void
    @State private var recording = false
    @State private var monitor: Any?

    var body: some View {
        Button(recording ? "Press the keys… (Esc to cancel)" : "Record…") { recording ? stop() : start() }
            .onDisappear(perform: stop)
    }

    func start() {
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { event in
            if event.type == .keyDown, event.keyCode == UInt16(kVK_Escape),
               event.modifierFlags.intersection(.deviceIndependentFlagsMask).isDisjoint(with: [.command, .control, .option, .shift]) {
                stop()
                return nil
            }
            guard let key = TalkKeyWatcher.talkKey(from: event) else { return event }
            stop()
            recorded(key)
            return nil
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        recording = false
    }
}

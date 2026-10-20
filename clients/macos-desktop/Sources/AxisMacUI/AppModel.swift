import AppKit
import AxisDesktopCore
import AxisMacPlatform

/**
 * The app's state and its one link to Axis: what the settings window shows and the menu bar item acts on.
 * Holds the pairing (address, client id and name on disk; the token in the Keychain), the commands and the desktop,
 * and the voice part (talk key, microphone, speakers) when talking from this Mac is on.
 */
@MainActor
public final class AppModel: ObservableObject {
    public let version: String
    @Published public private(set) var state: LinkState = .stopped
    @Published public private(set) var why: String?
    @Published public private(set) var saved = Saved.load()
    @Published public private(set) var recently: [String] = []
    @Published public private(set) var accessibility = Permissions.accessibility
    @Published public private(set) var screenRecording = Permissions.screenRecording
    @Published public private(set) var postEvents = Permissions.postEvents
    @Published public private(set) var microphone = Permissions.microphone
    /** What the voice part shows just now; nil while talking from this Mac is off. */
    @Published public private(set) var voiceNow: VoiceSnapshot?
    /** Why the talk key is not watched (taken by another app), or nil. */
    @Published public private(set) var talkKeyTrouble: String?

    public let desktop = MacDesktop()
    public let commands: DesktopCommands
    public let pointer: PointerPanel
    public let audio = AudioIO()
    let talkKeys = TalkKeyWatcher()
    private var link: AxisLink?
    private(set) var voice: Voice?
    private var outbox: Outbox?

    public init(version: String) {
        self.version = version
        commands = DesktopCommands(desktop: desktop)
        pointer = PointerPanel()
        commands.paused = saved.paused
        desktop.usePointer(pointer)
        commands.onDid = { [weak self] line in Task { @MainActor in self?.did(line) } }
        audio.use(mic: saved.micDevice, speaker: saved.speakerDevice)
        talkKeys.onPress = { [weak self] in self?.talkPressed() }
        talkKeys.onHold = { [weak self] in self?.voice?.hold() }
        talkKeys.onRelease = { [weak self] in self?.voice?.release() }
        applyTalkKey()
    }

    public var paired: Bool { saved.clientId != nil && saved.address != nil }

    /** A line for the window's "Recently" list, newest first. */
    func note(_ line: String) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        recently.insert("\(time)  \(line)", at: 0)
        if recently.count > 40 { recently.removeLast(recently.count - 40) }
    }

    /** What a command did: in the list. */
    func did(_ line: String) {
        note(line)
    }

    public func refreshPermissions() {
        accessibility = Permissions.accessibility
        screenRecording = Permissions.screenRecording
        postEvents = Permissions.postEvents
        microphone = Permissions.microphone
    }

    /** Connects with the saved pairing, if there is one. With talking on, the link carries the voice too. */
    public func start() {
        guard link == nil, let address = saved.address, let id = saved.clientId, let token = Keychain.token(for: id) else { return }
        let pairing = Pairing(address: address, clientId: id, token: token, name: saved.name ?? "")
        let link: AxisLink
        do { link = try AxisLink(pairing: pairing, identity: DesktopIdentity.create(version: version, voice: saved.voice)) } catch {
            why = describeError(error)
            return
        }
        let voice = saved.voice ? makeVoice(for: link) : nil
        // The Windows app's 8000: Axis paces speech to what the Mac can hold ahead.
        link.audioBufferMs = voice != nil ? 8000 : 0
        link.onState = { [weak self] state, why in
            voice?.linkChanged(online: state == .online)
            Task { @MainActor in self?.linked(state, why) }
        }
        link.onSettings = { [weak self] values in Task { @MainActor in self?.useSettings(values) } }
        link.onTrouble = { [weak self] line in Task { @MainActor in self?.note("⚠ " + line) } }
        link.onCommand = { [weak self, commands] name, params in
            await self?.commandComing(name)
            return await commands.handle(name, params)
        }
        if let voice {
            link.onMessage = { type, message in voice.handle(type, message) }
            link.onAudio = { pcm in voice.audio(pcm) }
        }
        self.link = link
        self.voice = voice
        voiceNow = voice?.snapshot
        link.start()
    }

    /** The voice part on this link: what it says goes out in order, what it shows comes back to the main thread. */
    private func makeVoice(for link: AxisLink) -> Voice {
        let outbox = Outbox { [weak link] item in
            guard let link else { return }
            switch item {
            case .message(let m): await link.trySend(m)
            case .audio(let pcm): await link.trySendAudio(pcm)
            }
        }
        let voice = Voice(io: audio, out: { outbox.put($0) })
        voice.onChange = { [weak self] in Task { @MainActor in self?.voiceChanged() } }
        voice.onFailed = { [weak self] why in Task { @MainActor in self?.note("⚠ voice: \(why)") } }
        self.outbox = outbox
        return voice
    }

    func linked(_ state: LinkState, _ why: String?) {
        self.state = state
        self.why = why
        if state == .refused { note(why ?? "Axis refused this Mac") }
    }

    /** Before a command runs (the UI parts show that an agent is at this Mac). */
    func commandComing(_ name: String) {}

    func voiceChanged() {
        voiceNow = voice?.snapshot
    }

    func useSettings(_ values: [String: JSONValue]) {
        commands.useSettings(values)
        if let size = values["pointerSize"]?.intValue { pointer.size = CGFloat(min(max(size, 24), 120)) }
    }

    public func stop() async {
        if let voice, voice.currentMode != .idle { voice.interrupt() }
        await link?.stop()
        link = nil
        voice = nil
        outbox = nil
        voiceNow = nil
    }

    /**
     * Pairs with Axis: `address` is an address or a setup string (axis://host:port/code), `code` the one-time code
     * when the address does not carry it. Replaces any pairing before it.
     */
    public func pair(address text: String, code typed: String, name: String) async throws {
        let address = try AxisAddress.parse(text)
        let code = (address.code ?? typed).trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { throw AxisLink.PairError(message: "Give the pairing code from Axis's admin page (Add a device).") }
        let identity = DesktopIdentity.create(version: version, voice: saved.voice)
        let pairing = try await AxisLink.pair(address: address, code: code, name: name, identity: identity)
        await stop()
        if let old = saved.clientId { Keychain.forget(old) }
        try Keychain.store(pairing.token, for: pairing.clientId)
        var next = saved
        next.address = pairing.address
        next.clientId = pairing.clientId
        next.name = pairing.name
        try next.save()
        saved = next
        note("Paired with \(pairing.address) as \(pairing.name)")
        start()
    }

    /** Forgets the pairing here (Axis keeps the device until it is removed on the admin page). */
    public func forget() async {
        await stop()
        if let id = saved.clientId { Keychain.forget(id) }
        var next = saved
        next.clientId = nil
        try? next.save()
        saved = next
        state = .stopped
        why = nil
    }

    /** Changes what is saved and writes it; a failed write is said in the list (the change still holds until quit). */
    func change(_ edit: (inout Saved) -> Void) {
        var next = saved
        edit(&next)
        do { try next.save() } catch { note("⚠ The settings could not be saved: \(describeError(error))") }
        saved = next
    }

    public var paused: Bool { saved.paused }

    public func setPaused(_ on: Bool) {
        commands.paused = on
        change { $0.paused = on }
        if on { pointer.hide() }
        note(on ? "Paused: agents can neither read, point nor act" : "Resumed")
    }

    /** The menu's "Show the pointer": the same as the admin page's. */
    public func showPointer() {
        Task { _ = await commands.handle("desktop.hello", [:]) }
    }

    // MARK: Talking from this Mac

    /** The talk key as it is saved (the standard one when what is saved cannot be used). */
    public var talkKey: TalkKey { TalkKey.saved(saved.talkKey) }

    func talkPressed() {
        guard let voice, !paused, state == .online else { return }
        voice.press()
    }

    /** Talking from this Mac on or off: Axis hears of it on the next connection, so the link starts again now. */
    public func setVoice(_ on: Bool) async {
        change { $0.voice = on }
        applyTalkKey()
        if link != nil {
            await stop()
            start()
        }
        note(on ? "Talking from this Mac: on (\(talkKey.label))" : "Talking from this Mac: off")
    }

    /** Uses `key` as the talk key from now on. Returns why it cannot be, or nil. */
    @discardableResult
    public func setTalkKey(_ key: TalkKey) -> String? {
        if let why = key.refused() { return why }
        change { $0.talkKey = key.description }
        applyTalkKey()
        if talkKeyTrouble == nil { note("Talk key: \(key.label)") }
        return talkKeyTrouble
    }

    /** Watches the saved talk key while talking is on; says in the list when another app has it. */
    func applyTalkKey() {
        guard saved.voice else {
            talkKeys.stop()
            talkKeyTrouble = nil
            return
        }
        talkKeyTrouble = talkKeys.use(talkKey)
        if let trouble = talkKeyTrouble { note("⚠ \(trouble)") }
    }

    /** The microphone and speaker by UID; empty is the system's default. From the next recording or answer. */
    public func setDevices(mic: String, speaker: String) {
        change {
            $0.micDevice = mic
            $0.speakerDevice = speaker
        }
        audio.use(mic: mic, speaker: speaker)
    }

    /** The window's and the menu's "Talk now": a press of the talk key. */
    public func talkNow() { talkPressed() }

    /** A few words for the menu and the window. */
    public var stateLine: String {
        if !paired { return "Not paired" }
        if paused { return "Paused" }
        switch state {
        case .online: return "Online"
        case .connecting: return "Connecting…"
        case .offline: return "Offline\(why.map { ": \($0)" } ?? "")"
        case .refused: return why ?? "Refused by Axis"
        case .stopped: return "Stopped"
        }
    }
}

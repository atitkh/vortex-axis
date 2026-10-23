import AppKit
import AxisDesktopCore
import AxisMacPlatform

/**
 * The app's state and its one link to Axis: what the settings window shows and the menu bar item acts on.
 * Holds the pairing (address, client id and name on disk; the token in the Keychain), the commands and the desktop,
 * and the voice part (talk key, microphone, speakers) when talking from this Mac is on; and what it shows on screen
 * besides the pointer: the face, the "using this computer" pill, the voice pill (or the typing pill in its place),
 * the task pill and the timer pill, and the sounds (`Notices`).
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
    /** Why the typing key is not watched, or nil. */
    @Published public private(set) var typingKeyTrouble: String?
    /** An agent is using this Mac just now (from its first desktop command until a few seconds after the last). */
    @Published public private(set) var agentHere = false

    public let desktop = MacDesktop()
    public let commands: DesktopCommands
    public let pointer: PointerPanel
    public let face: FacePanel
    let controlPill: ControlPill
    let voicePill: VoicePill
    let typingPill = TypingPill()
    let taskPill = TaskPill()
    let timerPill = TimerPill()
    private var pills: PillStack?
    /** The long-task line, the next timer and the sounds: what Axis asks a screen for besides the voice. */
    public let notices = Notices()
    public let audio = AudioIO()
    let talkKeys = TalkKeyWatcher(id: 1)
    let typingKeys = TalkKeyWatcher(id: 2)
    /** The reply's picture once fetched, and the address it came from. */
    private var pictureURL: String?
    private var pictureImage: NSImage?
    private var link: AxisLink?
    private(set) var voice: Voice?
    private var outbox: Outbox?
    private var lastWoke = Date.distantPast

    public init(version: String) {
        self.version = version
        commands = DesktopCommands(desktop: desktop)
        pointer = PointerPanel()
        face = FacePanel()
        controlPill = ControlPill()
        voicePill = VoicePill()
        commands.paused = saved.paused
        desktop.usePointer(pointer)
        commands.onDid = { [weak self] line in Task { @MainActor in self?.did(line) } }
        audio.use(mic: saved.micDevice, speaker: saved.speakerDevice)
        // Held: talk (the microphone runs from key-down); tapped: type (or, with a typing key of its own, listen).
        talkKeys.onPress = { [weak self] in self?.talkDown() }
        talkKeys.onHold = { [weak self] in
            // Held while typing: talking wins, the typing pill goes.
            self?.typingPill.close()
            self?.voice?.keyHeld()
        }
        talkKeys.onRelease = { [weak self] in self?.talkUp() }
        typingKeys.onPress = { [weak self] in self?.toggleTyping() }
        applyTalkKey()
        face.loudness = { [weak self] in self?.voice?.loudness ?? -1 }
        face.onClick = { [weak self] in self?.talkPressed() }
        face.onMoved = { [weak self] x, y in
            self?.change {
                $0.facePlace = FaceLayout.custom
                $0.faceX = x
                $0.faceY = y
            }
        }
        controlPill.onChange = { [weak self] in self?.agentChanged() }
        pills = PillStack([controlPill.host, voicePill.host, typingPill.host, taskPill.host, timerPill.host])
        voicePill.onChoice = { [weak self] choice in self?.voice?.answer(choice) }
        typingPill.onSend = { [weak self] text in _ = self?.voice?.type(text) }
        typingPill.onChoice = { [weak self] choice in self?.voice?.answer(choice) }
        typingPill.onClose = { [weak self] in
            self?.voicePill.hold(false)
            self?.voiceChanged()
        }
        taskPill.onDismiss = { [weak self] in self?.notices.dismissDone() }
        timerPill.onCancel = { [weak self] id in self?.cancelTimer(id) }
        let audio = self.audio
        notices.onChime = { sound in audio.playSound(Sounds.samples(sound)) }
        notices.onChange = { [weak self] in Task { @MainActor in self?.noticesChanged() } }
        _ = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.pills?.restack() }
        }
        // Sleep, wake and the screen coming back: the connection, the keys, the face and the pills are made good again.
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            _ = workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.woke() }
            }
        }
        _ = workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.sleeping() }
        }
        applyFace()
    }

    /** The Mac is going to sleep: nothing half-said, half-heard or half-typed goes with it. */
    func sleeping() {
        if let voice, voice.currentMode != .idle { voice.interrupt() }
        typingPill.close()
        pointer.hide()
    }

    /** The Mac woke (or its screens or session came back): whatever the sleep broke is set up again. */
    func woke() {
        // Wake, screens wake and the session coming back arrive together: once is enough.
        if Date().timeIntervalSince(lastWoke) < 3 { return }
        lastWoke = Date()
        note("Woke: reconnecting")
        link?.nudge()
        // The talk key's registration and the permissions can both be lost over a sleep.
        applyTalkKey()
        refreshPermissions()
        // A moment on, when the screens are back, the face and pills are put in front again.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            self.face.refresh()
            self.showFace()
            self.pills?.refresh()
        }
    }

    public var paired: Bool { saved.clientId != nil && saved.address != nil }

    /** A line for the window's "Recently" list, newest first. */
    func note(_ line: String) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        recently.insert("\(time)  \(line)", at: 0)
        if recently.count > 40 { recently.removeLast(recently.count - 40) }
    }

    /** What a command did: in the list, and on the "using this computer" pill. */
    func did(_ line: String) {
        note(line)
        controlPill.did(line)
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
        let notices = self.notices
        link.onState = { [weak self] state, why in
            voice?.linkChanged(online: state == .online)
            notices.linkChanged(online: state == .online)
            Task { @MainActor in self?.linked(state, why) }
        }
        link.onSettings = { [weak self] values in
            notices.useSettings(values)
            Task { @MainActor in self?.useSettings(values) }
        }
        link.onTrouble = { [weak self] line in Task { @MainActor in self?.note("⚠ " + line) } }
        link.onCommand = { [weak self, commands] name, params in
            // The task line, the next timer and the chime are the screen's, not the desktop tool's.
            if Notices.commands.contains(name) { return notices.handle(name, params) }
            await self?.commandComing(name)
            return await commands.handle(name, params)
        }
        notices.send = { [weak link] message in Task { _ = await link?.trySend(message) } }
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
        // The listening cue, as the boards play it (the `listenCue` setting; never in quiet hours).
        let notices = self.notices
        voice.onListening = { _ = notices.play(.listening) }
        voice.onFailed = { [weak self] why in Task { @MainActor in self?.note("⚠ voice: \(why)") } }
        self.outbox = outbox
        return voice
    }

    func linked(_ state: LinkState, _ why: String?) {
        self.state = state
        self.why = why
        if state == .refused { note(why ?? "Axis refused this Mac") }
    }

    /** Before a command runs: an agent at this Mac is shown for as long as it is (not the admin page's "Show the pointer"). */
    func commandComing(_ name: String) {
        if ControlPillWords.shows(name, paused: paused, switchedOn: saved.showControl) { controlPill.touch() }
    }

    func voiceChanged() {
        voiceNow = voice?.snapshot
        if let now = voiceNow {
            fetchPicture(now.picture)
            if typingPill.isOpen { typingPill.ask(now.question, choices: now.choices) }
            voicePill.show(now, talkKey: talkKey.label, picture: pictureURL == now.picture?.url ? pictureImage : nil)
        }
        showFace()
    }

    /** A reply's picture, fetched once from Axis; the pill shows it when it is here (and loses it with the reply). */
    private func fetchPicture(_ picture: VoicePicture?) {
        guard let picture, picture.url != pictureURL, let link else { return }
        pictureURL = picture.url
        pictureImage = nil
        let url = picture.url
        Task { [weak self] in
            do {
                let data = try await link.picture(url)
                guard let self, self.pictureURL == url else { return }
                guard let image = NSImage(data: data) else { throw DesktopError("the picture could not be read") }
                self.pictureImage = image
                self.voiceChanged()
            } catch {
                self?.note("⚠ A picture in the reply: \(describeError(error))")
            }
        }
    }

    // MARK: The task and timer pills

    /** The task line or the next timer changed (or a finished task's time on show ran out). */
    func noticesChanged() {
        guard voice != nil else {
            taskPill.vanish()
            timerPill.vanish()
            return
        }
        let task = notices.task
        taskPill.show(TaskPillWords.of(task))
        let notices = self.notices
        let timer = notices.timer
        timerPill.show(timer, now: { notices.now })
        // Look again when a finished task or a rung timer is due to go, in case Axis says nothing more.
        var next: UInt64?
        if task.state == .done { next = Notices.doneShownMs }
        if let timer {
            let gone = timer.endsAt + Notices.rungShownMs
            let wait = gone > notices.now ? gone - notices.now : 0
            next = min(next ?? wait, wait)
        }
        if let next {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(next) + 200)) { [weak self] in self?.noticesChanged() }
        }
    }

    /** The timer pill's ×: Axis cancels it and sends every screen the next one. */
    func cancelTimer(_ id: Int) {
        guard let link else { return }
        Task { [weak self] in
            do { try await link.cancelTimer(id: id) } catch { self?.note("⚠ The timer could not be cancelled: \(describeError(error))") }
        }
    }

    /** An agent came to this Mac or left it: the pill under it moves, the face and the menu bar icon follow. */
    func agentChanged() {
        agentHere = controlPill.active
        voicePill.replace()
        showFace()
    }

    /** The face follows the voice part and whether an agent is at this Mac (the Windows app's `ShowFace`). */
    func showFace() {
        guard saved.showFace, !paused else {
            face.set(FaceShow.of(.idle, doing: nil, agentHere: false))
            return
        }
        face.set(FaceShow.of(voiceNow?.mode ?? .idle, doing: voiceNow?.doing, agentHere: agentHere))
    }

    /** Size, place and keep, from the settings. */
    func applyFace() {
        face.look(size: saved.faceSize, place: saved.facePlace, x: saved.faceX, y: saved.faceY)
        face.keep(saved.keepFace && saved.showFace)
        showFace()
    }

    /** What the menu bar icon shows. */
    public var iconState: MenuIconState {
        MenuIconState.of(online: paired && state == .online, paused: paused, voice: voiceNow?.mode, agentHere: agentHere)
    }

    func useSettings(_ values: [String: JSONValue]) {
        commands.useSettings(values)
        face.useSettings(values)
        if let size = values["pointerSize"]?.intValue { pointer.size = CGFloat(min(max(size, 24), 120)) }
    }

    public func stop() async {
        if let voice, voice.currentMode != .idle { voice.interrupt() }
        typingPill.close()
        await link?.stop()
        link = nil
        voice = nil
        outbox = nil
        voiceNow = nil
        pictureURL = nil
        pictureImage = nil
        voicePill.dismiss()
        notices.linkChanged(online: false)
        taskPill.vanish()
        timerPill.vanish()
        showFace()
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
        if on {
            pointer.hide()
            controlPill.dismiss()
        }
        showFace()
        note(on ? "Paused: agents can neither read, point nor act" : "Resumed")
    }

    /** The menu's "Show the pointer": the same as the admin page's. */
    public func showPointer() {
        Task { _ = await commands.handle("desktop.hello", [:]) }
    }

    // MARK: The face and the pills

    public func setShowFace(_ on: Bool) {
        change { $0.showFace = on }
        applyFace()
    }

    /** The face stays on screen between turns; a click on it talks, a right-button drag moves it. */
    public func setKeepFace(_ on: Bool) {
        change { $0.keepFace = on }
        applyFace()
    }

    public func setFaceSize(_ size: String) {
        change { $0.faceSize = size }
        applyFace()
    }

    public func setFacePlace(_ place: String) {
        change { $0.facePlace = place }
        applyFace()
    }

    public func setShowControl(_ on: Bool) {
        change { $0.showControl = on }
        if !on { controlPill.dismiss() }
    }

    /** The window's "Try them": the "using this computer" pill and the face with the computer icon, as an agent's command would show them. */
    public func tryFaceAndPills() {
        controlPill.did("Tried from the settings window")
        controlPill.touch()
    }

    // MARK: Talking from this Mac

    /** The talk key as it is saved (the standard one when what is saved cannot be used). */
    public var talkKey: TalkKey { TalkKey.saved(saved.talkKey) }

    func talkPressed() {
        guard let voice, !paused, state == .online else { return }
        voice.press()
    }

    /** The talk key went down: the microphone starts at once (or the agent is stopped, or listening finishes). */
    func talkDown() {
        guard let voice, !paused, state == .online else { return }
        voice.keyDown()
    }

    /** The talk key came up: the end of a hold, or a tap, which opens the typing pill (unless it has a key of its own). */
    func talkUp() {
        guard let voice else { return }
        let ownKey = typingKey != nil
        if voice.keyUp(tapListens: ownKey) == .tap && !ownKey { toggleTyping() }
    }

    // MARK: Typing to the agent

    /** The typing key, when one of its own is set; nil: a tap of the talk key opens the typing pill. */
    public var typingKey: TalkKey? {
        guard let k = TalkKey.parse(saved.typingKey), k.refused() == nil, !k.isFn else { return nil }
        return k
    }

    /** Opens the typing pill in the voice pill's slot, or closes it. Only while talking from this Mac is on and online. */
    public func toggleTyping() {
        if typingPill.isOpen {
            typingPill.close()
            return
        }
        guard voice != nil, state == .online, !paused else { return }
        voicePill.hold(true)
        typingPill.open(question: voiceNow?.question, choices: voiceNow?.choices ?? [])
    }

    /** Uses `key` to open the typing pill (nil: a tap of the talk key does). Returns why it cannot be, or nil. */
    @discardableResult
    public func setTypingKey(_ key: TalkKey?) -> String? {
        if let key {
            if key.isFn { return "Fn alone can only be the talk key" }
            if let why = key.refused() { return why }
            if key == talkKey { return "that is the talk key" }
        }
        change { $0.typingKey = key?.description ?? "" }
        applyTalkKey()
        if typingKeyTrouble == nil { note("Typing key: \(key?.label ?? "a tap of the talk key")") }
        return typingKeyTrouble
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
            typingKeys.stop()
            talkKeyTrouble = nil
            typingKeyTrouble = nil
            return
        }
        talkKeyTrouble = talkKeys.use(talkKey)
        if let trouble = talkKeyTrouble { note("⚠ \(trouble)") }
        if let key = typingKey, key != talkKey {
            typingKeyTrouble = typingKeys.use(key)
            if let trouble = typingKeyTrouble { note("⚠ \(trouble)") }
        } else {
            typingKeys.stop()
            typingKeyTrouble = nil
        }
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

    /** The menu's "Type to VorteX…". */
    public func typeNow() { toggleTyping() }

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

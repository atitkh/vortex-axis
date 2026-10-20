import AppKit
import AxisDesktopCore
import AxisMacPlatform

/**
 * The app's state and its one link to Axis: what the settings window shows and the menu bar item acts on.
 * Holds the pairing (address, client id and name on disk; the token in the Keychain), the commands and the desktop.
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

    public let desktop = MacDesktop()
    public let commands: DesktopCommands
    public let pointer: PointerPanel
    private var link: AxisLink?

    public init(version: String) {
        self.version = version
        commands = DesktopCommands(desktop: desktop)
        pointer = PointerPanel()
        commands.paused = saved.paused
        desktop.usePointer(pointer)
        commands.onDid = { [weak self] line in Task { @MainActor in self?.note(line) } }
    }

    public var paired: Bool { saved.clientId != nil && saved.address != nil }

    /** A line for the window's "Recently" list, newest first. */
    func note(_ line: String) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        recently.insert("\(time)  \(line)", at: 0)
        if recently.count > 40 { recently.removeLast(recently.count - 40) }
    }

    public func refreshPermissions() {
        accessibility = Permissions.accessibility
        screenRecording = Permissions.screenRecording
        postEvents = Permissions.postEvents
    }

    /** Connects with the saved pairing, if there is one. */
    public func start() {
        guard link == nil, let address = saved.address, let id = saved.clientId, let token = Keychain.token(for: id) else { return }
        let pairing = Pairing(address: address, clientId: id, token: token, name: saved.name ?? "")
        let link: AxisLink
        do { link = try AxisLink(pairing: pairing, identity: DesktopIdentity.create(version: version)) } catch {
            why = describeError(error)
            return
        }
        link.onState = { [weak self] state, why in Task { @MainActor in self?.state = state; self?.why = why } }
        link.onSettings = { [weak self] values in Task { @MainActor in self?.useSettings(values) } }
        link.onTrouble = { [weak self] line in Task { @MainActor in self?.note(line) } }
        link.onCommand = { [commands] name, params in await commands.handle(name, params) }
        self.link = link
        link.start()
    }

    func useSettings(_ values: [String: JSONValue]) {
        commands.useSettings(values)
        if let size = values["pointerSize"]?.intValue { pointer.size = CGFloat(min(max(size, 24), 120)) }
    }

    public func stop() async {
        await link?.stop()
        link = nil
    }

    /**
     * Pairs with Axis: `address` is an address or a setup string (axis://host:port/code), `code` the one-time code
     * when the address does not carry it. Replaces any pairing before it.
     */
    public func pair(address text: String, code typed: String, name: String) async throws {
        let address = try AxisAddress.parse(text)
        let code = (address.code ?? typed).trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { throw AxisLink.PairError(message: "Give the pairing code from Axis's admin page (Add a device).") }
        let pairing = try await AxisLink.pair(address: address, code: code, name: name, identity: DesktopIdentity.create(version: version))
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

    public var paused: Bool { saved.paused }

    public func setPaused(_ on: Bool) {
        commands.paused = on
        var next = saved
        next.paused = on
        try? next.save()
        saved = next
        if on { pointer.hide() }
        note(on ? "Paused: agents can neither read, point nor act" : "Resumed")
    }

    /** The menu's "Show the pointer": the same as the admin page's. */
    public func showPointer() {
        Task { _ = await commands.handle("desktop.hello", [:]) }
    }

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

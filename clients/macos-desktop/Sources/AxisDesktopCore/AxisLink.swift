import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/** Who this client is, as it tells Axis on every connection. */
public struct ClientIdentity: Sendable {
    public let type: String
    public let version: String
    public let capabilities: [String]
    /** The describe message without its `t`: settings, actions, links. */
    public let describe: [String: JSONValue]

    public init(type: String, version: String, capabilities: [String], describe: [String: JSONValue]) {
        self.type = type
        self.version = version
        self.capabilities = capabilities
        self.describe = describe
    }
}

/** What the client holds once paired. Kept by the app; the token is a secret (the Keychain). */
public struct Pairing: Equatable, Sendable {
    public let address: String
    public let clientId: String
    public let token: String
    public let name: String

    public init(address: String, clientId: String, token: String, name: String) {
        self.address = address
        self.clientId = clientId
        self.token = token
        self.name = name
    }
}

/** A command's answer: `data` for a structured one, `payload` for a few scalars. */
public struct CommandAnswer: Equatable, Sendable {
    public let ok: Bool
    public let error: String?
    public let payload: [String: JSONValue]?
    public let data: JSONValue?

    public init(ok: Bool, error: String? = nil, payload: [String: JSONValue]? = nil, data: JSONValue? = nil) {
        self.ok = ok
        self.error = error
        self.payload = payload
        self.data = data
    }

    public static func fail(_ error: String) -> CommandAnswer { CommandAnswer(ok: false, error: error) }
    public static func done(payload: [String: JSONValue]? = nil, data: JSONValue? = nil) -> CommandAnswer {
        CommandAnswer(ok: true, payload: payload, data: data)
    }
}

public enum LinkState: String, Sendable { case stopped, connecting, online, offline, refused }

/** An error whose words are meant for the agent and the person as they are (the app's own refusals). */
public protocol SaysWhy: Error {
    var message: String { get }
}

/** A refusal or failure of the desktop, in words, as the Windows app's InvalidOperationException messages. */
public struct DesktopError: SaysWhy, LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/** An error that says what went wrong in words, or names its domain and code when it has none. */
public func describeError(_ error: Error) -> String {
    if let says = error as? SaysWhy { return says.message }
    let e = error as NSError
    let text = e.localizedDescription.trimmingCharacters(in: .whitespaces)
    return text.isEmpty ? "\(e.domain) \(e.code)" : "\(text) (\(e.domain) \(e.code))"
}

/**
 * One connection to Axis, kept open: hello, welcome, describe, settings and commands, protocol 1.
 * Reconnects by itself after a drop, waiting longer each time up to half a minute. A refused token stops it
 * for good (the pairing is gone; pair again). Port of the Windows app's `AxisLink.cs`.
 */
public final class AxisLink: @unchecked Sendable {
    public static let protocolVersion = 1
    static let backoffSeconds: [UInt64] = [1, 2, 5, 10, 30]

    public let address: AxisAddress
    let pairing: Pairing
    let identity: ClientIdentity
    let session: URLSession

    /** Told every change of state, with a few words on why when there are any. */
    public var onState: (@Sendable (LinkState, String?) -> Void)?
    /** Told the full resolved settings whenever Axis sends them. */
    public var onSettings: (@Sendable ([String: JSONValue]) -> Void)?
    /** Carries out a command from Axis. Unset, every command is answered "not implemented". */
    public var onCommand: (@Sendable (String, JSONValue) async -> CommandAnswer)?
    /** Every message this class does not handle itself (turns, speech, replies), as it came. */
    public var onMessage: (@Sendable (String, JSONValue) -> Void)?
    /** Something went wrong answering Axis that Axis itself will never hear about: said in the app instead. */
    public var onTrouble: (@Sendable (String) -> Void)?

    private let lock = NSLock()
    private var running: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var sendTail: Task<Void, Error>?
    private var settingsVersion = 0
    private var _state = LinkState.stopped

    public var state: LinkState { lock.withLock { _state } }

    public init(pairing: Pairing, identity: ClientIdentity, session: URLSession = .shared) throws {
        self.pairing = pairing
        self.identity = identity
        self.session = session
        address = try AxisAddress.parse(pairing.address)
    }

    /** Pairs with a one-time code from Axis's admin page ("Add a device"). */
    public static func pair(address: AxisAddress, code: String, name: String, identity: ClientIdentity,
                            session: URLSession = .shared) async throws -> Pairing {
        var body: [String: JSONValue] = [
            "code": .string(code.trimmingCharacters(in: .whitespaces)),
            "type": .string(identity.type),
            "version": .string(identity.version),
            "capabilities": .array(identity.capabilities.map { .string($0) }),
        ]
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { body["name"] = .string(trimmed) }
        var request = URLRequest(url: address.pair, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONValue.object(body).encoded()
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let reply = try? JSONValue.parse(data)
        guard (200..<300).contains(status) else {
            throw PairError(message: reply?["error"]?.stringValue ?? "Axis said \(status).")
        }
        guard let id = reply?["clientId"]?.stringValue, let token = reply?["token"]?.stringValue else {
            throw PairError(message: "Axis's answer had no client id or token.")
        }
        return Pairing(address: address.description, clientId: id, token: token, name: reply?["name"]?.stringValue ?? trimmed)
    }

    public struct PairError: Error, LocalizedError {
        public let message: String
        public init(message: String) { self.message = message }
        public var errorDescription: String? { message }
    }

    public func start() {
        lock.withLock {
            guard running == nil else { return }
            running = Task { [weak self] in await self?.run() }
        }
    }

    public func stop() async {
        let task: Task<Void, Never>? = lock.withLock {
            let t = running
            running = nil
            socket?.cancel(with: .goingAway, reason: nil)
            return t
        }
        task?.cancel()
        await task?.value
        setState(.stopped, nil)
    }

    private func setState(_ state: LinkState, _ why: String?) {
        lock.withLock { _state = state }
        onState?(state, why)
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            setState(.connecting, nil)
            var why: String?
            do {
                if let refused = try await connection() {
                    setState(.refused, refused)
                    return
                }
                attempt = 0
            } catch {
                if Task.isCancelled { return }
                why = describeError(error)
            }
            let wait = Self.backoffSeconds[min(attempt, Self.backoffSeconds.count - 1)]
            attempt += 1
            setState(.offline, why ?? "connection closed")
            do { try await Task.sleep(nanoseconds: wait * 1_000_000_000) } catch { return }
        }
    }

    /** One connection, to its end. Returns why Axis refused this client for good, or nil for an ordinary drop. */
    private func connection() async throws -> String? {
        let request = URLRequest(url: address.socket, timeoutInterval: 15)
        let ws = session.webSocketTask(with: request)
        // Axis's documented limit for a JSON frame.
        ws.maximumMessageSize = 1 << 20
        lock.withLock {
            socket = ws
            sendTail = nil
        }
        ws.resume()
        defer { ws.cancel(with: .goingAway, reason: nil) }
        let pinging = Task { [weak ws] in
            // The Windows app's KeepAlive: 20 s.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                ws?.sendPing { _ in }
            }
        }
        defer { pinging.cancel() }

        // No audioBufferMs: there is no speaker before M3.
        let hello: [String: JSONValue] = [
            "t": "hello",
            "protocol": .int(Self.protocolVersion),
            "clientId": .string(pairing.clientId),
            "token": .string(pairing.token),
            "type": .string(identity.type),
            "version": .string(identity.version),
            "capabilities": .array(identity.capabilities.map { .string($0) }),
            "settingsVersion": .int(lock.withLock { settingsVersion }),
            // Big enough for anything Axis might send.
            "maxFrameBytes": 65536,
        ]
        try await send(.object(hello))

        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do { message = try await ws.receive() } catch {
                if let refused = closeReason(ws) { return refused }
                throw error
            }
            let text: String
            switch message {
            case .string(let s): text = s
            case .data: continue  // speech audio; no speaker before M3
            @unknown default: continue
            }
            guard let root = try? JSONValue.parse(text), let t = root["t"]?.stringValue else { continue }
            switch t {
            case "welcome":
                try await send(describeMessage())
                setState(.online, nil)
            case "settings":
                if let v = root["version"]?.intValue { lock.withLock { settingsVersion = v } }
                onSettings?(root["values"]?.objectValue ?? [:])
            case "command":
                guard let id = root["id"]?.stringValue, let name = root["name"]?.stringValue else { continue }
                // Structured arguments (desktop.steps, paste) arrive beside the params; the handler sees them as params.data.
                var params = root["params"]?.objectValue ?? [:]
                if let extra = root["data"] { params["data"] = extra }
                let received = DispatchTime.now()
                // Each command runs on its own, so a slow look does not hold up a point.
                Task { await self.answer(id: id, name: name, params: .object(params), received: received) }
            case "turn", "transcript", "reply.text", "speak.start", "speak.end", "stop", "ask", "ask.end", "status":
                onMessage?(t, root)
            case "error":
                let code = root["code"]?.stringValue
                let words = root["message"]?.stringValue ?? ""
                if code == "unauthorized" { return "Axis no longer knows this computer (\(words)). Pair it again." }
                if code == "unsupported_protocol" { return "Axis speaks another protocol (\(words)). Update the app." }
            default:
                break
            }
        }
        return nil
    }

    private func closeReason(_ ws: URLSessionWebSocketTask) -> String? {
        guard let data = ws.closeReason, let reason = String(data: data, encoding: .utf8), !reason.isEmpty,
              reason.lowercased().contains("token") else { return nil }
        return "Axis refused this computer: \(reason). Pair it again."
    }

    static func ms(since t: DispatchTime) -> UInt64 { (DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1_000_000 }

    private func answer(id: String, name: String, params: JSONValue, received: DispatchTime) async {
        let started = DispatchTime.now()
        let waited = Self.ms(since: received)
        if waited > 1000 { onTrouble?("\(name) waited \(waited) ms to start") }
        let answer = await onCommand?(name, params) ?? .fail("not implemented on this device")
        var reply: [String: JSONValue] = ["t": "command.result", "id": .string(id), "ok": .bool(answer.ok)]
        if let p = answer.payload { reply["payload"] = .object(p) }
        if let d = answer.data { reply["data"] = d }
        if let e = answer.error { reply["error"] = .string(e.count > 256 ? String(e.prefix(255)) + "…" : e) }
        do {
            let sending = DispatchTime.now()
            try await send(.object(reply))
            let total = Self.ms(since: received)
            // Axis waits 15 s for most commands; an answer near that is as good as lost, so the app says where the time went.
            if total > 10000 {
                onTrouble?("\(name) answered after \(total) ms (work \((sending.uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000), sending \(Self.ms(since: sending)))")
            }
        } catch {
            // Never swallowed: an answer that never left looks like the computer not answering (Windows 0.4.0 to 0.4.3).
            onTrouble?("\(name): the answer could not be sent: \(describeError(error))")
        }
    }

    func describeMessage() -> JSONValue {
        var d = identity.describe
        d["t"] = "describe"
        for key in ["settings", "actions", "links"] where d[key] == nil { d[key] = .array([]) }
        return .object(d)
    }

    /** Sends a message, for later parts (voice); false when not connected. */
    @discardableResult
    public func trySend(_ message: JSONValue) async -> Bool {
        do { try await send(message); return true } catch { return false }
    }

    /** One frame at a time, in the order asked: sends are chained so two answers never interleave. */
    private func send(_ message: JSONValue) async throws {
        let text = String(decoding: try message.encoded(), as: UTF8.self)
        let task: Task<Void, Error> = try lock.withLock {
            guard let ws = socket else { throw PairError(message: "not connected") }
            let previous = sendTail
            let t = Task {
                _ = await previous?.result
                try await ws.send(.string(text))
            }
            sendTail = t
            return t
        }
        try await task.value
    }
}

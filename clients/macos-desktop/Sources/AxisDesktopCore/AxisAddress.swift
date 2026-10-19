import Foundation

/**
 * Where Axis is, from whatever a person pastes: an address with or without its scheme, or a setup string
 * (axis://host:port/code, axis+tls:// for an encrypted address) that carries the pairing code too.
 * The same rules as the Windows app's `AxisAddress.cs`.
 */
public struct AxisAddress: Equatable, Sendable, CustomStringConvertible {
    public static let pairPath = "/v1/pair"
    public static let socketPath = "/v1/client"

    /** "http" or "https". */
    public let scheme: String
    public let host: String
    /** Nil for the scheme's usual port. */
    public let port: Int?
    /** The pairing code a setup string carried. */
    public let code: String?

    public enum ParseError: Error, LocalizedError, Equatable {
        case empty, notAnAddress(String)
        public var errorDescription: String? {
            switch self {
            case .empty: return "Give Axis's address."
            case .notAnAddress(let s): return "\"\(s)\" is not an address."
            }
        }
    }

    var authority: String {
        let h = host.contains(":") ? "[\(host)]" : host
        return port.map { "\(h):\($0)" } ?? h
    }

    /** The address as it is kept and shown: the http(s) base, no path. */
    public var description: String { "\(scheme)://\(authority)" }

    public var pair: URL { URL(string: "\(scheme)://\(authority)\(Self.pairPath)")! }
    public var socket: URL { URL(string: "\(scheme == "https" ? "wss" : "ws")://\(authority)\(Self.socketPath)")! }

    /**
     * Reads an address. A bare host:port is taken as plain http (a hub on the local network); a bare name as
     * https (a hub under a public name). An explicit scheme wins.
     */
    public static func parse(_ input: String) throws -> AxisAddress {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { throw ParseError.empty }
        let lower = text.lowercased()
        var code: String?
        let scheme: String
        func dropScheme() { text = String(text[text.range(of: "://")!.upperBound...]) }
        if lower.hasPrefix("axis+tls://") || lower.hasPrefix("axis://") {
            scheme = lower.hasPrefix("axis+tls://") ? "https" : "http"
            dropScheme()
            if let slash = text.firstIndex(of: "/") {
                let c = text[text.index(after: slash)...].trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                code = c.isEmpty ? nil : c
                text = String(text[..<slash])
            }
        } else if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
            scheme = lower.hasPrefix("https://") ? "https" : "http"
            dropScheme()
            if let slash = text.firstIndex(of: "/") { text = String(text[..<slash]) }
        } else {
            if let slash = text.firstIndex(of: "/") { text = String(text[..<slash]) }
            scheme = text.contains(":") ? "http" : "https"
        }
        guard let parts = URLComponents(string: "\(scheme)://\(text)/"), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil else { throw ParseError.notAnAddress(input) }
        let usual = scheme == "https" ? 443 : 80
        let port = parts.port.flatMap { $0 == usual ? nil : $0 }
        return AxisAddress(scheme: scheme, host: host.lowercased(), port: port, code: code)
    }
}

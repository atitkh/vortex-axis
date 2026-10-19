import Foundation
import Security

/**
 * What the app keeps between runs, in ~/Library/Application Support/VorteX Axis/desktop.json with the Windows
 * app's field names, so the settings model stays shared. The token is not in it: it is in the Keychain.
 */
public struct Saved: Codable, Equatable {
    public var address: String?
    public var clientId: String?
    public var name: String?
    public var paused = false

    enum CodingKeys: String, CodingKey {
        case address = "Address", clientId = "ClientId", name = "Name", paused = "Paused"
    }

    public init() {}

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        address = try c.decodeIfPresent(String.self, forKey: .address)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
    }

    static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("VorteX Axis", isDirectory: true)
    }
    static var file: URL { folder.appendingPathComponent("desktop.json") }
    static var backup: URL { folder.appendingPathComponent("desktop.json.bak") }

    /** The saved settings, from the backup when the file is unreadable, or none. */
    public static func load() -> Saved {
        for url in [file, backup] {
            if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode(Saved.self, from: data) { return saved }
        }
        return Saved()
    }

    /** Writes the file whole (never half), keeping the last good one as the backup. */
    public func save() throws {
        try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(self)
        if FileManager.default.fileExists(atPath: Self.file.path) {
            try? FileManager.default.removeItem(at: Self.backup)
            try? FileManager.default.copyItem(at: Self.file, to: Self.backup)
        }
        try data.write(to: Self.file, options: .atomic)
    }
}

/** The pairing token, one generic password in the login Keychain, readable only on this Mac. */
public enum Keychain {
    static let service = "VorteX Axis desktop"

    static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public static func token(for clientId: String) -> String? {
        var q = query(clientId)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func store(_ token: String, for clientId: String) throws {
        SecItemDelete(query(clientId) as CFDictionary)
        var q = query(clientId)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    public static func forget(_ clientId: String) { SecItemDelete(query(clientId) as CFDictionary) }
}

import Foundation

// Who this server presents itself as on the machine: where its bridge socket
// and support files live, what its agent-cursor overlay is called, which
// native-messaging hosts it registers, and which prefix its tunables use.
//
// The defaults are the standalone server's. An app that ships the binary inside
// its own bundle ("embedding") can run it under its own identity so it never
// collides with a standalone install on the same machine:
//
//   --profile <file|json> (any position) or COMPUTER_USE_PROFILE: a JSON object
//   with any of the keys below, inline or as a file path.
//   COMPUTER_USE_SUPPORT_DIR, COMPUTER_USE_BRIDGE_SOCKET, COMPUTER_USE_ENV_PREFIX,
//   COMPUTER_USE_AGENT_CURSOR_NAME, COMPUTER_USE_AGENT_CURSOR_BUNDLE_ID,
//   COMPUTER_USE_HISTORY_DIR: per-field overrides, which win over the profile.
//
// Profile keys: name, supportDir, bridgeSocket, envPrefix, agentCursorName,
// agentCursorBundleId, historyDir, nativeHostNames, extensionIds,
// nativeHostDescription. `name` alone moves every default path under that name.
//
// The Rust server (windows-linux/src/identity.rs) reads the same keys.

struct Identity {
    static let defaultName = "munim-computer-use"
    /// The macOS support directory predates the rename and keeps its name.
    static let defaultSupportDirName = "computer-use"
    static let defaultAgentCursorName = "MunimAgentCursor"
    /// TCC and Launch Services key on this; renaming it would revoke grants.
    static let defaultAgentCursorBundleId = "com.munimtech.computer-use.agent-cursor"
    static let defaultNativeHostNames = ["com.munim.mtcode.desktop", "com.munimtech.computer-use.desktop"]
    /// Pinned by the `key` in chrome-extension/manifest.json.
    static let defaultExtensionIds = ["kgdolgnijopbghhomnblabjkmjhnoage"]
    static let defaultNativeHostDescription = "Munim Computer Use browser bridge"

    static let knownKeys: Set<String> = [
        "name", "supportDir", "bridgeSocket", "envPrefix", "agentCursorName",
        "agentCursorBundleId", "historyDir", "nativeHostNames", "extensionIds",
        "nativeHostDescription",
    ]

    var name: String?
    var explicitSupportDir: String?
    var explicitBridgeSocket: String?
    var envPrefix: String?
    var agentCursorName = Identity.defaultAgentCursorName
    var agentCursorBundleId = Identity.defaultAgentCursorBundleId
    var historyDir: String?
    var nativeHostNames = Identity.defaultNativeHostNames
    var extensionIds = Identity.defaultExtensionIds
    var nativeHostDescription = Identity.defaultNativeHostDescription
    /// The fields actually set, so a native-host wrapper can replay them.
    var overrides: [String: Any] = [:]

    var isCustomized: Bool { !overrides.isEmpty }

    // MARK: resolution

    private static var resolved: Identity?

    /// The process identity; resolved from the environment alone if
    /// `bootstrap` was never called.
    static var current: Identity {
        if let resolved { return resolved }
        let identity: Identity
        do {
            identity = try resolve(profile: nil, env: ProcessInfo.processInfo.environment)
        } catch {
            fputs("munim-computer-use: \(error); using the default identity\n", stderr)
            identity = Identity()
        }
        resolved = identity
        return identity
    }

    /// Consume `--profile <value>` from the arguments, resolve the identity, and
    /// return the remaining arguments. Exits on a bad profile: running under the
    /// wrong identity would talk to another app's browser bridge.
    static func bootstrap(_ arguments: [String]) -> [String] {
        var rest: [String] = []
        var profile: String?
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--profile" {
                guard index + 1 < arguments.count else {
                    fputs("munim-computer-use: --profile needs a file path or a JSON object\n", stderr)
                    exit(2)
                }
                profile = arguments[index + 1]
                index += 2
                continue
            }
            if argument.hasPrefix("--profile=") {
                profile = String(argument.dropFirst("--profile=".count))
            } else {
                rest.append(argument)
            }
            index += 1
        }
        do {
            resolved = try resolve(profile: profile, env: ProcessInfo.processInfo.environment)
        } catch {
            fputs("munim-computer-use: \(error)\n", stderr)
            exit(2)
        }
        return rest
    }

    static func resolve(profile profileArgument: String?, env: [String: String]) throws -> Identity {
        var fields: [String: Any] = [:]
        if let profile = (profileArgument ?? env["COMPUTER_USE_PROFILE"]),
           !profile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            fields = try loadProfile(profile)
        }
        let overrides: [(String, String)] = [
            ("supportDir", "COMPUTER_USE_SUPPORT_DIR"),
            ("bridgeSocket", "COMPUTER_USE_BRIDGE_SOCKET"),
            ("envPrefix", "COMPUTER_USE_ENV_PREFIX"),
            ("agentCursorName", "COMPUTER_USE_AGENT_CURSOR_NAME"),
            ("agentCursorBundleId", "COMPUTER_USE_AGENT_CURSOR_BUNDLE_ID"),
            ("historyDir", "COMPUTER_USE_HISTORY_DIR"),
        ]
        for (key, variable) in overrides {
            if let value = env[variable], !value.isEmpty { fields[key] = value }
        }
        return try Identity(fields: fields)
    }

    init() {}

    init(fields: [String: Any]) throws {
        for (key, value) in fields {
            guard Identity.knownKeys.contains(key) else {
                // A newer embedder may pass keys this build does not know.
                fputs("munim-computer-use: ignoring unknown profile key \"\(key)\"\n", stderr)
                continue
            }
            switch key {
            case "nativeHostNames", "extensionIds":
                guard let list = value as? [String], !list.isEmpty, !list.contains(where: \.isEmpty) else {
                    throw IdentityError("profile key \"\(key)\" must be a non-empty array of strings")
                }
                if key == "nativeHostNames" {
                    if let bad = list.first(where: { !Identity.isValidHostName($0) }) {
                        throw IdentityError("invalid native-messaging host name \"\(bad)\"")
                    }
                    nativeHostNames = list
                } else {
                    extensionIds = list
                }
            default:
                guard let text = value as? String else {
                    throw IdentityError("profile key \"\(key)\" must be a string")
                }
                guard !text.isEmpty else { throw IdentityError("profile key \"\(key)\" must not be empty") }
                switch key {
                case "name":
                    guard Identity.isValidName(text) else {
                        throw IdentityError(
                            "profile name \"\(text)\" may only use letters, digits, '.', '_' and '-'")
                    }
                    name = text
                case "supportDir": explicitSupportDir = text
                case "bridgeSocket": explicitBridgeSocket = text
                case "envPrefix": envPrefix = text
                case "agentCursorName":
                    // Becomes a bundle and executable file name.
                    guard !text.contains("/") else {
                        throw IdentityError("agentCursorName must not contain '/'")
                    }
                    agentCursorName = text
                case "agentCursorBundleId": agentCursorBundleId = text
                case "historyDir": historyDir = text
                case "nativeHostDescription": nativeHostDescription = text
                default: break
                }
            }
            overrides[key] = value
        }
    }

    private static func loadProfile(_ value: String) throws -> [String: Any] {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let data: Data
        if trimmed.hasPrefix("{") {
            data = Data(trimmed.utf8)
        } else {
            guard let contents = FileManager.default.contents(atPath: trimmed) else {
                throw IdentityError("cannot read profile \"\(trimmed)\"")
            }
            data = contents
        }
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw IdentityError("profile is not valid JSON: \(error.localizedDescription)")
        }
        guard let object = parsed as? [String: Any] else {
            throw IdentityError("profile must be a JSON object")
        }
        return object
    }

    /// Used as a directory name, so no separators or spaces.
    static func isValidName(_ name: String) -> Bool {
        !name.hasPrefix(".")
            && name.unicodeScalars.allSatisfy {
                CharacterSet.alphanumerics.contains($0) && $0.isASCII || "._-".unicodeScalars.contains($0)
            }
    }

    /// Chrome's rule for native-messaging host names.
    static func isValidHostName(_ name: String) -> Bool {
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        return !name.isEmpty && parts.allSatisfy { part in
            !part.isEmpty && part.unicodeScalars.allSatisfy {
                ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "_"
            }
        }
    }

    // MARK: derived paths

    /// `~/Library/Application Support/<name>` (the standalone server keeps its
    /// pre-rename `computer-use`). Holds the bridge socket, the materialised
    /// overlay app of a bare build, and the native-host wrapper.
    var supportDirectory: URL {
        if let explicitSupportDir { return URL(fileURLWithPath: explicitSupportDir, isDirectory: true) }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent(name ?? Identity.defaultSupportDirName, isDirectory: true)
    }

    /// Short private fallback for when the support dir is unusable or nested too
    /// deep for sockaddr_un (~104 bytes). Never world-writable /tmp: another local
    /// user could claim that path. NSTemporaryDirectory() is per-user.
    var fallbackBridgeSocketPath: String {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(name ?? Identity.defaultName)-bridge.sock").path
    }

    /// Resolved absolute history root, when the profile names one.
    var historyDirectory: String? { historyDir }

    /// Read a tunable such as `AGENT_CURSOR`: `<envPrefix>AGENT_CURSOR` first,
    /// then `COMPUTER_USE_AGENT_CURSOR`.
    func tunable(_ suffix: String, env: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        if let envPrefix, !envPrefix.isEmpty, let value = env[envPrefix + suffix] {
            return value
        }
        return env["COMPUTER_USE_" + suffix]
    }

    /// For `munim-computer-use identity`.
    func describe() -> [String: Any] {
        var out: [String: Any] = [
            "supportDir": supportDirectory.path,
            "bridgeSocket": bridgeSocketPath,
            "agentCursorName": agentCursorName,
            "agentCursorBundleId": agentCursorBundleId,
            "nativeHostNames": nativeHostNames,
            "extensionIds": extensionIds,
            "nativeHostDescription": nativeHostDescription,
        ]
        out["name"] = name ?? NSNull()
        out["envPrefix"] = envPrefix ?? NSNull()
        out["historyDir"] = historyDir ?? NSNull()
        return out
    }
}

struct IdentityError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// MARK: - install-native-host

/// `munim-computer-use install-native-host [--binary <path>]`: register this
/// binary as Chrome's native-messaging host for the current identity.
///
/// Chrome starts the host itself and passes no arguments of ours, so each host
/// manifest points at a small wrapper that re-execs this binary in
/// `native-host` mode — with `--profile` when the identity is customised, so
/// the relay Chrome starts connects to the same bridge the MCP server binds.
enum NativeHostInstaller {
    static func run(_ arguments: [String]) -> Never {
        var binary = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
        if let path = Bundle.main.executablePath { binary = URL(fileURLWithPath: path).resolvingSymlinksInPath().path }
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--binary" where index + 1 < arguments.count:
                binary = arguments[index + 1]
                index += 2
            default:
                fputs("munim-computer-use: install-native-host: unknown option \(arguments[index])\n", stderr)
                exit(2)
            }
        }
        do {
            let report = try install(identity: Identity.current, binary: binary)
            if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .withoutEscapingSlashes]),
               let text = String(data: data, encoding: .utf8)
            {
                print(text)
            }
            if (report["registered"] as? [String])?.isEmpty ?? true {
                fputs("munim-computer-use: no Chrome or Chromium profile found to register with\n", stderr)
                exit(1)
            }
            exit(0)
        } catch {
            fputs("munim-computer-use: install-native-host failed: \(error)\n", stderr)
            exit(1)
        }
    }

    static func install(identity: Identity, binary: String) throws -> [String: Any] {
        let fm = FileManager.default
        let support = identity.supportDirectory
        try fm.createDirectory(at: support, withIntermediateDirectories: true)

        var profilePath: String?
        if identity.isCustomized {
            let url = support.appendingPathComponent("profile.json")
            let data = try JSONSerialization.data(
                withJSONObject: identity.overrides, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
            try writeIfChanged(url, data + Data("\n".utf8))
            profilePath = url.path
        }

        let wrapper = support.appendingPathComponent("native-host")
        try writeIfChanged(wrapper, Data(wrapperScript(binary: binary, profile: profilePath).utf8))
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)

        let origins = identity.extensionIds.map { "chrome-extension://\($0)/" }
        let home = fm.homeDirectoryForCurrentUser
        var registered: [String] = []
        for browser in ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium"] {
            let root = home.appendingPathComponent("Library/Application Support/\(browser)", isDirectory: true)
            var isDirectory: ObjCBool = false
            guard fm.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else { continue }
            let dir = root.appendingPathComponent("NativeMessagingHosts", isDirectory: true)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            for name in identity.nativeHostNames {
                let manifest: [String: Any] = [
                    "name": name,
                    "description": identity.nativeHostDescription,
                    "path": wrapper.path,
                    "type": "stdio",
                    "allowed_origins": origins,
                ]
                let data = try JSONSerialization.data(
                    withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
                try writeIfChanged(dir.appendingPathComponent("\(name).json"), data + Data("\n".utf8))
            }
            registered.append(root.path)
        }
        var report: [String: Any] = [
            "wrapper": wrapper.path,
            "hostNames": identity.nativeHostNames,
            "registered": registered,
        ]
        report["profile"] = profilePath ?? NSNull()
        return report
    }

    static func wrapperScript(binary: String, profile: String?) -> String {
        func quote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        var command = "exec \(quote(binary))"
        if let profile { command += " --profile \(quote(profile))" }
        return "#!/bin/sh\n\(command) native-host\n"
    }

    /// An app that registers on every launch should leave no trace when nothing changed.
    private static func writeIfChanged(_ url: URL, _ data: Data) throws {
        if FileManager.default.contents(atPath: url.path) == data { return }
        try data.write(to: url, options: .atomic)
    }
}

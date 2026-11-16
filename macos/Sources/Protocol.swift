import Foundation

// Which MCP protocol revision a request speaks, and what that changes.
//
// Revisions up to 2025-11-25 ("legacy") open with an `initialize` handshake
// and then send bare requests. From 2026-07-28 ("modern") there is no
// handshake: every request carries its protocol version and the client's
// capabilities in `params._meta`, every result carries `resultType`, and a
// client may probe with `server/discover`. This server is dual-era: a request
// with modern `_meta` is served statelessly under the modern rules, anything
// else exactly as before. Same rules and wording as the Rust server's
// protocol.rs; scripts/mcp-protocol.test.mjs checks both over stdio.

/// Revisions served per request, from `_meta`, newest first.
let modernProtocolVersions = ["2026-07-28"]
/// Revisions served after an `initialize` handshake, newest first.
let legacyProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
/// Answered to an `initialize` that asks for anything else, including older drafts.
let fallbackProtocolVersion = "2024-11-05"

let metaProtocolVersion = "io.modelcontextprotocol/protocolVersion"
let metaClientCapabilities = "io.modelcontextprotocol/clientCapabilities"
let metaServerInfo = "io.modelcontextprotocol/serverInfo"

/// How long a client may reuse a `tools/list` or `server/discover` answer: the
/// tool list is fixed for the life of the process.
let listTTLMilliseconds = 3_600_000

/// Every protocol revision this server speaks, newest first.
var supportedProtocolVersions: [String] { modernProtocolVersions + legacyProtocolVersions }

/// Echo the `initialize` request's protocol version when it is a legacy one we
/// speak, else fall back to the oldest, which every legacy client reads.
func negotiatedProtocolVersion(_ params: [String: Any]) -> String {
    if let requested = params["protocolVersion"] as? String, legacyProtocolVersions.contains(requested) {
        return requested
    }
    return fallbackProtocolVersion
}

enum ProtocolEra: Equatable {
    /// No per-request version: served as before, with or without `initialize`.
    case legacy
    /// The request declared this modern revision in its `_meta`.
    case modern(String)
}

/// A request that cannot be served under any revision.
struct ProtocolRefusal: Error {
    let code: Int
    let message: String
    let data: [String: Any]?
}

/// Decide which revision `method` with `params` is answered under. See
/// `classify` in the Rust server for the rules; the two must agree.
func classifyRequest(_ method: String, _ params: [String: Any]) -> Result<ProtocolEra, ProtocolRefusal> {
    if method == "initialize" { return .success(.legacy) }
    let meta = params["_meta"] as? [String: Any]
    guard let raw = meta?[metaProtocolVersion] else {
        if method == "server/discover" {
            return .failure(ProtocolRefusal(
                code: -32602,
                message: "server/discover needs _meta[\"\(metaProtocolVersion)\"] and _meta[\"\(metaClientCapabilities)\"]; "
                    + "this server supports \(supportedProtocolVersions.joined(separator: ", "))",
                data: nil))
        }
        return .success(.legacy)
    }
    guard let requested = raw as? String else {
        return .failure(ProtocolRefusal(
            code: -32602, message: "_meta[\"\(metaProtocolVersion)\"] must be a string", data: nil))
    }
    guard modernProtocolVersions.contains(requested) else {
        return .failure(ProtocolRefusal(
            code: -32022, message: "Unsupported protocol version",
            data: ["supported": supportedProtocolVersions, "requested": requested]))
    }
    guard meta?[metaClientCapabilities] is [String: Any] else {
        return .failure(ProtocolRefusal(
            code: -32602,
            message: "missing required _meta[\"\(metaClientCapabilities)\"] (an object; {} when the client declares none)",
            data: nil))
    }
    return .success(.modern(requested))
}

/// The modern envelope on a result: `resultType`, and the server naming
/// itself in `_meta`. Fields the result already has are kept.
func completeModernResult(_ result: [String: Any], serverInfo: [String: Any]) -> [String: Any] {
    var out = result
    if out["resultType"] == nil { out["resultType"] = "complete" }
    var meta = out["_meta"] as? [String: Any] ?? [:]
    if meta[metaServerInfo] == nil { meta[metaServerInfo] = serverInfo }
    out["_meta"] = meta
    return out
}

/// Mark a list result cacheable, as 2026-07-28 requires of `tools/list` and
/// `server/discover`. Private: the list depends on this machine's settings.
func cacheableResult(_ result: [String: Any]) -> [String: Any] {
    var out = result
    out["ttlMs"] = listTTLMilliseconds
    out["cacheScope"] = "private"
    return out
}

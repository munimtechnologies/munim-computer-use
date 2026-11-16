//! Which MCP protocol revision a request speaks, and what that changes.
//!
//! Revisions up to 2025-11-25 ("legacy") open with an `initialize` handshake
//! and then send bare requests. From 2026-07-28 ("modern") there is no
//! handshake: every request carries its protocol version and the client's
//! capabilities in `params._meta`, every result carries `resultType`, and a
//! client may probe with `server/discover`. This server is dual-era, as the
//! 2026-07-28 versioning rules allow: a request with modern `_meta` is served
//! statelessly under the modern rules, anything else exactly as before. The
//! tool surface is the same in both, so only the envelope differs.
//!
//! The macOS server implements the same rules in Swift (`Protocol.swift`), and
//! `scripts/mcp-protocol.test.mjs` checks both binaries over stdio.

use serde_json::{Map, Value, json};

/// Revisions served per request, from `_meta`, newest first.
pub const MODERN_PROTOCOL_VERSIONS: [&str; 1] = ["2026-07-28"];
/// Revisions served after an `initialize` handshake, newest first.
pub const LEGACY_PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// Answered to an `initialize` that asks for anything else, including older drafts.
pub const FALLBACK_PROTOCOL_VERSION: &str = "2024-11-05";

pub const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
pub const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

/// JSON-RPC "Invalid params": a modern request missing a required `_meta` field.
pub const INVALID_PARAMS: i64 = -32602;
/// The MCP `UnsupportedProtocolVersionError` code (2026-07-28 numbering).
pub const UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;

/// How long a client may reuse a `tools/list` or `server/discover` answer.
/// The tool list is fixed for the life of the process (the environment that
/// hides the browser tools is read at start), so an hour only bounds how long
/// a client keeps a list across a server upgrade it did not restart for.
pub const LIST_TTL_MS: u64 = 3_600_000;

/// Every protocol revision this server speaks, newest first.
pub fn supported_versions() -> Vec<&'static str> {
    MODERN_PROTOCOL_VERSIONS.iter().chain(LEGACY_PROTOCOL_VERSIONS.iter()).copied().collect()
}

/// Echo the `initialize` request's protocol version when it is a legacy one
/// we speak, else fall back to the oldest, which every legacy client reads.
pub fn negotiate_legacy_version(params: &Value) -> &'static str {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    LEGACY_PROTOCOL_VERSIONS
        .iter()
        .copied()
        .find(|version| Some(*version) == requested)
        .unwrap_or(FALLBACK_PROTOCOL_VERSION)
}

/// The revision rules one request is answered under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Era {
    /// No per-request version: the request is served as before, whether or not
    /// an `initialize` came first (clients that skip it have always worked).
    Legacy,
    /// The request declared this modern revision in its `_meta`.
    Modern(&'static str),
}

/// A request that cannot be served under any revision: answered with this
/// JSON-RPC error instead of a result.
#[derive(Clone, Debug, PartialEq)]
pub struct ProtocolError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl ProtocolError {
    fn invalid(message: impl Into<String>) -> Self {
        Self { code: INVALID_PARAMS, message: message.into(), data: None }
    }
}

/// Decide which revision `method` with `params` is answered under.
///
/// `initialize` always selects legacy semantics. A request whose `_meta`
/// names a protocol version is modern: the version must be one this server
/// implements (else `UnsupportedProtocolVersionError` listing the ones it
/// does), and the required client capabilities must be present (else Invalid
/// params). `server/discover` exists only in the modern revisions, so without
/// the version it is malformed too.
pub fn classify(method: &str, params: &Value) -> Result<Era, ProtocolError> {
    if method == "initialize" {
        return Ok(Era::Legacy);
    }
    let meta = params.get("_meta").and_then(Value::as_object);
    let Some(raw) = meta.and_then(|meta| meta.get(META_PROTOCOL_VERSION)) else {
        if method == "server/discover" {
            return Err(ProtocolError::invalid(format!(
                "server/discover needs _meta[\"{META_PROTOCOL_VERSION}\"] and _meta[\"{META_CLIENT_CAPABILITIES}\"]; \
                 this server supports {}",
                supported_versions().join(", ")
            )));
        }
        return Ok(Era::Legacy);
    };
    let Some(requested) = raw.as_str() else {
        return Err(ProtocolError::invalid(format!("_meta[\"{META_PROTOCOL_VERSION}\"] must be a string")));
    };
    let Some(version) = MODERN_PROTOCOL_VERSIONS.iter().copied().find(|version| *version == requested) else {
        return Err(ProtocolError {
            code: UNSUPPORTED_PROTOCOL_VERSION,
            message: "Unsupported protocol version".to_string(),
            data: Some(json!({ "supported": supported_versions(), "requested": requested })),
        });
    };
    if !meta.and_then(|meta| meta.get(META_CLIENT_CAPABILITIES)).is_some_and(Value::is_object) {
        return Err(ProtocolError::invalid(format!(
            "missing required _meta[\"{META_CLIENT_CAPABILITIES}\"] (an object; {{}} when the client declares none)"
        )));
    }
    Ok(Era::Modern(version))
}

/// The modern envelope on a result: `resultType`, and the server naming
/// itself in `_meta`, since there is no handshake that did. Fields the result
/// already has are kept.
pub fn complete_modern_result(mut result: Value, server_info: &Value) -> Value {
    if let Some(map) = result.as_object_mut() {
        map.entry("resultType").or_insert_with(|| json!("complete"));
        let meta = map.entry("_meta").or_insert_with(|| Value::Object(Map::new()));
        if let Some(meta) = meta.as_object_mut() {
            meta.entry(META_SERVER_INFO).or_insert_with(|| server_info.clone());
        }
    }
    result
}

/// Mark a list result cacheable, as 2026-07-28 requires of `tools/list` and
/// `server/discover`. Private: the list depends on this machine's settings.
pub fn cacheable(mut result: Value) -> Value {
    if let Some(map) = result.as_object_mut() {
        map.insert("ttlMs".into(), json!(LIST_TTL_MS));
        map.insert("cacheScope".into(), json!("private"));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modern(version: &str) -> Value {
        json!({ "_meta": {
            META_PROTOCOL_VERSION: version,
            META_CLIENT_CAPABILITIES: {},
            "io.modelcontextprotocol/clientInfo": { "name": "test", "version": "1" }
        } })
    }

    #[test]
    fn requests_without_meta_are_legacy_and_initialize_always_is() {
        assert_eq!(classify("tools/list", &json!({})), Ok(Era::Legacy));
        assert_eq!(classify("tools/call", &json!({ "name": "wait" })), Ok(Era::Legacy));
        assert_eq!(classify("initialize", &modern("2026-07-28")), Ok(Era::Legacy));
        assert_eq!(classify("tools/list", &json!({ "_meta": { "progressToken": 1 } })), Ok(Era::Legacy));
    }

    #[test]
    fn a_supported_modern_version_is_served_statelessly() {
        assert_eq!(classify("tools/list", &modern("2026-07-28")), Ok(Era::Modern("2026-07-28")));
        assert_eq!(classify("server/discover", &modern("2026-07-28")), Ok(Era::Modern("2026-07-28")));
    }

    #[test]
    fn an_unknown_version_is_refused_with_the_supported_list() {
        let error = classify("tools/list", &modern("1900-01-01")).unwrap_err();
        assert_eq!(error.code, -32022);
        assert_eq!(error.message, "Unsupported protocol version");
        let data = error.data.expect("data");
        assert_eq!(data["requested"], json!("1900-01-01"));
        assert_eq!(data["supported"][0], json!("2026-07-28"));
        assert!(data["supported"].as_array().unwrap().contains(&json!("2025-11-25")));
        // A legacy revision named per request is not a modern one.
        assert_eq!(classify("tools/list", &modern("2025-11-25")).unwrap_err().code, -32022);
    }

    #[test]
    fn missing_required_meta_is_invalid_params() {
        let no_caps = json!({ "_meta": { META_PROTOCOL_VERSION: "2026-07-28" } });
        assert_eq!(classify("tools/list", &no_caps).unwrap_err().code, -32602);
        let bad_version = json!({ "_meta": { META_PROTOCOL_VERSION: 20260728, META_CLIENT_CAPABILITIES: {} } });
        assert_eq!(classify("tools/list", &bad_version).unwrap_err().code, -32602);
        let error = classify("server/discover", &json!({})).unwrap_err();
        assert_eq!(error.code, -32602);
        assert!(error.message.contains("2026-07-28"), "names what it supports: {}", error.message);
    }

    #[test]
    fn legacy_negotiation_echoes_only_legacy_versions() {
        for version in LEGACY_PROTOCOL_VERSIONS {
            assert_eq!(negotiate_legacy_version(&json!({ "protocolVersion": version })), version);
        }
        assert_eq!(negotiate_legacy_version(&json!({ "protocolVersion": "2026-07-28" })), "2024-11-05");
        assert_eq!(negotiate_legacy_version(&json!({})), "2024-11-05");
    }

    #[test]
    fn modern_results_carry_result_type_and_server_info() {
        let info = json!({ "name": "mt-desktop", "version": "1" });
        let result = complete_modern_result(json!({ "content": [], "isError": false }), &info);
        assert_eq!(result["resultType"], json!("complete"));
        assert_eq!(result["_meta"][META_SERVER_INFO], info);
        let listed = cacheable(json!({ "tools": [] }));
        assert_eq!(listed["ttlMs"], json!(LIST_TTL_MS));
        assert_eq!(listed["cacheScope"], json!("private"));
    }
}

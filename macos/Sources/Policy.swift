import AppKit
import Foundation

// The user's Computer Use policy: which apps and sites the agent may use.
//
// A JSON file — COMPUTER_USE_POLICY if set, else policy.json in the support
// directory — shaped like
//
//   { "apps":  { "Keychain Access": "block", "com.apple.MobileSMS": "ask" },
//     "sites": { "bank.example": "block", "mail.google.com": "ask", "*": "allow" } }
//
// Each rule is allow, ask (the user approves once per server process) or
// block. Apps match their name or bundle id exactly, ignoring case; sites match
// a host and its subdomains, and the most specific pattern wins. "*" sets the
// default, which is otherwise allow. The file is re-read whenever it changes.
//
// Site rules are enforced by the Chrome extension, which knows what page a tab
// is on at the moment of the action; this side only forwards them. A file that
// does not parse blocks everything it could have covered rather than being
// ignored: a typo must not quietly turn a block into an allow. Same format and
// behaviour as windows-linux/src/policy.rs.

enum PolicyRule: String {
    case allow, ask, block
}

struct Policy {
    var apps: [(pattern: String, rule: PolicyRule)] = []
    var sites: [(pattern: String, rule: PolicyRule)] = []
    /// Why the file could not be used, when it exists but is not valid.
    var error: String?

    static func parse(_ data: Data) -> Result<Policy, String> {
        guard let root = try? JSONSerialization.jsonObject(with: data) else {
            return .failure("not valid JSON")
        }
        guard let object = root as? [String: Any] else {
            return .failure("the top level must be an object with \"apps\" and/or \"sites\"")
        }
        var policy = Policy()
        for key in ["apps", "sites"] {
            guard let value = object[key], !(value is NSNull) else { continue }
            guard let map = value as? [String: Any] else {
                return .failure("\"\(key)\" must be an object of pattern → rule")
            }
            var rules: [(pattern: String, rule: PolicyRule)] = []
            for (pattern, raw) in map {
                guard let text = raw as? String,
                      let rule = PolicyRule(rawValue: text.trimmingCharacters(in: .whitespaces).lowercased())
                else {
                    return .failure("\"\(key)\".\"\(pattern)\" must be \"allow\", \"ask\" or \"block\"")
                }
                rules.append((pattern.trimmingCharacters(in: .whitespaces).lowercased(), rule))
            }
            if key == "apps" { policy.apps = rules } else { policy.sites = rules }
        }
        return .success(policy)
    }

    /// The rule for an app, matched on its name or bundle id.
    func appRule(name: String, id: String) -> PolicyRule {
        if error != nil { return .block }
        let name = name.lowercased(), id = id.lowercased()
        if let exact = apps.first(where: { $0.pattern != "*" && ($0.pattern == name || $0.pattern == id) }) {
            return exact.rule
        }
        return apps.first(where: { $0.pattern == "*" })?.rule ?? .allow
    }

    var hasAppRules: Bool { !apps.isEmpty || error != nil }
    var hasSiteRules: Bool { !sites.isEmpty }
    var sitesAsk: Bool { sites.contains { $0.rule == .ask } }
    var sitesPayload: [[String: String]] { sites.map { ["pattern": $0.pattern, "rule": $0.rule.rawValue] } }
}

enum PolicyStore {
    private static let lock = NSLock()
    private static var cachedPath: String?
    private static var cachedStamp: (Date, Int)?
    private static var cached = Policy()
    private static var approved: Set<String> = []

    static var path: String? {
        if let explicit = Identity.current.tunable("POLICY"), !explicit.trimmingCharacters(in: .whitespaces).isEmpty {
            return explicit
        }
        return Identity.current.supportDirectory.appendingPathComponent("policy.json").path
    }

    /// The current policy, re-read only when the file's path, size or mtime moved.
    static func current() -> Policy {
        lock.lock()
        defer { lock.unlock() }
        let path = self.path
        let attributes = path.flatMap { try? FileManager.default.attributesOfItem(atPath: $0) }
        let stamp = attributes.map {
            (($0[.modificationDate] as? Date) ?? .distantPast, ($0[.size] as? NSNumber)?.intValue ?? 0)
        }
        if path == cachedPath, stamp?.0 == cachedStamp?.0, stamp?.1 == cachedStamp?.1 { return cached }
        var policy = Policy()
        if let path, stamp != nil {
            if let data = FileManager.default.contents(atPath: path) {
                switch Policy.parse(data) {
                case .success(let parsed): policy = parsed
                case .failure(let reason):
                    policy.error = "the Computer Use policy file \(path) is invalid: \(reason)"
                }
            } else {
                policy.error = "the Computer Use policy file \(path) cannot be read"
            }
        }
        cachedPath = path
        cachedStamp = stamp
        cached = policy
        return policy
    }

    /// nil when the app may be used; otherwise the error line for the model.
    static func checkApp(_ app: NSRunningApplication) -> String? {
        let policy = current()
        guard policy.hasAppRules else { return nil }
        if let error = policy.error { return "error: \(error) — fix it before using apps" }
        let name = app.localizedName ?? "this app"
        let id = app.bundleIdentifier ?? name
        switch policy.appRule(name: name, id: id) {
        case .allow:
            return nil
        case .block:
            return "error: \(name) is blocked by the user's Computer Use policy — do not try to reach it another way"
        case .ask:
            let key = id.lowercased()
            lock.lock()
            let known = approved.contains(key)
            lock.unlock()
            if known { return nil }
            guard confirm(name: name) else { return "error: the user declined to let the agent use \(name)" }
            lock.lock()
            approved.insert(key)
            lock.unlock()
            return nil
        }
    }

    /// Seconds an approval prompt waits before counting as a refusal.
    static let promptTimeout: TimeInterval = 120

    private static func confirm(name: String) -> Bool {
        DispatchQueue.main.sync {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Let the agent use \(name)?"
            alert.informativeText = "Your Computer Use policy asks before the agent reads or controls this app. "
                + "Allowing it lasts until this agent session ends."
            alert.addButton(withTitle: "Allow")
            alert.addButton(withTitle: "Don't Allow")
            // An unanswered prompt counts as "no" rather than stalling the server.
            let timer = Timer(timeInterval: promptTimeout, repeats: false) { _ in NSApp.abortModal() }
            RunLoop.main.add(timer, forMode: .modalPanel)
            defer { timer.invalidate() }
            return alert.runModal() == .alertFirstButtonReturn
        }
    }
}

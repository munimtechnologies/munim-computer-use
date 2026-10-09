import AppKit
import ApplicationServices

// MARK: - Command shortcuts in the background
//
// A Command shortcut is a menu key equivalent, and macOS gives those only to the
// front app: posted to a background app, cmd+W or cmd+S does nothing. The menu
// bar names the same command with its shortcut, and accessibility can press a
// menu item without opening the menu or raising the app, so a shortcut for a
// background app runs through its menu instead.

enum MenuShortcut {
    // AXMenuItemCmdModifiers bits. Command is implied unless noCommand is set.
    static let shift = 1, option = 2, control = 4, noCommand = 8
    static let maxDepth = 6

    /// The characters a menu stores for a key name: printable keys as their
    /// uppercase character, special keys as control characters or AppKit's
    /// private-use function-key characters.
    static func menuCharacters(_ key: String) -> Set<String> {
        let lowered = key.lowercased()
        let named: [String: [UInt32]] = [
            "return": [0x0D, 0x03], "enter": [0x0D, 0x03], "tab": [0x09], "space": [0x20], "spacebar": [0x20],
            "delete": [0x08, 0x7F], "backspace": [0x08, 0x7F], "del": [0x08, 0x7F],
            "forwarddelete": [0xF728], "fwddelete": [0xF728], "deleteforward": [0xF728],
            "escape": [0x1B], "esc": [0x1B],
            "up": [0xF700], "uparrow": [0xF700], "arrowup": [0xF700],
            "down": [0xF701], "downarrow": [0xF701], "arrowdown": [0xF701],
            "left": [0xF702], "leftarrow": [0xF702], "arrowleft": [0xF702],
            "right": [0xF703], "rightarrow": [0xF703], "arrowright": [0xF703],
            "home": [0xF729], "end": [0xF72B], "pageup": [0xF72C], "pgup": [0xF72C],
            "pagedown": [0xF72D], "pgdn": [0xF72D], "pgdown": [0xF72D],
        ]
        if let codes = named[lowered] {
            return Set(codes.compactMap { UnicodeScalar($0).map { String(Character($0)) } })
        }
        if lowered.hasPrefix("f"), let n = Int(lowered.dropFirst()), (1...20).contains(n),
           let scalar = UnicodeScalar(0xF704 + UInt32(n - 1))
        {
            return [String(Character(scalar))]
        }
        if let character = punctuationNames[lowered] { return [String(character)] }
        if key.count == 1 { return [key.uppercased()] }
        return []
    }

    /// Press the menu item whose shortcut is `key` with `modifiers`. Returns the
    /// item's path ("File > Close") when one was pressed, nil when the app's menu
    /// has no such shortcut.
    static func press(pid: pid_t, key: String, modifiers: [String]) -> String? {
        let mods = Set(modifiers.map { $0.lowercased() })
        guard mods.contains("cmd") || mods.contains("command") else { return nil }
        let chars = menuCharacters(key)
        guard !chars.isEmpty else { return nil }
        var bits = 0
        if mods.contains("shift") { bits |= shift }
        if mods.contains("alt") || mods.contains("option") { bits |= option }
        if mods.contains("ctrl") || mods.contains("control") { bits |= control }

        let app = AXUIElementCreateApplication(pid)
        guard let bar = axElement(app, kAXMenuBarAttribute as String) else { return nil }
        // The first menu bar item is the Apple menu, which belongs to the system.
        for item in axChildren(bar).dropFirst() {
            guard let title = axString(item, kAXTitleAttribute as String) else { continue }
            if let path = find(in: item, path: [title], depth: 1, chars: chars, bits: bits) {
                return path.joined(separator: " > ")
            }
        }
        return nil
    }

    private static let itemAttributes = [
        kAXRoleAttribute, kAXTitleAttribute, "AXMenuItemCmdChar", "AXMenuItemCmdModifiers", kAXChildrenAttribute,
    ]

    private static func find(in element: AXUIElement, path: [String], depth: Int,
                             chars: Set<String>, bits: Int) -> [String]? {
        guard depth <= maxDepth else { return nil }
        for child in axChildren(element) {
            let v = axCopyMultiple(child, itemAttributes) ?? itemAttributes.map { axCopy(child, $0) }
            let role = v[0] as? String
            let children = (v[4] as? [AXUIElement]) ?? []
            if role == "AXMenu" {
                if let found = find(in: child, path: path, depth: depth + 1, chars: chars, bits: bits) {
                    return found
                }
                continue
            }
            guard role == "AXMenuItem", let title = v[1] as? String, !title.isEmpty else { continue }
            if !children.isEmpty {
                if let found = find(in: child, path: path + [title], depth: depth + 1, chars: chars, bits: bits) {
                    return found
                }
                continue
            }
            guard let char = v[2] as? String, chars.contains(char.uppercased()) || chars.contains(char),
                  ((v[3] as? NSNumber)?.intValue ?? 0) == bits
            else { continue }
            // Pressed even when it reads as disabled: AppKit updates an item's
            // enabled state only when its menu is about to open, so a menu never
            // opened can report an available command as disabled. Pressing one
            // that really is disabled does nothing.
            guard AXUIElementPerformAction(child, kAXPressAction as CFString) == .success else { return nil }
            return path + [title]
        }
        return nil
    }
}

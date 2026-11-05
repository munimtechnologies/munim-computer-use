import Darwin
import Foundation

// Every MCP server runs from its own executable path.
//
// ScreenCaptureKit is a client of replayd, and replayd keeps one connection per
// client. A bare (unbundled) binary is identified by its executable path
// (replayd logs "uniqueClientIdentifierWithPID: using identifier from
// executablePath"), so two servers started from the same file are the same
// client to it. Their connections then evict each other: replayd cancels the
// older one, ReplayKit in that process reconnects at once from its interruption
// handler, which evicts the newer one, and so on. Seen on 2026-11-05 with three
// sessions' servers: ~2,000 reconnects a second each, replayd at 150% CPU, and
// every capture in all of them timing out after 20 s, for as long as two of the
// processes lived. That is the normal setup, not a corner case: one npx cache
// path, or one copy inside an app bundle, serves every agent session.
//
// So the server re-executes itself from a clone at
// `<supportDir>/exec/<pid>/<binary name>`: same bytes and signature, and on
// APFS no extra disk space, but a path of its own, so replayd sees one client
// per process. Not a hard link: links share one vnode, and the kernel reports
// whichever name it last looked the vnode up by, so every server would still
// show the same path.
// argv is passed through unchanged, so argv[0] still names the installed binary
// for everything that looks for files beside it (the cursor overlay app).
enum PrivateExecutable {
    /// Set across the exec so the new image knows it already runs from its copy.
    private static let copyKey = "MUNIM_COMPUTER_USE_EXEC_COPY"
    /// `1` skips the re-exec, for debugging or a host that forbids it.
    private static let optOutKey = "MUNIM_COMPUTER_USE_SHARED_EXECUTABLE"

    private static let lock = NSLock()
    private static var copyDirectory: URL?

    /// Re-executes the server from a private copy, or returns when that is
    /// already done, not needed, or not possible (the server then runs as is).
    static func adopt() {
        let env = ProcessInfo.processInfo.environment
        if let copy = env[copyKey] {
            unsetenv(copyKey)
            lock.withLock { copyDirectory = URL(fileURLWithPath: copy).deletingLastPathComponent() }
            return
        }
        if env[optOutKey] == "1" { return }
        // A bundled executable is identified by its bundle id, not its path, and
        // moving it out of the bundle would lose Bundle.main.
        if Bundle.main.bundleIdentifier != nil { return }
        guard let binary = currentExecutablePath() else { return }

        let root = Identity.current.supportDirectory.appendingPathComponent("exec", isDirectory: true)
        sweepStale(root)
        let directory = root.appendingPathComponent(String(getpid()), isDirectory: true)
        let copy = directory.appendingPathComponent(URL(fileURLWithPath: binary).lastPathComponent)
        let fm = FileManager.default
        try? fm.removeItem(at: directory)
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            fputs("munim-computer-use: could not create \(directory.path) (\(error.localizedDescription)); "
                + "running from the shared path\n", stderr)
            return
        }
        // A clone shares the original's blocks; across volumes, or off APFS,
        // COPYFILE_CLONE falls back to a full copy. The signature travels with
        // the file either way.
        if copyfile(binary, copy.path, nil, copyfile_flags_t(COPYFILE_ALL | COPYFILE_CLONE)) != 0 {
            fputs("munim-computer-use: could not copy the binary into \(directory.path) "
                + "(\(String(cString: strerror(errno)))); running from the shared path\n", stderr)
            try? fm.removeItem(at: directory)
            return
        }
        setenv(copyKey, copy.path, 1)
        execv(copy.path, CommandLine.unsafeArgv)
        // Only reached when exec failed.
        let execErrno = errno
        unsetenv(copyKey)
        try? fm.removeItem(at: directory)
        fputs("munim-computer-use: could not re-exec from \(copy.path) "
            + "(\(String(cString: strerror(execErrno)))); running from the shared path\n", stderr)
    }

    /// Removes this process's copy. Called on the way out; a killed process's
    /// copy is swept by the next server that starts.
    static func removeLink() {
        guard let directory = lock.withLock({ () -> URL? in
            defer { copyDirectory = nil }
            return copyDirectory
        }) else { return }
        try? FileManager.default.removeItem(at: directory)
    }

    /// Drops copies left by servers that are gone. A directory is named after
    /// its server's pid; one whose pid no longer exists is stale.
    private static func sweepStale(_ root: URL) {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
        for entry in entries {
            guard let pid = pid_t(entry), pid > 0, pid != getpid() else { continue }
            if kill(pid, 0) == -1 && errno == ESRCH {
                try? FileManager.default.removeItem(at: root.appendingPathComponent(entry, isDirectory: true))
            }
        }
    }

    private static func currentExecutablePath() -> String? {
        var size: UInt32 = 0
        _ = _NSGetExecutablePath(nil, &size)
        var buffer = [CChar](repeating: 0, count: Int(size) + 1)
        guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
        guard let resolved = realpath(buffer, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

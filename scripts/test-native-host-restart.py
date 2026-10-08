#!/usr/bin/env python
"""Isolated Windows native-host regression tests; Python standard library only.

Usage: python scripts/test-native-host-restart.py --binary PATH
No Chrome, MCP backend, registry, or live bridge is touched. Each scenario owns
one random Win32 byte-mode pipe and only its own native-host child processes.
The installed v0.6.0 must fail backend EOF and automatic restart lifecycle tests.
"""
import argparse
import ctypes
from ctypes import wintypes
from collections import deque
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import threading
import time
import uuid

IO_TIMEOUT = 3.0
EXIT_TIMEOUT = 3.0
MAX_BYTES = 1024 * 1024
KERNEL = None


def configure_win32():
    global KERNEL
    KERNEL = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateNamedPipeW": ([wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                              wintypes.DWORD, wintypes.LPVOID], wintypes.HANDLE),
        "ConnectNamedPipe": ([wintypes.HANDLE, wintypes.LPVOID], wintypes.BOOL),
        "DisconnectNamedPipe": ([wintypes.HANDLE], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        "ReadFile": ([wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                      ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID], wintypes.BOOL),
        "WriteFile": ([wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD,
                       ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID], wintypes.BOOL),
    }
    for name, (args, result) in signatures.items():
        function = getattr(KERNEL, name)
        function.argtypes = args
        function.restype = result


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def bounded_call(function, label):
    """Bound anonymous-pipe writes too, even if an executable misbehaves."""
    result = queue.Queue(maxsize=1)

    def worker():
        try:
            result.put((True, function()), timeout=0.1)
        except Exception as error:
            try:
                result.put((False, error), timeout=0.1)
            except queue.Full:
                pass

    thread = threading.Thread(target=worker, name=label, daemon=True)
    thread.start()
    try:
        ok, value = result.get(timeout=IO_TIMEOUT)
    except queue.Empty:
        raise AssertionError(label + " timed out") from None
    thread.join(timeout=0.1)
    if not ok:
        raise value
    return value


class FakeBackend:
    """PIPE_NOWAIT keeps every Win32 operation and all cleanup nonblocking."""
    def __init__(self, name):
        self.name = name
        self.buffer = bytearray()
        # Duplex, first-instance guard; byte type/read mode; nonblocking server.
        self.handle = KERNEL.CreateNamedPipeW(
            "\\\\.\\pipe\\" + name, 0x00000003 | 0x00080000,
            0x00000001 | 0x00000008, 1, 65536, 65536, 0, None)
        if self.handle == wintypes.HANDLE(-1).value:
            self.handle = None
            raise ctypes.WinError(ctypes.get_last_error())

    def accept(self, host):
        deadline = time.monotonic() + IO_TIMEOUT
        while time.monotonic() < deadline:
            if KERNEL.ConnectNamedPipe(self.handle, None):
                return
            error = ctypes.get_last_error()
            if error == 535:  # ERROR_PIPE_CONNECTED
                return
            if error not in (232, 536):  # NO_DATA, PIPE_LISTENING
                raise ctypes.WinError(error)
            require(host.process.poll() is None,
                    "native host exited before isolated pipe connected")
            time.sleep(0.01)
        raise AssertionError("isolated pipe connection timed out")

    def write(self, data):
        deadline = time.monotonic() + IO_TIMEOUT
        offset = 0
        while offset < len(data) and time.monotonic() < deadline:
            part = data[offset:]
            buffer = ctypes.create_string_buffer(part)
            count = wintypes.DWORD()
            if not KERNEL.WriteFile(self.handle, buffer, len(part),
                                    ctypes.byref(count), None):
                raise ctypes.WinError(ctypes.get_last_error())
            offset += count.value
            if count.value == 0:
                time.sleep(0.01)
        require(offset == len(data), "fake backend write timed out")

    def line(self):
        deadline = time.monotonic() + IO_TIMEOUT
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                line, _, remaining = self.buffer.partition(b"\n")
                self.buffer = bytearray(remaining)
                return bytes(line)
            buffer = ctypes.create_string_buffer(4096)
            count = wintypes.DWORD()
            ok = KERNEL.ReadFile(self.handle, buffer, len(buffer),
                                 ctypes.byref(count), None)
            if ok and count.value:
                self.buffer.extend(buffer.raw[:count.value])
                require(len(self.buffer) <= MAX_BYTES, "backend output exceeded limit")
            elif not ok and ctypes.get_last_error() != 232:
                raise ctypes.WinError(ctypes.get_last_error())
            else:
                time.sleep(0.01)
        raise AssertionError("Chrome-to-backend newline message timed out")

    def close(self):
        if self.handle is None:
            return
        handle, self.handle = self.handle, None
        disconnected = KERNEL.DisconnectNamedPipe(handle)
        error = ctypes.get_last_error() if not disconnected else 0
        closed = KERNEL.CloseHandle(handle)
        close_error = ctypes.get_last_error() if not closed else 0
        if error not in (0, 233):  # already disconnected is harmless
            raise ctypes.WinError(error)
        if close_error:
            raise ctypes.WinError(close_error)


class NativeHost:
    def __init__(self, binary, name):
        environment = dict(os.environ, COMPUTER_USE_BRIDGE_SOCKET=name)
        self.process = subprocess.Popen(
            [str(binary), "native-host"], env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0)
        self.output = queue.Queue(maxsize=64)
        self.buffer = bytearray()
        self.stderr = deque(maxlen=16)
        self.stop = threading.Event()
        self.threads = []
        for stream, kind in ((self.process.stdout, "stdout"),
                             (self.process.stderr, "stderr")):
            thread = threading.Thread(target=self._reader, args=(stream, kind),
                                      name="native-host-" + kind, daemon=True)
            self.threads.append(thread)
            thread.start()

    def _reader(self, stream, kind):
        try:
            while not self.stop.is_set():
                data = os.read(stream.fileno(), 4096)
                if kind == "stderr":
                    if not data:
                        return
                    self.stderr.append(data)
                else:
                    try:
                        self.output.put(data, timeout=0.1)
                    except queue.Full:
                        return
                    if not data:
                        return
        except (OSError, ValueError):
            return

    def send(self, payloads):
        frames = b"".join(struct.pack("=I", len(body)) + body for body in payloads)

        def write():
            # Deliberately split the first header/body across writes. Multiple
            # frames in the remainder also exercise back-to-back native frames.
            for part in (frames[:2], frames[2:5], frames[5:]):
                view = memoryview(part)
                while view:
                    sent = os.write(self.process.stdin.fileno(), view)
                    require(sent > 0, "Chrome stdin write made no progress")
                    view = view[sent:]

        bounded_call(write, "Chrome stdin write")

    def frame(self):
        deadline = time.monotonic() + IO_TIMEOUT
        while True:
            if len(self.buffer) >= 4:
                length = struct.unpack("=I", self.buffer[:4])[0]
                require(0 < length <= MAX_BYTES, "invalid native stdout frame length")
                if len(self.buffer) >= 4 + length:
                    body = bytes(self.buffer[4:4 + length])
                    del self.buffer[:4 + length]
                    # Validate UTF-8 and JSON, including Unicode byte lengths.
                    json.loads(body.decode("utf-8"))
                    return body
            remaining = deadline - time.monotonic()
            require(remaining > 0, "backend-to-Chrome native frame timed out")
            try:
                data = self.output.get(timeout=remaining)
            except queue.Empty:
                raise AssertionError("backend-to-Chrome native frame timed out") from None
            require(data, "native stdout EOF before complete frame")
            self.buffer.extend(data)
            require(len(self.buffer) <= MAX_BYTES + 4096, "native output exceeded limit")

    def wait_exit(self, label):
        start = time.monotonic()
        try:
            code = self.process.wait(timeout=EXIT_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise AssertionError(
                f"{label}: host still alive after {EXIT_TIMEOUT:.3f}s; "
                f"Chrome stdin open={not self.process.stdin.closed}") from None
        elapsed = time.monotonic() - start
        require(elapsed <= EXIT_TIMEOUT,
                f"{label}: exit observed after {elapsed:.3f}s (>3.000s)")
        require(code == 0, f"{label}: unexpected exit code {code}")
        return elapsed

    def close_stdin(self):
        bounded_call(self.process.stdin.close, "Chrome stdin close")

    def close(self):
        self.stop.set()
        # Kill only this fixture's process. Do not wait on a pipe reader or flush
        # stdin before killing: either can be blocked by a broken executable.
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=2.0)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()
        for thread in self.threads:
            thread.join(timeout=0.25)
        require(not any(thread.is_alive() for thread in self.threads),
                "fixture output reader failed to stop after child exit")


class Scenario:
    def __init__(self, binary, name=None):
        self.binary = binary
        self.name = name or "munim-regression-" + uuid.uuid4().hex
        self.backend = FakeBackend(self.name)
        self.host = None

    def __enter__(self):
        try:
            self.host = NativeHost(self.binary, self.name)
            self.backend.accept(self.host)
            return self
        except BaseException:
            self.__exit__(*sys.exc_info())
            raise

    def __exit__(self, error_type, error, traceback):
        cleanup_errors = []
        for close in (self.backend.close,
                      self.host.close if self.host is not None else lambda: None):
            try:
                close()
            except Exception as problem:
                cleanup_errors.append(str(problem))
        if cleanup_errors:
            raise RuntimeError("fixture cleanup failed: " + "; ".join(cleanup_errors)) from error

    def exchange(self, generation):
        messages = [
            {"id": 1, "generation": generation, "text": "UTF-8: café 雪 🧪"},
            {"id": 2, "ok": True, "nested": {"text": "escaped\nnewline"}},
        ]
        bodies = [json.dumps(message, ensure_ascii=False,
                             separators=(",", ":")).encode("utf-8")
                  for message in messages]
        self.host.send(bodies)
        for body in bodies:
            require(self.backend.line() == body,
                    "Chrome-to-backend bytes/newline framing mismatch")
        # Fragment backend input; combine two newline-delimited messages.
        lines = b"\n".join(reversed(bodies)) + b"\n"
        self.backend.write(lines[:7])
        self.backend.write(lines[7:])
        for body in reversed(bodies):
            require(self.host.frame() == body,
                    "backend-to-Chrome bytes/native-endian framing mismatch")


def test_framing(binary):
    with Scenario(binary) as scenario:
        scenario.exchange("framing")
    return "two UTF-8 JSON messages in each direction; fragmented and consecutive frames"


def test_backend_eof(binary):
    with Scenario(binary) as scenario:
        scenario.exchange("before-eof")
        require(not scenario.host.process.stdin.closed, "Chrome stdin closed prematurely")
        scenario.backend.close()
        elapsed = scenario.host.wait_exit("backend EOF")
        require(not scenario.host.process.stdin.closed, "Chrome stdin closed during EOF test")
    return f"backend EOF exits in {elapsed:.3f}s with Chrome stdin still open"


def test_chrome_eof(binary):
    with Scenario(binary) as scenario:
        scenario.exchange("chrome-close")
        scenario.host.close_stdin()
        elapsed = scenario.host.wait_exit("Chrome stdin EOF")
    return f"Chrome stdin EOF exits in {elapsed:.3f}s with backend still open"


def test_restart(binary):
    name = "munim-regression-" + uuid.uuid4().hex
    lifecycle_error = None
    with Scenario(binary, name) as original:
        original.exchange("original")
        original.backend.close()
        try:
            original.host.wait_exit("restart backend EOF")
        except AssertionError as error:
            lifecycle_error = str(error)
        # Even on RED, exercise replacement routing independently. Fixture
        # cleanup kills a stuck old child; this is never accepted as a pass.
    with Scenario(binary, name) as replacement:
        replacement.exchange("replacement")
        replacement.host.close_stdin()
        replacement.host.wait_exit("replacement Chrome stdin EOF")
    require(lifecycle_error is None,
            "replacement connected and exchanged frames on same pipe, but automatic "
            "restart failed: " + str(lifecycle_error))
    return "old host exits on backend EOF; replacement host/backend reuse same pipe and exchange frames"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True,
                        help="Munim executable to invoke with native-host")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("these isolated Win32 pipe tests require Windows")
    if not args.binary.is_file():
        parser.error("--binary must name an existing executable")
    configure_win32()
    tests = [test_framing, test_backend_eof, test_chrome_eof, test_restart]
    failures = 0
    print("Binary: " + str(args.binary.resolve()), flush=True)
    print("Isolation: random munim-regression-* pipes; no Chrome or live backend", flush=True)
    for test in tests:
        try:
            detail = test(args.binary.resolve())
        except Exception as error:
            failures += 1
            print(f"FAIL {test.__name__}: {type(error).__name__}: {error}", flush=True)
        else:
            print(f"PASS {test.__name__}: {detail}", flush=True)
    print(f"RESULT: {len(tests)} tests, {len(tests) - failures} passed, "
          f"{failures} failed", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

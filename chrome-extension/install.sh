#!/bin/sh
# Register the native messaging host so Chrome can reach the desktop server.
#
# The server registers itself (`munim-computer-use install-native-host`): it
# writes a small wrapper that Chrome runs in host mode, and a host manifest for
# each of its identity's host names in every Chrome/Chromium profile directory.
# This script only finds a checkout's build. The extension id is pinned by the
# "key" in manifest.json, which is why this can run before the extension is
# ever loaded.
#
# The standalone server's own host is com.munimtech.computer_use.desktop. It
# also registers com.munim.mtcode.desktop for extensions from before 0.4.4, but
# only when no other app (MT Code) already owns that name.
set -eu

EXTENSION_ID="kgdolgnijopbghhomnblabjkmjhnoage"

here=$(cd "$(dirname "$0")" && pwd)
# macOS builds the Swift package; Linux builds the Rust crate that also covers
# Windows. Either way the binary is called munim-computer-use.
default_binary=""
case "$(uname -s)" in
  Darwin)
    for candidate in \
      "$here/../macos/.build/out/Products/Release/munim-computer-use" \
      "$here/../macos/.build/apple/Products/Release/munim-computer-use" \
      "$here/../macos/.build/release/munim-computer-use"; do
      if [ -x "$candidate" ]; then
        default_binary="$candidate"
        break
      fi
    done
    ;;
  *)      default_binary="$here/../windows-linux/target/release/munim-computer-use" ;;
esac
binary="${COMPUTER_USE_PATH:-$default_binary}"
if [ -z "$binary" ] || [ ! -x "$binary" ]; then
  echo "desktop server binary not found at: ${binary:-macos/.build}" >&2
  echo "build it first (see README), or point COMPUTER_USE_PATH at it" >&2
  exit 1
fi
binary=$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")

"$binary" install-native-host --binary "$binary"

echo
echo "Next, load the extension once:"
echo "  1. open  chrome://extensions"
echo "  2. turn on Developer mode"
echo "  3. Load unpacked  ->  $here"
echo
echo "It should appear with id $EXTENSION_ID."

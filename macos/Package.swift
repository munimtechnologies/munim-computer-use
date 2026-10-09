// swift-tools-version:5.9
import PackageDescription

// Desktop control MCP server. macOS only: it talks to the Accessibility API,
// which has no counterpart on other platforms, so the build is gated on darwin
// by the desktop artifact script rather than by a runtime check here.
let package = Package(
  name: "munim-computer-use",
  // macOS 14 for SCScreenshotManager, which replaces the deprecated
  // CGWindowListCreateImage path for window capture.
  platforms: [.macOS(.v14)],
  targets: [
    // Private CoreGraphics API for the invisible display that background
    // control parks minimized and hidden windows on. Objective-C, so ARC
    // handles the private classes' init family.
    .target(
      name: "VirtualDisplay",
      path: "VirtualDisplay",
    ),
    .executableTarget(
      name: "munim-computer-use",
      dependencies: ["VirtualDisplay"],
      path: "Sources",
    ),
  ],
)

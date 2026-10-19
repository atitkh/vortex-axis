// swift-tools-version:5.9
// The VorteX Axis desktop app for macOS. `swift build` builds it; scripts/build-mac.sh wraps it into an .app.
import PackageDescription

let package = Package(
    name: "VortexAxisMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "VortexAxisMac", targets: ["VortexAxisMac"]),
        .library(name: "AxisDesktopCore", targets: ["AxisDesktopCore"]),
    ],
    targets: [
        // Foundation only: the protocol, the commands and the geometry. Tested anywhere Swift runs.
        .target(name: "AxisDesktopCore"),
        // Everything that touches macOS: Accessibility, the window list, capture and OCR, the Keychain.
        .target(name: "AxisMacPlatform", dependencies: ["AxisDesktopCore"]),
        // The menu bar item, the settings window, the pointer.
        .target(name: "AxisMacUI", dependencies: ["AxisDesktopCore", "AxisMacPlatform"]),
        .executableTarget(name: "VortexAxisMac", dependencies: ["AxisDesktopCore", "AxisMacPlatform", "AxisMacUI"]),
        .testTarget(name: "AxisDesktopCoreTests", dependencies: ["AxisDesktopCore"]),
    ]
)

import AppKit
import ApplicationServices
import CoreGraphics

/**
 * The macOS permissions the app needs, read and asked for. Both are tied to the app's signing identity: an app
 * signed ad hoc loses them on every rebuild (scripts/build-mac.sh signs with an Apple Development certificate
 * when there is one).
 */
public enum Permissions {
    /** Reading other apps' controls, pressing them, and posting mouse and key events. */
    public static var accessibility: Bool { AXIsProcessTrusted() }

    /**
     * Posting mouse and keyboard events to other apps. macOS grants it with Accessibility (the same list in System
     * Settings); read on its own so the window can say when clicks and typing would be dropped.
     */
    public static var postEvents: Bool { CGPreflightPostEventAccess() }

    /** Asks for it: macOS sends the person to Accessibility. */
    public static func askPostEvents() { _ = CGRequestPostEventAccess() }

    /** Shows the system's prompt that sends the person to the Accessibility settings. */
    public static func askAccessibility() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    /** Pictures of the screen (screenshots, text from the pixels) and other apps' window titles. */
    public static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }

    /** Asks once; macOS may want the app started again after the person allows it. */
    public static func askScreenRecording() { _ = CGRequestScreenCaptureAccess() }

    public static func openAccessibilitySettings() { open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") }
    public static func openScreenRecordingSettings() { open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") }

    static func open(_ address: String) {
        if let url = URL(string: address) { NSWorkspace.shared.open(url) }
    }

    /** What a look says instead of an empty list when Accessibility is off: the two are otherwise the same to an agent. */
    public static let accessibilityRefusal =
        "macOS has not given VorteX Axis Accessibility access, so it cannot read this window: the person must allow it in System Settings > Privacy & Security > Accessibility"
}

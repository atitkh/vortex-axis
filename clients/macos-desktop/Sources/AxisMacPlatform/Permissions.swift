import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics

/**
 * The macOS permissions the app needs, read and asked for. All are tied to the app's signing identity: an app
 * signed ad hoc loses them on every rebuild (scripts/build-mac.sh signs with an Apple Development certificate
 * when there is one).
 */
public enum Permissions {
    /** Reading other apps' controls, pressing them, and posting mouse and key events. */
    public static var accessibility: Bool { AXIsProcessTrusted() }

    /**
     * Posting mouse and keyboard events to other apps. Accessibility is what lets an app post them in practice (typing
     * and clicks worked on a Mac where `CGPreflightPostEventAccess` still said no, as it does for builds whose signature
     * macOS has not tied to a separate "post event" grant), so an app that is trusted for Accessibility counts as allowed.
     */
    public static var postEvents: Bool { accessibility || CGPreflightPostEventAccess() }

    /** Asks for it: Accessibility first (the usual case); only when that is on does the separate post-event request run. */
    public static func askPostEvents() {
        if !accessibility { askAccessibility() } else { _ = CGRequestPostEventAccess() }
    }

    /** Shows the system's prompt that sends the person to the Accessibility settings. */
    public static func askAccessibility() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    /** Pictures of the screen (screenshots, text from the pixels) and other apps' window titles. */
    public static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }

    /** Asks once; macOS may want the app started again after the person allows it. */
    public static func askScreenRecording() { _ = CGRequestScreenCaptureAccess() }

    /** The microphone, for talking from this Mac. Asked the first time the talk key is pressed, or from the window. */
    public static var microphone: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

    /** Whether macOS has not asked yet (then asking shows its prompt; once refused, only System Settings can change it). */
    public static var microphoneUndecided: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined }

    /** Shows macOS's prompt when it has not asked yet; `done` is told the answer, on the main thread. */
    public static func askMicrophone(_ done: @escaping @Sendable (Bool) -> Void = { _ in }) {
        AVCaptureDevice.requestAccess(for: .audio) { granted in DispatchQueue.main.async { done(granted) } }
    }

    public static func openMicrophoneSettings() { open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") }

    public static func openAccessibilitySettings() { open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") }
    public static func openScreenRecordingSettings() { open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") }

    static func open(_ address: String) {
        if let url = URL(string: address) { NSWorkspace.shared.open(url) }
    }

    /** What a look says instead of an empty list when Accessibility is off: the two are otherwise the same to an agent. */
    public static let accessibilityRefusal =
        "macOS has not given VorteX Axis Accessibility access, so it cannot read this window: the person must allow it in System Settings > Privacy & Security > Accessibility"
}

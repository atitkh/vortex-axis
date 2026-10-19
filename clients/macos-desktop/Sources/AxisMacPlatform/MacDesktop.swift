import AppKit
import AxisDesktopCore

/** Draws the agent's pointer. The UI supplies it (`PointerPanel`); it is called on the main thread. */
@MainActor
public protocol PointerDrawing: AnyObject {
    /** Shows the pointer at (x, y), top-left points, with `text` beside it when there is any, for `seconds`. */
    func show(x: Int, y: Int, text: String?, seconds: Double)
    func hide()
}

/**
 * The Mac as Core's `Desktop`: looks through Accessibility (`AXReader`), windows and displays from Quartz
 * (`WindowList`), text from the pixels (`TextReader`), the pointer through the UI. M1: reading and pointing.
 */
public final class MacDesktop: Desktop, @unchecked Sendable {
    /** Fewer named controls than this, and auto OCR reads the pixels too (the Windows app's rule). */
    static let sparseBelow = 8
    static let ocrPatienceMs = 4000
    /** How long the read of the focus may take; past it a state goes without the focus. */
    static let statePatienceMs = 1500

    let reader = AXReader()
    weak var pointerDrawing: PointerDrawing?

    public init() {}

    @MainActor public func usePointer(_ pointer: PointerDrawing) { pointerDrawing = pointer }

    /** The window in front, its title from Accessibility when Quartz has none to give. */
    func front() async -> (pid: pid_t, window: WindowInfo)? {
        guard var front = WindowList.front() else { return nil }
        if front.window.title.isEmpty, Permissions.accessibility {
            let pid = front.pid
            front.window.title = await quick(500) { [reader] in reader.windowTitle(pid: pid) } ?? ""
        }
        return front
    }

    /** `work` on the accessibility queue under a deadline; nil when it has nothing, fails or takes too long. */
    func quick<T: Sendable>(_ ms: Int, _ work: @escaping @Sendable () -> T?) async -> T? {
        guard let got = try? await within(ms: ms, { [reader] in try await reader.run(work) }) else { return nil }
        return got
    }

    public func look(scope: String, ocr: OcrMode) async throws -> LookResult {
        let started = DispatchTime.now()
        let displays = WindowList.displays()
        let screen = Coordinates.union(displays)
        let mouse = WindowList.mouse()
        func result(_ window: WindowInfo?, _ elements: [ScreenElement]) -> LookResult {
            LookResult(window: window, mouseX: mouse.x, mouseY: mouse.y, elements: elements, screenX: screen.x, screenY: screen.y,
                       screenW: screen.w, screenH: screen.h, monitors: displays)
        }

        if scope == "screen" {
            // The windows open, not what is in them. Quartz only: no Accessibility needed, no OCR.
            var look = result(await front()?.window, WindowList.windows())
            look.readMs = Int(Self.ms(since: started))
            return look
        }
        guard Permissions.accessibility else { throw TextReader.Refused(message: Permissions.accessibilityRefusal) }
        let front = await front()
        var elements: [ScreenElement]
        let area: Box?
        if scope == "mouse" {
            elements = try await reader.run { [reader] in reader.readAtMouse(x: mouse.x, y: mouse.y) }
            area = Box(x: mouse.x - 300, y: mouse.y - 120, w: 601, h: 241)
        } else {
            guard let pid = front?.pid else { return result(nil, []) }
            let read = try await reader.run { [reader] in reader.readWindow(pid: pid) }
            elements = read.elements
            area = read.window ?? front.map { $0.window.box }
        }
        var look = result(front?.window, elements)
        look.readMs = Int(Self.ms(since: started))

        let named = elements.filter { !AXKinds.containers.contains($0.kind) && !$0.name.isEmpty }.count
        let wanted = ocr == .always || (ocr == .auto && named < Self.sparseBelow)
        if wanted, let box = area, box.w > 8, box.h > 8 {
            // Under its own deadline: a stuck capture leaves the text out, not the look.
            do {
                if let lines = try await within(ms: Self.ocrPatienceMs, { try await TextReader.read(area: box) }) {
                    look.elements += lines
                    look.ocr = true
                } else {
                    look.ocrFailed = "took too long"
                }
            } catch {
                look.ocrFailed = (error as? TextReader.Refused)?.message ?? describeError(error)
            }
        }
        look.ocrMs = Int(Self.ms(since: started)) - look.readMs
        return look
    }

    public func state() async throws -> ScreenState {
        guard let front = await front() else { return ScreenState(window: nil, focus: nil) }
        var focus: ScreenElement?
        if Permissions.accessibility {
            let pid = front.pid
            // A window that will not answer leaves the focus out, not the answer.
            focus = await quick(Self.statePatienceMs) { [reader] in reader.focus(pid: pid) }
        }
        return ScreenState(window: front.window, focus: focus)
    }

    public func point(x: Int, y: Int, text: String?, seconds: Double) async throws {
        await MainActor.run { pointerDrawing?.show(x: x, y: y, text: text, seconds: seconds) }
    }

    public func hide() async {
        await MainActor.run { pointerDrawing?.hide() }
    }

    public func centre() async -> (x: Int, y: Int) {
        let main = WindowList.displays().first { $0.primary } ?? Display(x: 0, y: 0, w: 1440, h: 900, primary: true)
        return (main.x + main.w / 2, main.y + main.h / 2)
    }

    static func ms(since t: DispatchTime) -> UInt64 { (DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1_000_000 }
}

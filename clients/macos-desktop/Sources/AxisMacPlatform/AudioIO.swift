import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation
import AxisDesktopCore

/** A microphone or speaker the person can pick: Core Audio's UID (what the settings keep) and its name. */
public struct AudioDevice: Hashable, Sendable, Identifiable {
    public let uid: String
    public let name: String
    public var id: String { uid }
}

/** The Mac's microphones and speakers, from Core Audio. */
public enum AudioDevices {
    public static func inputs() -> [AudioDevice] { list(input: true) }
    public static func outputs() -> [AudioDevice] { list(input: false) }

    static func list(input: Bool) -> [AudioDevice] {
        all().compactMap { id in
            guard channels(id, input: input) > 0, let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
            return AudioDevice(uid: uid, name: string(id, kAudioObjectPropertyName) ?? uid)
        }
    }

    static func all() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    /** How many channels the device has that way (0: it is not a microphone, or not a speaker). */
    static func channels(_ id: AudioDeviceID, input: Bool) -> Int {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration,
                                                 mScope: input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return 0 }
        let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    static func device(uid: String) -> AudioDeviceID? {
        all().first { string($0, kAudioDevicePropertyDeviceUID) == uid }
    }

    /**
     * Points an engine's input or output node at the device with `uid`. False (the system's default stays) when the
     * UID is empty or the device is gone: unplugged since it was chosen.
     */
    @discardableResult
    static func use(_ uid: String, on node: AVAudioIONode) -> Bool {
        guard !uid.isEmpty, let id = device(uid: uid), let unit = node.audioUnit else { return false }
        var device = id
        return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device,
                                    UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
    }
}

/** A value only ever touched from one thread at a time (a tap's own state), carried into its closure. */
final class TapState: @unchecked Sendable {
    var chunker = FrameChunker()
}

/**
 * The microphone and speakers through AVAudioEngine, as the voice part needs them (`VoiceIO`; the Windows app's
 * `VoiceIo`). The microphone is read in the hardware's own format, converted to 16 kHz mono 16-bit by
 * AVAudioConverter and cut into 20 ms frames; speech is played through an AVAudioPlayerNode at the rate Axis names,
 * its level measured on the mixer (before the system volume, docs/face.md section 4). One engine for each, so the
 * two devices are chosen apart. No echo canceller (the Windows decision): the voice part never listens while it speaks.
 *
 * Every engine call runs on one serial queue; Core Audio's callbacks only ever hand work to it asynchronously, so
 * nothing waits on a lock the caller holds.
 */
public final class AudioIO: VoiceIO, @unchecked Sendable {
    private let queue = DispatchQueue(label: "VorteX Axis audio", qos: .userInitiated)
    private let frames = DispatchQueue(label: "VorteX Axis microphone", qos: .userInitiated)
    private var inputUID = "", outputUID = ""

    private var capture: AVAudioEngine?

    private var output: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var format: AVAudioFormat?
    private var carry = ByteCarry()
    /** Bumped by every start and stop, so a callback from an older stretch does nothing. */
    private var generation = 0
    private var pending = 0
    private var drainsAt = Date()
    private var ending: (@Sendable () -> Void)?

    private let levelLock = NSLock()
    private var level = 0.0

    public init() {}

    /** The microphone and speaker by UID; empty is the system's default. Used from the next recording or answer. */
    public func use(mic: String, speaker: String) {
        queue.sync {
            inputUID = mic
            outputUID = speaker
        }
    }

    // MARK: Microphone

    public func startCapture(_ frame: @escaping @Sendable ([Int16]) -> Void) throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            Permissions.askMicrophone()
            throw DesktopError("macOS is asking whether VorteX Axis may use the microphone: allow it, then press the talk key again")
        default:
            throw DesktopError("macOS has not given VorteX Axis the microphone: allow it in System Settings > Privacy & Security > Microphone")
        }
        try queue.sync { try startCaptureNow(frame) }
    }

    private func startCaptureNow(_ frame: @escaping @Sendable ([Int16]) -> Void) throws {
        stopCaptureNow()
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // The chosen microphone, or the default one when it is gone.
        AudioDevices.use(inputUID, on: input)
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else { throw DesktopError("no microphone is connected") }
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(Voice.micRate), channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: hardware, to: target) else {
            throw DesktopError("the microphone's sound (\(Int(hardware.sampleRate)) Hz, \(hardware.channelCount) channels) could not be converted")
        }
        converter.downmix = true
        let state = TapState()
        let frames = self.frames
        input.installTap(onBus: 0, bufferSize: 1024, format: hardware) { buffer, _ in
            let samples = AudioIO.convert(buffer, with: converter, to: target)
            let ready = state.chunker.push(samples)
            guard !ready.isEmpty else { return }
            frames.async { for f in ready { frame(f) } }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw DesktopError("the microphone did not start: \(describeError(error))")
        }
        capture = engine
    }

    /** One buffer of the microphone in the hardware's format as 16 kHz mono 16-bit samples. The converter keeps its filter between calls. */
    static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to target: AVAudioFormat) -> [Int16] {
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
        var given = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if given {
                inputStatus.pointee = .noDataNow
                return nil
            }
            given = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0, let data = out.int16ChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
    }

    public func stopCapture() {
        queue.sync { stopCaptureNow() }
    }

    private func stopCaptureNow() {
        guard let engine = capture else { return }
        capture = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    // MARK: Speakers

    public var playLevel: Double { levelLock.withLock { level } }

    public func playBegin(sampleRate: Int) {
        queue.sync { beginNow(sampleRate) }
    }

    /**
     * A new engine for each stretch of speech: the chosen speaker (or, when it is gone or will not start, the
     * default one, as the Windows app does), a player at Axis's rate, and a tap on the mixer for the face's level.
     * Nothing leaves this method: with no speaker at all the reply is still shown and the turn still ends.
     */
    private func beginNow(_ rate: Int) {
        _ = stopNow()
        generation += 1
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: Double(max(8000, rate)), channels: 1) else { return }
        for uid in outputUID.isEmpty ? [""] : [outputUID, ""] {
            let engine = AVAudioEngine()
            // The device first: the mixer's link to the output takes the device's format when it is made.
            if !uid.isEmpty, !AudioDevices.use(uid, on: engine.outputNode) { continue }
            let node = AVAudioPlayerNode()
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: fmt)
            engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
                guard let self, let data = buffer.floatChannelData, buffer.frameLength > 0 else { return }
                let rms = PCM.rms(UnsafeBufferPointer(start: data[0], count: Int(buffer.frameLength)))
                // About 21 ms a buffer at 48 kHz: a fall of 0.8 a buffer is about a tenth of a second.
                self.levelLock.withLock { self.level = PCM.playLevel(previous: self.level, rms: rms, fall: 0.8) }
            }
            engine.prepare()
            do {
                try engine.start()
            } catch {
                engine.mainMixerNode.removeTap(onBus: 0)
                continue
            }
            node.play()
            output = engine
            player = node
            format = fmt
            drainsAt = Date()
            return
        }
    }

    public func playWrite(_ pcm: Data) {
        queue.sync { writeNow(pcm) }
    }

    private func writeNow(_ pcm: Data) {
        guard let node = player, let fmt = format else { return }
        let samples = PCM.samples(carry.whole(pcm))
        guard !samples.isEmpty, let buffer = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for i in 0..<samples.count { channel[i] = PCM.float(samples[i]) }
        pending += 1
        drainsAt = max(drainsAt, Date()).addingTimeInterval(Double(samples.count) / fmt.sampleRate)
        let mine = generation
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            self.queue.async { self.playedOne(mine) }
        }
    }

    private func playedOne(_ mine: Int) {
        guard mine == generation else { return }
        pending = max(0, pending - 1)
        finishIfDone()
    }

    /** Heard once every buffer has been played back; never called from inside this call (the queue hands it on). */
    public func playEnd(_ finished: @escaping @Sendable () -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.player != nil else {
                DispatchQueue.global().async { finished() }
                return
            }
            self.ending = finished
            let mine = self.generation
            // Should the last buffer's callback never come, the speech is over a moment after it would have ended.
            let left = max(0, self.drainsAt.timeIntervalSinceNow) + 2
            self.queue.asyncAfter(deadline: .now() + left) { [weak self] in
                guard let self, self.generation == mine, self.ending != nil else { return }
                self.pending = 0
                self.finishIfDone()
            }
            self.finishIfDone()
        }
    }

    private func finishIfDone() {
        guard pending == 0, let done = ending else { return }
        ending = nil
        _ = stopNow()
        DispatchQueue.global().async { done() }
    }

    @discardableResult
    public func stopPlayback() -> Bool {
        queue.sync { stopNow() }
    }

    private func stopNow() -> Bool {
        let was = player != nil
        generation += 1
        pending = 0
        ending = nil
        carry.reset()
        if let engine = output {
            engine.mainMixerNode.removeTap(onBus: 0)
            player?.stop()
            engine.stop()
        }
        output = nil
        player = nil
        format = nil
        levelLock.withLock { level = 0 }
        return was
    }
}

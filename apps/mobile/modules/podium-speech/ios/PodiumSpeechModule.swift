import AVFAudio
import CoreMedia
import ExpoModulesCore
import Foundation
import Speech

private let availabilityEvent = "onAvailabilityChanged"
private let errorEvent = "onError"
private let phaseEvent = "onPhaseChanged"
private let resultEvent = "onResult"

public final class PodiumSpeechModule: Module {
  private let serviceLock = NSLock()
  private var serviceStorage: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("PodiumSpeech")
    Events(availabilityEvent, errorEvent, phaseEvent, resultEvent)

    AsyncFunction("getAvailability") { (localeIdentifier: String?) async -> [String: Any?] in
      guard #available(iOS 26.0, *) else {
        return Self.olderOSAvailability(localeIdentifier: localeIdentifier)
      }
      return await self.service().availability(for: localeIdentifier).payload
    }

    AsyncFunction("start") { (localeIdentifier: String?, clientGeneration: Int) async throws -> [String: Any?] in
      do {
        guard #available(iOS 26.0, *) else {
          throw PodiumSpeechFailure(
            code: "unsupported_os",
            message: "On-device dictation requires iOS 26 or later.",
            recoverable: false
          )
        }
        return try await self.service().start(
          localeIdentifier: localeIdentifier,
          clientGeneration: clientGeneration
        ).payload
      } catch let failure as PodiumSpeechFailure {
        throw ExpoModulesCore.Exception(
          name: "PodiumSpeechError",
          description: failure.message,
          code: failure.code
        )
      }
    }

    AsyncFunction("stop") { (clientGeneration: Int) async throws in
      guard #available(iOS 26.0, *), let service = self.existingService() else {
        return
      }
      do {
        try await service.stop(clientGeneration: clientGeneration)
      } catch let failure as PodiumSpeechFailure {
        throw ExpoModulesCore.Exception(
          name: "PodiumSpeechError",
          description: failure.message,
          code: failure.code
        )
      }
    }

    AsyncFunction("cancel") { (clientGeneration: Int) async in
      guard #available(iOS 26.0, *), let service = self.existingService() else {
        return
      }
      await service.cancel(clientGeneration: clientGeneration)
    }

    OnAppEntersBackground {
      self.abortForLifecycle()
    }

    OnAppContextDestroys {
      self.abortForLifecycle()
    }
  }

  private static func olderOSAvailability(localeIdentifier: String?) -> [String: Any?] {
    return [
      "status": "unsupported_os",
      "supported": false,
      "requestedLocaleIdentifier": localeIdentifier ?? Locale.current.identifier,
      "localeIdentifier": nil,
      "modelStatus": "unavailable",
      "microphonePermission": "unknown",
      "progress": nil,
      "message": "On-device dictation requires iOS 26 or later. You can keep typing normally."
    ]
  }

  @available(iOS 26.0, *)
  private func service() -> PodiumSpeechService {
    serviceLock.lock()
    defer { serviceLock.unlock() }

    if let service = serviceStorage as? PodiumSpeechService {
      return service
    }

    let service = PodiumSpeechService { [weak self] event in
      self?.deliver(event)
    }
    serviceStorage = service
    return service
  }

  @available(iOS 26.0, *)
  private func existingService() -> PodiumSpeechService? {
    serviceLock.lock()
    defer { serviceLock.unlock() }
    return serviceStorage as? PodiumSpeechService
  }

  private func abortForLifecycle() {
    guard #available(iOS 26.0, *), let service = existingService() else {
      return
    }
    Task {
      await service.abort(generation: nil, reason: nil, notify: false)
    }
  }

  @available(iOS 26.0, *)
  private func deliver(_ event: PodiumSpeechEvent) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      switch event {
      case .availability(let availability, let generation):
        var payload = availability.payload
        payload["generation"] = generation
        self.sendEvent(availabilityEvent, payload)
      case .failure(let failure, let generation):
        var payload = failure.payload
        payload["generation"] = generation
        self.sendEvent(errorEvent, payload)
      case .phase(let phase, let progress, let generation):
        self.sendEvent(phaseEvent, [
          "phase": phase,
          "progress": progress,
          "generation": generation
        ])
      case .result(let result, let generation):
        var payload = result.payload
        payload["generation"] = generation
        self.sendEvent(resultEvent, payload)
      }
    }
  }
}

private struct PodiumSpeechFailure: CodedError, LocalizedError, Sendable {
  let code: String
  let message: String
  let recoverable: Bool

  var description: String { message }
  var errorDescription: String? { message }

  var payload: [String: Any] {
    return ["code": code, "message": message, "recoverable": recoverable]
  }

  static func from(_ error: Error, fallbackCode: String, fallbackMessage: String) -> Self {
    if let failure = error as? Self {
      return failure
    }
    let cocoaError = error as NSError
    if cocoaError.domain == NSURLErrorDomain {
      return Self(
        code: "model_download_network",
        message: "The dictation language model could not be downloaded. Check the network and try again.",
        recoverable: true
      )
    }
    return Self(code: fallbackCode, message: fallbackMessage, recoverable: true)
  }
}

@available(iOS 26.0, *)
private struct PodiumSpeechAvailability: Sendable {
  let status: String
  let supported: Bool
  let requestedLocaleIdentifier: String
  let localeIdentifier: String?
  let modelStatus: String
  let microphonePermission: String
  let progress: Double?
  let message: String

  var payload: [String: Any?] {
    return [
      "status": status,
      "supported": supported,
      "requestedLocaleIdentifier": requestedLocaleIdentifier,
      "localeIdentifier": localeIdentifier,
      "modelStatus": modelStatus,
      "microphonePermission": microphonePermission,
      "progress": progress,
      "message": message
    ]
  }
}

@available(iOS 26.0, *)
private struct PodiumSpeechResult: Sendable {
  let text: String
  let startTime: Double
  let endTime: Double
  let isFinal: Bool
  let finalizationTime: Double

  var payload: [String: Any] {
    return [
      "text": text,
      "startTime": startTime,
      "endTime": endTime,
      "isFinal": isFinal,
      "finalizationTime": finalizationTime
    ]
  }
}

@available(iOS 26.0, *)
private enum PodiumSpeechEvent: Sendable {
  case availability(PodiumSpeechAvailability, generation: Int)
  case failure(PodiumSpeechFailure, generation: Int)
  case phase(String, Double?, generation: Int)
  case result(PodiumSpeechResult, generation: Int)
}

private struct PodiumAudioSessionConfiguration {
  let category: AVAudioSession.Category
  let mode: AVAudioSession.Mode
  let options: AVAudioSession.CategoryOptions
}

@available(iOS 26.0, *)
private actor PodiumSpeechService {
  private let emit: @Sendable (PodiumSpeechEvent) -> Void
  private var generation = 0
  private var eventGeneration = 0
  private var phase = "idle"
  private var currentAvailability: PodiumSpeechAvailability?
  private var audioEngine: AVAudioEngine?
  private var analyzer: SpeechAnalyzer?
  private var transcriber: SpeechTranscriber?
  private var analyzerFormat: AVAudioFormat?
  // AnalyzerInputConverter is iOS 27+, so the iOS 26 path drains AVAudioConverter
  // explicitly. See developer.apple.com/documentation/speech/analyzerinputconverter.
  private var converter: AVAudioConverter?
  private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
  private var audioContinuation: AsyncStream<AVAudioPCMBuffer>.Continuation?
  private var audioTask: Task<Void, Never>?
  private var resultTask: Task<Void, Never>?
  private var progressTask: Task<Void, Never>?
  private var notificationObservers: [NSObjectProtocol] = []
  private var ownsAudioSession = false
  private var audioTapInstalled = false
  private var previousAudioSessionConfiguration: PodiumAudioSessionConfiguration?
  private var terminalFailure: PodiumSpeechFailure?

  init(emit: @escaping @Sendable (PodiumSpeechEvent) -> Void) {
    self.emit = emit
  }

  func availability(for requestedIdentifier: String?) async -> PodiumSpeechAvailability {
    let requestedLocale = Locale(identifier: requestedIdentifier ?? Locale.current.identifier)
    let microphonePermission = Self.microphonePermission()

    guard SpeechTranscriber.isAvailable else {
      return PodiumSpeechAvailability(
        status: "unsupported_device",
        supported: false,
        requestedLocaleIdentifier: requestedLocale.identifier,
        localeIdentifier: nil,
        modelStatus: "unavailable",
        microphonePermission: microphonePermission,
        progress: nil,
        message: "This device does not support Apple's on-device transcription model."
      )
    }

    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
      return PodiumSpeechAvailability(
        status: "unsupported_locale",
        supported: false,
        requestedLocaleIdentifier: requestedLocale.identifier,
        localeIdentifier: nil,
        modelStatus: "unavailable",
        microphonePermission: microphonePermission,
        progress: nil,
        message: "On-device dictation is not available for \(requestedLocale.identifier)."
      )
    }

    // This iOS 26 preset combines volatile results with audio ranges; the
    // range reducer relies on both to replace Apple's revisions correctly.
    let module = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
    let assetStatus = await AssetInventory.status(forModules: [module])
    switch assetStatus {
    case .installed:
      return PodiumSpeechAvailability(
        status: microphonePermission == "denied" ? "microphone_denied" : "ready",
        supported: true,
        requestedLocaleIdentifier: requestedLocale.identifier,
        localeIdentifier: locale.identifier,
        modelStatus: "installed",
        microphonePermission: microphonePermission,
        progress: 1,
        message: microphonePermission == "denied"
          ? "Microphone access is off. Enable it in Settings to dictate."
          : "Private on-device dictation is ready."
      )
    case .downloading:
      return PodiumSpeechAvailability(
        status: "model_downloading",
        supported: true,
        requestedLocaleIdentifier: requestedLocale.identifier,
        localeIdentifier: locale.identifier,
        modelStatus: "downloading",
        microphonePermission: microphonePermission,
        progress: nil,
        message: "Apple is downloading the on-device dictation model."
      )
    case .supported:
      return PodiumSpeechAvailability(
        status: "model_download_required",
        supported: true,
        requestedLocaleIdentifier: requestedLocale.identifier,
        localeIdentifier: locale.identifier,
        modelStatus: "download_required",
        microphonePermission: microphonePermission,
        progress: nil,
        message: "The private dictation model for \(locale.identifier) must be downloaded first."
      )
    case .unsupported:
      return PodiumSpeechAvailability(
        status: "unsupported_locale",
        supported: false,
        requestedLocaleIdentifier: requestedLocale.identifier,
        localeIdentifier: locale.identifier,
        modelStatus: "unavailable",
        microphonePermission: microphonePermission,
        progress: nil,
        message: "Apple's on-device model cannot transcribe \(locale.identifier) on this device."
      )
    @unknown default:
      return PodiumSpeechAvailability(
        status: "unavailable",
        supported: false,
        requestedLocaleIdentifier: requestedLocale.identifier,
        localeIdentifier: locale.identifier,
        modelStatus: "unavailable",
        microphonePermission: microphonePermission,
        progress: nil,
        message: "On-device dictation is unavailable right now."
      )
    }
  }

  func start(
    localeIdentifier: String?,
    clientGeneration: Int
  ) async throws -> PodiumSpeechAvailability {
    if phase != "idle" {
      throw PodiumSpeechFailure(
        code: "already_active",
        message: "Dictation is already active.",
        recoverable: true
      )
    }

    generation += 1
    let startGeneration = generation
    eventGeneration = clientGeneration
    terminalFailure = nil
    setPhase("preparing", progress: nil)

    do {
      var availability = await availability(for: localeIdentifier)
      currentAvailability = availability
      emit(.availability(availability, generation: eventGeneration))
      guard availability.supported, let resolvedIdentifier = availability.localeIdentifier else {
        throw PodiumSpeechFailure(
          code: availability.status,
          message: availability.message,
          recoverable: availability.status == "model_capacity_unavailable"
        )
      }

      let locale = Locale(identifier: resolvedIdentifier)
      let transcriber = SpeechTranscriber(
        locale: locale,
        preset: .timeIndexedProgressiveTranscription
      )
      if availability.modelStatus != "installed" {
        availability = try await installModel(
          for: transcriber,
          requestedLocaleIdentifier: availability.requestedLocaleIdentifier,
          locale: locale,
          generation: startGeneration
        )
        guard startGeneration == generation else { return availability }
        currentAvailability = availability
        emit(.availability(availability, generation: eventGeneration))
      }

      guard startGeneration == generation else { return availability }
      guard await AVAudioApplication.requestRecordPermission() else {
        throw PodiumSpeechFailure(
          code: "microphone_denied",
          message: "Microphone access is off. Enable it in Settings to dictate.",
          recoverable: true
        )
      }

      guard startGeneration == generation else { return availability }
      try await beginCapture(
        transcriber: transcriber,
        generation: startGeneration
      )
      guard startGeneration == generation, phase == "preparing" else { return availability }

      let ready = PodiumSpeechAvailability(
        status: "ready",
        supported: true,
        requestedLocaleIdentifier: availability.requestedLocaleIdentifier,
        localeIdentifier: locale.identifier,
        modelStatus: "installed",
        microphonePermission: "granted",
        progress: 1,
        message: "Listening with private on-device dictation."
      )
      currentAvailability = ready
      emit(.availability(ready, generation: eventGeneration))
      setPhase("listening", progress: nil)
      return ready
    } catch {
      let failure = PodiumSpeechFailure.from(
        error,
        fallbackCode: "start_failed",
        fallbackMessage: "Dictation could not start. Try again."
      )
      await abort(generation: startGeneration, reason: failure, notify: true)
      throw failure
    }
  }

  func stop(clientGeneration: Int) async throws {
    guard clientGeneration == eventGeneration else { return }
    guard phase != "idle" else { return }

    if phase != "listening" {
      generation += 1
      let stopGeneration = generation
      stopAudioProducer()
      inputContinuation?.finish()
      inputContinuation = nil
      let stoppingAnalyzer = analyzer
      await stoppingAnalyzer?.cancelAndFinishNow()
      guard generation == stopGeneration else { return }
      clearResources()
      setPhase("idle", progress: nil)
      return
    }

    let stopGeneration = generation
    setPhase("stopping", progress: nil)
    stopAudioProducer()
    let drainingAudioTask = audioTask
    audioTask = nil
    await drainingAudioTask?.value
    if try stopWasSuperseded(generation: stopGeneration) { return }

    do {
      try flushConverter()
      inputContinuation?.finish()
      inputContinuation = nil
      let stoppingAnalyzer = analyzer
      try await stoppingAnalyzer?.finalizeAndFinishThroughEndOfInput()
      if try stopWasSuperseded(generation: stopGeneration) { return }
      let drainingResultTask = resultTask
      resultTask = nil
      await drainingResultTask?.value
      if try stopWasSuperseded(generation: stopGeneration) { return }
      generation += 1
      clearResources()
      setPhase("idle", progress: nil)
    } catch {
      let failure = PodiumSpeechFailure.from(
        error,
        fallbackCode: "finalization_failed",
        fallbackMessage: "Dictation stopped before the last words could be finalized."
      )
      await abort(generation: stopGeneration, reason: failure, notify: true)
      throw failure
    }
  }

  func cancel(clientGeneration: Int) async {
    guard clientGeneration == eventGeneration else { return }
    await abort(generation: generation, reason: nil, notify: false)
  }

  func abort(
    generation expectedGeneration: Int?,
    reason: PodiumSpeechFailure?,
    notify: Bool
  ) async {
    if let expectedGeneration, expectedGeneration != generation { return }
    if let reason {
      terminalFailure = reason
    }
    generation += 1
    let abortGeneration = generation
    stopAudioProducer()
    inputContinuation?.finish()
    inputContinuation = nil
    let stoppingAnalyzer = analyzer
    await stoppingAnalyzer?.cancelAndFinishNow()
    guard generation == abortGeneration else { return }
    clearResources()
    if notify, let reason {
      emit(.failure(reason, generation: eventGeneration))
    }
    setPhase("idle", progress: nil)
  }

  private func installModel(
    for transcriber: SpeechTranscriber,
    requestedLocaleIdentifier: String,
    locale: Locale,
    generation startGeneration: Int
  ) async throws -> PodiumSpeechAvailability {
    setPhase("downloading", progress: 0)
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        progressTask = Task { [weak self, progress = request.progress] in
          while !Task.isCancelled {
            guard let self else { return }
            await self.publishDownloadProgress(progress.fractionCompleted, generation: startGeneration)
            try? await Task.sleep(for: .milliseconds(250))
          }
        }
        try await request.downloadAndInstall()
      }
      progressTask?.cancel()
      progressTask = nil
      guard startGeneration == generation else {
        return await availability(for: requestedLocaleIdentifier)
      }
      setPhase("preparing", progress: 1)
      return PodiumSpeechAvailability(
        status: "ready",
        supported: true,
        requestedLocaleIdentifier: requestedLocaleIdentifier,
        localeIdentifier: locale.identifier,
        modelStatus: "installed",
        microphonePermission: Self.microphonePermission(),
        progress: 1,
        message: "Private on-device dictation is ready."
      )
    } catch {
      progressTask?.cancel()
      progressTask = nil
      if Self.isReservationCapacityError(error) {
        throw PodiumSpeechFailure(
          code: "model_capacity_unavailable",
          message: "This device has no free speech-model language slots.",
          recoverable: true
        )
      }
      throw PodiumSpeechFailure.from(
        error,
        fallbackCode: "model_install_failed",
        fallbackMessage: "The on-device dictation model could not be installed. Try again later."
      )
    }
  }

  private func beginCapture(
    transcriber: SpeechTranscriber,
    generation startGeneration: Int
  ) async throws {
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw PodiumSpeechFailure(
        code: "audio_format_unavailable",
        message: "This device has no microphone format compatible with on-device dictation.",
        recoverable: false
      )
    }

    let (inputSequence, inputContinuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let (audioSequence, audioContinuation) = AsyncStream.makeStream(of: AVAudioPCMBuffer.self)
    self.transcriber = transcriber
    self.analyzer = analyzer
    self.analyzerFormat = analyzerFormat
    self.inputContinuation = inputContinuation
    self.audioContinuation = audioContinuation

    resultTask = Task { [weak self, transcriber] in
      do {
        for try await result in transcriber.results {
          guard let self else { return }
          await self.publish(result, generation: startGeneration)
        }
      } catch is CancellationError {
        return
      } catch {
        guard let self else { return }
        let failure = PodiumSpeechFailure.from(
          error,
          fallbackCode: "recognition_failed",
          fallbackMessage: "On-device dictation stopped unexpectedly."
        )
        await self.abort(generation: startGeneration, reason: failure, notify: true)
      }
    }

    audioTask = Task { [weak self] in
      for await buffer in audioSequence {
        guard let self else { return }
        do {
          try await self.consume(buffer, generation: startGeneration)
        } catch is CancellationError {
          return
        } catch {
          let failure = PodiumSpeechFailure.from(
            error,
            fallbackCode: "audio_conversion_failed",
            fallbackMessage: "Microphone audio could not be prepared for dictation."
          )
          await self.abort(generation: startGeneration, reason: failure, notify: true)
          return
        }
      }
    }

    try await analyzer.start(inputSequence: inputSequence)
    guard startGeneration == generation else {
      await analyzer.cancelAndFinishNow()
      return
    }

    let session = AVAudioSession.sharedInstance()
    previousAudioSessionConfiguration = PodiumAudioSessionConfiguration(
      category: session.category,
      mode: session.mode,
      options: session.categoryOptions
    )
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.allowBluetoothHFP])
    try session.setActive(true)
    ownsAudioSession = true

    let engine = AVAudioEngine()
    let inputNode = engine.inputNode
    let inputFormat = inputNode.outputFormat(forBus: 0)
    guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
      throw PodiumSpeechFailure(
        code: "microphone_unavailable",
        message: "No microphone input is available.",
        recoverable: true
      )
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
      throw PodiumSpeechFailure(
        code: "audio_format_unavailable",
        message: "The microphone format cannot be converted for on-device dictation.",
        recoverable: false
      )
    }
    self.audioEngine = engine
    self.converter = converter
    installAudioObservers(for: session, engine: engine, generation: startGeneration)

    inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { buffer, _ in
      audioContinuation.yield(buffer)
    }
    audioTapInstalled = true
    engine.prepare()
    try engine.start()
  }

  private func consume(_ buffer: AVAudioPCMBuffer, generation startGeneration: Int) throws {
    guard startGeneration == generation, phase != "idle" else {
      throw CancellationError()
    }
    guard let analyzerFormat, let inputContinuation else {
      throw PodiumSpeechFailure(
        code: "recognition_stream_closed",
        message: "The dictation audio stream is closed.",
        recoverable: true
      )
    }

    if converter == nil || converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: analyzerFormat)
    }
    guard let converter else {
      throw PodiumSpeechFailure(
        code: "audio_conversion_failed",
        message: "The microphone format cannot be converted for dictation.",
        recoverable: false
      )
    }

    let scale = analyzerFormat.sampleRate / buffer.format.sampleRate
    let capacity = max(1, AVAudioFrameCount(ceil(Double(buffer.frameLength) * scale)) + 1)
    var suppliedInput = false
    for _ in 0..<32 {
      guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
        throw PodiumSpeechFailure(
          code: "audio_conversion_failed",
          message: "Could not allocate a dictation audio buffer.",
          recoverable: true
        )
      }

      var conversionError: NSError?
      let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
        if suppliedInput {
          inputStatus.pointee = .noDataNow
          return nil
        }
        suppliedInput = true
        inputStatus.pointee = .haveData
        return buffer
      }
      if converted.frameLength > 0 {
        inputContinuation.yield(AnalyzerInput(buffer: converted))
      }

      switch status {
      case .haveData:
        continue
      case .inputRanDry, .endOfStream:
        return
      case .error:
        throw conversionError ?? PodiumSpeechFailure(
          code: "audio_conversion_failed",
          message: "Microphone audio conversion failed.",
          recoverable: true
        )
      @unknown default:
        return
      }
    }

    throw PodiumSpeechFailure(
      code: "audio_conversion_failed",
      message: "Microphone audio conversion did not finish.",
      recoverable: true
    )
  }

  private func flushConverter() throws {
    guard let converter, let analyzerFormat, let inputContinuation else { return }

    // AVAudioConverter can retain resampling tail frames after the microphone
    // producer finishes. Signal end-of-stream and drain those frames before
    // closing SpeechAnalyzer's input so finalization sees the complete capture.
    let capacity = max(1, AVAudioFrameCount(ceil(analyzerFormat.sampleRate / 10)))
    for _ in 0..<32 {
      guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
        throw PodiumSpeechFailure(
          code: "audio_conversion_failed",
          message: "Could not allocate the final dictation audio buffer.",
          recoverable: true
        )
      }

      var conversionError: NSError?
      let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
        inputStatus.pointee = .endOfStream
        return nil
      }
      if converted.frameLength > 0 {
        inputContinuation.yield(AnalyzerInput(buffer: converted))
      }

      switch status {
      case .haveData:
        continue
      case .endOfStream, .inputRanDry:
        return
      case .error:
        throw conversionError ?? PodiumSpeechFailure(
          code: "audio_conversion_failed",
          message: "Final microphone audio conversion failed.",
          recoverable: true
        )
      @unknown default:
        return
      }
    }
  }

  private func publish(
    _ result: SpeechTranscriber.Result,
    generation startGeneration: Int
  ) {
    guard startGeneration == generation else { return }
    emit(.result(PodiumSpeechResult(
      text: String(result.text.characters),
      startTime: result.range.start.seconds,
      endTime: CMTimeRangeGetEnd(result.range).seconds,
      isFinal: result.isFinal,
      finalizationTime: result.resultsFinalizationTime.seconds
    ), generation: eventGeneration))
  }

  private func publishDownloadProgress(_ progress: Double, generation startGeneration: Int) {
    guard startGeneration == generation, phase == "downloading" else { return }
    setPhase("downloading", progress: progress)
  }

  private func installAudioObservers(
    for session: AVAudioSession,
    engine: AVAudioEngine,
    generation startGeneration: Int
  ) {
    removeAudioObservers()
    let center = NotificationCenter.default
    notificationObservers.append(center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: session,
      queue: nil
    ) { [weak self] notification in
      guard
        let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        AVAudioSession.InterruptionType(rawValue: typeValue) == .began
      else { return }
      Task {
        await self?.abort(
          generation: startGeneration,
          reason: PodiumSpeechFailure(
            code: "audio_interrupted",
            message: "Dictation stopped because another app needed the microphone.",
            recoverable: true
          ),
          notify: true
        )
      }
    })
    notificationObservers.append(center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: session,
      queue: nil
    ) { [weak self] notification in
      guard let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
      else { return }
      let lostRoute = reason == .noSuitableRouteForCategory
        || (reason == .oldDeviceUnavailable
          && AVAudioSession.sharedInstance().currentRoute.inputs.isEmpty)
      guard lostRoute else { return }
      Task {
        await self?.abort(
          generation: startGeneration,
          reason: PodiumSpeechFailure(
            code: "audio_route_lost",
            message: "Dictation stopped because the microphone route was disconnected.",
            recoverable: true
          ),
          notify: true
        )
      }
    })
    notificationObservers.append(center.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      Task {
        await self?.abort(
          generation: startGeneration,
          reason: PodiumSpeechFailure(
            code: "audio_configuration_changed",
            message: "Dictation stopped because the microphone configuration changed.",
            recoverable: true
          ),
          notify: true
        )
      }
    })
    notificationObservers.append(center.addObserver(
      forName: AVAudioSession.mediaServicesWereResetNotification,
      object: session,
      queue: nil
    ) { [weak self] _ in
      Task {
        await self?.abort(
          generation: startGeneration,
          reason: PodiumSpeechFailure(
            code: "audio_services_reset",
            message: "Dictation stopped because iOS reset its audio service.",
            recoverable: true
          ),
          notify: true
        )
      }
    })
  }

  private func stopAudioProducer() {
    if let engine = audioEngine {
      engine.stop()
      if audioTapInstalled {
        engine.inputNode.removeTap(onBus: 0)
        audioTapInstalled = false
      }
    }
    audioContinuation?.finish()
    audioContinuation = nil
  }

  private func clearResources() {
    progressTask?.cancel()
    progressTask = nil
    audioTask?.cancel()
    audioTask = nil
    resultTask?.cancel()
    resultTask = nil
    removeAudioObservers()
    analyzer = nil
    transcriber = nil
    analyzerFormat = nil
    converter = nil
    audioEngine = nil
    currentAvailability = nil
    let session = AVAudioSession.sharedInstance()
    if ownsAudioSession {
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      ownsAudioSession = false
    }
    if let previousAudioSessionConfiguration {
      try? session.setCategory(
        previousAudioSessionConfiguration.category,
        mode: previousAudioSessionConfiguration.mode,
        options: previousAudioSessionConfiguration.options
      )
      self.previousAudioSessionConfiguration = nil
    }
  }

  private func removeAudioObservers() {
    let center = NotificationCenter.default
    for observer in notificationObservers {
      center.removeObserver(observer)
    }
    notificationObservers.removeAll()
  }

  private func setPhase(_ phase: String, progress: Double?) {
    self.phase = phase
    emit(.phase(phase, progress, generation: eventGeneration))
  }

  private func stopWasSuperseded(generation stopGeneration: Int) throws -> Bool {
    guard generation != stopGeneration else { return false }
    if let terminalFailure {
      self.terminalFailure = nil
      throw terminalFailure
    }
    return true
  }

  private static func microphonePermission() -> String {
    switch AVAudioApplication.shared.recordPermission {
    case .granted:
      return "granted"
    case .denied:
      return "denied"
    case .undetermined:
      return "undetermined"
    @unknown default:
      return "unknown"
    }
  }

  private static func isReservationCapacityError(_ error: Error) -> Bool {
    let speechError = error as NSError
    return speechError.domain == SFSpeechErrorDomain
      && speechError.code == SFSpeechError.Code.tooManyAssetLocalesAllocated.rawValue
  }
}

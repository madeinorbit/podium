import ExpoModulesCore
import QuartzCore
import UIKit

/// The RN Working motion (dots, glint, streaming caret) as Core Animation. Every
/// loop is a repeating CA animation handed to the render server once; the app
/// computes no frame of it. React owns the gate (visible content, page, modal
/// coverage, Reduce Motion) through `active`; this file adds what UIKit knows
/// first: whether the view is in a window and the app is in the foreground.
///
/// Each motion keeps one clock, as the RN shared progress did: a view that
/// starts while another of its kind runs joins that phase, and the first one to
/// start after none ran begins the loop from its start.
final class MotionClock {
  private var running = 0
  private var anchor: CFTimeInterval = 0

  /// Main thread only. Returns the media time the loop started at.
  func join() -> CFTimeInterval {
    if running == 0 { anchor = CACurrentMediaTime() }
    running += 1
    return anchor
  }

  func leave() {
    running = max(0, running - 1)
  }
}

/// Hosts React children inside `content`, a plain view this class owns: RN
/// resets the host layer's mask on every layer invalidation, so masks and
/// animations live one level down. Children keep their Yoga frames because the
/// content view always covers the host's bounds.
class CoreMotionView: ExpoView {
  let content = UIView()
  private(set) var running = false
  private var anchor: CFTimeInterval = 0
  private var foreground = UIApplication.shared.applicationState == .active
  private var observers: [NSObjectProtocol] = []
  private var laidOutSize: CGSize = .zero

  /// React's gate: visible, uncovered content with Reduce Motion off.
  var active = false {
    didSet { if active != oldValue { reconcile() } }
  }

  class var clock: MotionClock { fatalError("subclass") }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    content.isUserInteractionEnabled = false
    addSubview(content)
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) {
        [weak self] _ in self?.setForeground(false)
      },
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) {
        [weak self] _ in self?.setForeground(true)
      },
    ]
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    if running { Self.clock.leave() }
  }

  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    content.insertSubview(childComponentView, at: index)
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    childComponentView.removeFromSuperview()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    reconcile()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    content.frame = bounds
    if bounds.size != laidOutSize {
      laidOutSize = bounds.size
      layoutMotion()
      // Loop values are in points; re-add them on the same clock.
      if running { startMotion(at: anchor) }
    }
    CATransaction.commit()
  }

  private func setForeground(_ value: Bool) {
    foreground = value
    reconcile()
  }

  /// Subclasses call this when a prop the running loop depends on changes.
  func restartIfRunning() {
    if running { startMotion(at: anchor) }
  }

  private func reconcile() {
    let should = active && foreground && window != nil
    guard should != running else { return }
    running = should
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if should {
      anchor = Self.clock.join()
      startMotion(at: anchor)
    } else {
      Self.clock.leave()
      stopMotion()
    }
    CATransaction.commit()
  }

  /// Size-dependent rest geometry. Called inside a transaction without actions.
  func layoutMotion() {}
  /// Add the loop with `beginTime` at the clock's anchor (media time).
  func startMotion(at anchor: CFTimeInterval) {}
  /// Remove the loop and show the rest picture.
  func stopMotion() {}
}

private func repeating(_ animation: CAAnimation, duration: CFTimeInterval, anchor: CFTimeInterval, on layer: CALayer)
  -> CAAnimation
{
  animation.duration = duration
  animation.repeatCount = .infinity
  animation.isRemovedOnCompletion = false
  animation.beginTime = layer.convertTime(anchor, from: nil)
  return animation
}

// MARK: - Working mark

/// The tetra design's sampled loop, handed over once by JS from
/// `@podium/working-mark` so both platforms draw the same table.
struct WorkingMarkFrames {
  /// samples[frame][dot] = [cx, cy, rx, ry, opacity] in cell widths.
  let samples: [[[Double]]]
  let rest: [[Double]]
  let loop: CFTimeInterval

  private static let lock = NSLock()
  private static var stored: WorkingMarkFrames?
  /// Written once from the JS thread, read on main.
  static var shared: WorkingMarkFrames? {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }

  init?(samples flat: [Double], dots: Int, rest flatRest: [Double], loopMs: Double) {
    let stride = dots * 5
    guard dots > 0, flat.count >= stride * 2, flat.count % stride == 0, flatRest.count == stride, loopMs > 0
    else { return nil }
    let pose = { (values: ArraySlice<Double>) -> [[Double]] in
      (0..<dots).map { dot in Array(values.dropFirst(dot * 5).prefix(5)) }
    }
    samples = (0..<(flat.count / stride)).map { frame in
      pose(flat[(frame * stride)..<((frame + 1) * stride)])
    }
    rest = pose(flatRest[...])
    loop = loopMs / 1000
  }
}

/// Four 2pt dots placed exactly as the RN cell placed its Views: centred in the
/// cell, translated by (cx, cy) and scaled by (rx, ry), all in cell widths. The
/// loop is a linear keyframe animation over the same samples the RN worklet
/// interpolated linearly, so every in-between picture matches too.
final class PodiumWorkingMarkView: CoreMotionView {
  private static let sharedClock = MotionClock()
  override class var clock: MotionClock { sharedClock }

  private var dots: [CALayer] = []

  var tint: UIColor = .systemBlue {
    didSet { paint() }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    paint()
  }

  private func paint() {
    let resolved = tint.resolvedColor(with: traitCollection).cgColor
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    dots.forEach { $0.backgroundColor = resolved }
    CATransaction.commit()
  }

  private func transform(_ dot: [Double], width: CGFloat) -> CATransform3D {
    CATransform3DScale(
      CATransform3DMakeTranslation(CGFloat(dot[0]) * width, CGFloat(dot[1]) * width, 0),
      CGFloat(dot[2]) * width,
      CGFloat(dot[3]) * width,
      1
    )
  }

  private func ensureDots(_ count: Int) {
    guard dots.count != count else { return }
    dots.forEach { $0.removeFromSuperlayer() }
    dots = (0..<count).map { _ in
      let dot = CALayer()
      dot.bounds = CGRect(x: 0, y: 0, width: 2, height: 2)
      dot.cornerRadius = 1
      content.layer.addSublayer(dot)
      return dot
    }
    paint()
  }

  override func layoutMotion() {
    guard let frames = WorkingMarkFrames.shared else { return }
    ensureDots(frames.rest.count)
    // The RN dot View sits at left w/2 - 1, top h/2 - 1, which Yoga rounds to
    // the pixel grid (half pixels up); an odd-width cell would otherwise draw
    // half a pixel off the RN picture.
    let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : UIScreen.main.scale
    let snap = { (value: CGFloat) in (value * scale).rounded(.toNearestOrAwayFromZero) / scale }
    let center = CGPoint(x: snap(bounds.width / 2 - 1) + 1, y: snap(bounds.height / 2 - 1) + 1)
    for dot in dots { dot.position = center }
    showRest(frames)
  }

  private func showRest(_ frames: WorkingMarkFrames) {
    for (index, dot) in dots.enumerated() {
      dot.transform = transform(frames.rest[index], width: bounds.width)
      dot.opacity = Float(frames.rest[index][4])
    }
  }

  override func startMotion(at anchor: CFTimeInterval) {
    guard let frames = WorkingMarkFrames.shared else { return }
    ensureDots(frames.rest.count)
    let width = bounds.width
    let last = Double(frames.samples.count - 1)
    let keyTimes = frames.samples.indices.map { NSNumber(value: Double($0) / last) }
    for (index, dot) in dots.enumerated() {
      let move = CAKeyframeAnimation(keyPath: "transform")
      move.values = frames.samples.map { NSValue(caTransform3D: transform($0[index], width: width)) }
      move.keyTimes = keyTimes
      let fade = CAKeyframeAnimation(keyPath: "opacity")
      fade.values = frames.samples.map { NSNumber(value: $0[index][4]) }
      fade.keyTimes = keyTimes
      let group = CAAnimationGroup()
      group.animations = [move, fade]
      move.duration = frames.loop
      fade.duration = frames.loop
      dot.add(repeating(group, duration: frames.loop, anchor: anchor, on: dot), forKey: "working")
    }
  }

  override func stopMotion() {
    dots.forEach { $0.removeAnimation(forKey: "working") }
    if let frames = WorkingMarkFrames.shared { showRest(frames) }
  }
}

// MARK: - Working word glint

/// Desktop's glint window over the bright React copy: a 40%-wide window at 75%
/// opacity that travels from -40% to 100% of the word with ease-in-out over the
/// first 66% of 2.2s, then rests outside the text. The copy itself never moves;
/// only the mask layer does, which shows the same picture as RN's clipped window
/// with its counter-translated copy.
final class PodiumWorkingGlintView: CoreMotionView {
  private static let sharedClock = MotionClock()
  override class var clock: MotionClock { sharedClock }
  private static let period: CFTimeInterval = 2.2

  private let glintWindow = CALayer()

  var phase: Double = 0 {
    didSet { if phase != oldValue { restartIfRunning() } }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    glintWindow.backgroundColor = UIColor(white: 1, alpha: 0.75).cgColor
    glintWindow.anchorPoint = .zero
    content.layer.mask = glintWindow
  }

  override func layoutMotion() {
    glintWindow.bounds = CGRect(x: 0, y: 0, width: bounds.width * 0.4, height: bounds.height)
    glintWindow.position = .zero
    // At rest the window sits past the end of the word: nothing shows.
    glintWindow.transform = CATransform3DMakeTranslation(bounds.width, 0, 0)
  }

  override func startMotion(at anchor: CFTimeInterval) {
    let width = bounds.width
    let travel = CAKeyframeAnimation(keyPath: "transform.translation.x")
    travel.values = [-0.4 * width, width, width]
    travel.keyTimes = [0, 0.66, 1]
    travel.timingFunctions = [
      CAMediaTimingFunction(controlPoints: 0.42, 0, 0.58, 1),
      CAMediaTimingFunction(name: .linear),
    ]
    travel.timeOffset = phase * Self.period
    glintWindow.add(repeating(travel, duration: Self.period, anchor: anchor, on: glintWindow), forKey: "working")
  }

  override func stopMotion() {
    glintWindow.removeAnimation(forKey: "working")
  }
}

// MARK: - Streaming caret

/// The streaming caret's breathing: 1 → 0.25 → 1 opacity, 520ms each way,
/// shared by every visible caret. RN Animated's default easing is
/// `inOut(ease)`, i.e. `ease` (bezier 0.42, 0, 1, 1) for the first half and its
/// point reflection (bezier 0, 0, 0.58, 1) for the second; that curve is its own
/// time reversal, so autoreversing it also matches the RN return leg.
final class PodiumBlinkView: CoreMotionView {
  private static let sharedClock = MotionClock()
  override class var clock: MotionClock { sharedClock }

  override func startMotion(at anchor: CFTimeInterval) {
    let blink = CAKeyframeAnimation(keyPath: "opacity")
    blink.values = [1, 0.625, 0.25]
    blink.keyTimes = [0, 0.5, 1]
    blink.timingFunctions = [
      CAMediaTimingFunction(controlPoints: 0.42, 0, 1, 1),
      CAMediaTimingFunction(controlPoints: 0, 0, 0.58, 1),
    ]
    blink.autoreverses = true
    // `duration` is one way; autoreverse makes the 1.04s loop.
    content.layer.add(repeating(blink, duration: 0.52, anchor: anchor, on: content.layer), forKey: "working")
  }

  override func stopMotion() {
    content.layer.removeAnimation(forKey: "working")
  }
}

import Combine
import QuartzCore
import SwiftUI

/// One native clock for all visible words. No JS frames or per-row timers.
private final class WorkingWordClock: NSObject, ObservableObject {
  static let shared = WorkingWordClock()
  @Published private(set) var progress: Double = 0
  private var users = 0
  private var link: CADisplayLink?

  func subscribe() {
    users += 1
    guard link == nil else { return }
    let displayLink = CADisplayLink(target: self, selector: #selector(tick))
    displayLink.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
    displayLink.add(to: .main, forMode: .common)
    link = displayLink
  }

  func unsubscribe() {
    users -= 1
    guard users == 0 else { return }
    link?.invalidate()
    link = nil
    progress = 0
  }

  @objc private func tick(_ displayLink: CADisplayLink) {
    progress = displayLink.timestamp.truncatingRemainder(dividingBy: 2.2) / 2.2
  }
}

/// Applied to the native Text itself: its font, width and Dynamic Type metrics
/// also define the glint mask. Recycling never measures or positions an RN view.
struct WorkingWordModifier: ViewModifier {
  let phase: Double
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject private var clock = WorkingWordClock.shared
  @State private var visible = false
  @State private var subscribed = false

  init(phase: Double) {
    self.phase = phase
  }

  func body(content: Content) -> some View {
    content
      .overlay {
        if !reduceMotion {
          GeometryReader { geometry in
            Rectangle()
              .fill(Color.primary)
              .mask(content)
              .mask {
                LinearGradient(colors: [.clear, .white, .clear], startPoint: .leading, endPoint: .trailing)
                  .frame(width: geometry.size.width * 0.4)
                  .offset(x: offset(width: geometry.size.width))
                  .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
              }
          }
          .allowsHitTesting(false)
          .accessibilityHidden(true)
        }
      }
      .onAppear { visible = true; reconcile() }
      .onDisappear { visible = false; reconcile() }
      .onChange(of: reduceMotion) { _ in reconcile() }
      .onChange(of: scenePhase) { _ in reconcile() }
  }

  private func reconcile() {
    let wanted = visible && !reduceMotion && scenePhase != .background
    guard wanted != subscribed else { return }
    subscribed = wanted
    if wanted { clock.subscribe() } else { clock.unsubscribe() }
  }

  private func offset(width: CGFloat) -> CGFloat {
    let position = (clock.progress + phase).truncatingRemainder(dividingBy: 1)
    let travel = min(1, position / 0.66)
    return width * CGFloat(-0.4 + 1.4 * easeInOut(travel))
  }
}

/// CSS ease-in-out, cubic-bezier(0.42, 0, 0.58, 1), including iOS 16.4.
private func easeInOut(_ position: Double) -> Double {
  var lower = 0.0
  var upper = 1.0
  for _ in 0..<12 {
    let t = (lower + upper) / 2
    let x = 3 * (1 - t) * (1 - t) * t * 0.42 + 3 * (1 - t) * t * t * 0.58 + t * t * t
    if x < position { lower = t } else { upper = t }
  }
  let t = (lower + upper) / 2
  return t * t * (3 - 2 * t)
}

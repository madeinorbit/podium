import SwiftUI
import UIKit

/// Desktop's Working glint, applied to the native Text itself: its font, width and
/// Dynamic Type metrics also define the glint mask. Recycling never measures or
/// positions an RN view.
///
/// All words read the system animation timeline's date. Native row appearance,
/// navigator/page visibility and UIKit foreground state gate the timeline;
/// keeping a page mounted must not keep its words drawing off screen.
///
/// Never gate this on `@Environment(\.scenePhase)`: views hosted by @expo/ui's
/// UIHostingController are outside a SwiftUI scene and read the default
/// `.background` forever, which kept the glint static on every device.
struct WorkingWordModifier: ViewModifier {
  let phase: Double
  let active: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var visible = false
  @State private var foreground = UIApplication.shared.applicationState == .active

  func body(content: Content) -> some View {
    content
      .overlay {
        if active && visible && foreground && !reduceMotion {
          TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
            GeometryReader { geometry in
              Rectangle()
                .fill(Color.primary)
                .mask(content)
                .mask {
                  LinearGradient(colors: [.clear, .white, .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: geometry.size.width * 0.4)
                    .offset(x: glintOffset(at: timeline.date, width: geometry.size.width))
                    .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
                }
            }
          }
          .allowsHitTesting(false)
          .accessibilityHidden(true)
        }
      }
      .modifier(ContentVisibilityModifier { visible = $0 })
      .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in foreground = false }
      .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in foreground = true }
  }

  /// The window travels from -40% to 100% of the word over the first 66% of the
  /// period, then rests outside the text, as `flight-v6-glint-window` does.
  private func glintOffset(at date: Date, width: CGFloat) -> CGFloat {
    let period = 2.2
    let clock = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
    let position = (clock + phase).truncatingRemainder(dividingBy: 1)
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

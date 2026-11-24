import QuartzCore
import SwiftUI
import UIKit

/// Desktop's Working glint on a native List row's Text: a bright copy of the word
/// shown through a soft 40% window that travels from -40% to 100% of the word
/// over the first 66% of 2.2s, then rests outside the text, as
/// `flight-v6-glint-window` does.
///
/// The window is a Core Animation gradient mask with a repeating keyframe
/// animation, so the render server moves it; the app computes no frame. The
/// bright copy is a static SwiftUI Text (same string, text style, line limit
/// and Dynamic Type size) hosted in a UIKit view, because only a UIKit layer can
/// carry a render-server mask.
///
/// All words share one absolute clock (media time modulo the period) plus their
/// seed phase. Native row visibility (scroll viewport intersection), navigator
/// visibility through `active`, UIKit foreground state and Reduce Motion gate
/// the overlay; a gated-off row holds no copy and no animation.
///
/// Never gate this on `@Environment(\.scenePhase)`: views hosted by @expo/ui's
/// UIHostingController are outside a SwiftUI scene and read the default
/// `.background` forever, which kept the glint static on every device.
struct WorkingWordModifier: ViewModifier {
  let phase: Double
  let active: Bool
  let text: String
  let textStyle: Font.TextStyle
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.legibilityWeight) private var legibilityWeight
  @State private var visible = false
  @State private var foreground = UIApplication.shared.applicationState == .active

  func body(content: Content) -> some View {
    content
      .overlay {
        if active && visible && foreground && !reduceMotion {
          WorkingGlintOverlay(
            copy: GlintCopy(text: text, textStyle: textStyle, dynamicTypeSize: dynamicTypeSize, legibilityWeight: legibilityWeight),
            phase: phase
          )
          .allowsHitTesting(false)
          .accessibilityHidden(true)
        }
      }
      .modifier(ContentVisibilityModifier { visible = $0 })
      .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in foreground = false }
      .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in foreground = true }
  }
}

/// The bright copy: the word drawn exactly as the row's Text draws it (the
/// @expo/ui `font({ textStyle })` modifier resolves to `Font.system(style)`), in
/// the primary label colour, full size of the row's Text.
struct GlintCopy: View, Equatable {
  let text: String
  let textStyle: Font.TextStyle
  let dynamicTypeSize: DynamicTypeSize
  let legibilityWeight: LegibilityWeight?

  var body: some View {
    Text(text)
      .font(.system(textStyle, design: .default))
      .lineLimit(1)
      .foregroundStyle(Color.primary)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .dynamicTypeSize(dynamicTypeSize)
      .environment(\.legibilityWeight, legibilityWeight)
  }
}

private struct WorkingGlintOverlay: UIViewRepresentable {
  let copy: GlintCopy
  let phase: Double

  func makeUIView(context: Context) -> WorkingGlintHostView { WorkingGlintHostView(copy: copy) }

  func updateUIView(_ view: WorkingGlintHostView, context: Context) {
    view.configure(copy: copy, phase: phase)
  }
}

final class WorkingGlintHostView: UIView {
  private static let period: CFTimeInterval = 2.2

  private let host: UIHostingController<GlintCopy>
  private let glintWindow = CAGradientLayer()
  private var copy: GlintCopy
  private var phase: Double = 0
  private var laidOutSize: CGSize = .zero

  init(copy: GlintCopy) {
    self.copy = copy
    host = UIHostingController(rootView: copy)
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    host.view.backgroundColor = .clear
    host.view.isUserInteractionEnabled = false
    if #available(iOS 16.4, *) { host.safeAreaRegions = [] }
    addSubview(host.view)
    glintWindow.colors = [UIColor.clear.cgColor, UIColor.white.cgColor, UIColor.clear.cgColor]
    glintWindow.startPoint = CGPoint(x: 0, y: 0.5)
    glintWindow.endPoint = CGPoint(x: 1, y: 0.5)
    glintWindow.anchorPoint = .zero
    host.view.layer.mask = glintWindow
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  func configure(copy: GlintCopy, phase: Double) {
    if copy != self.copy {
      self.copy = copy
      host.rootView = copy
    }
    if phase != self.phase {
      self.phase = phase
      restart()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
    guard bounds.size != laidOutSize else { return }
    laidOutSize = bounds.size
    restart()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    restart()
  }

  private func restart() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    let width = bounds.width
    glintWindow.bounds = CGRect(x: 0, y: 0, width: width * 0.4, height: bounds.height)
    glintWindow.position = .zero
    // At rest the window sits past the end of the word: nothing shows.
    glintWindow.transform = CATransform3DMakeTranslation(width, 0, 0)
    glintWindow.removeAnimation(forKey: "working")
    guard window != nil, width > 0 else { return }
    let travel = CAKeyframeAnimation(keyPath: "transform.translation.x")
    travel.values = [-0.4 * width, width, width]
    travel.keyTimes = [0, 0.66, 1]
    travel.timingFunctions = [
      CAMediaTimingFunction(controlPoints: 0.42, 0, 0.58, 1),
      CAMediaTimingFunction(name: .linear),
    ]
    travel.duration = Self.period
    travel.repeatCount = .infinity
    travel.isRemovedOnCompletion = false
    // The shared absolute clock: every word is at (wall clock / period + phase).
    let now = CACurrentMediaTime()
    let clock = Date().timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period)
    travel.beginTime = host.view.layer.convertTime(now - clock, from: nil)
    travel.timeOffset = phase * Self.period
    glintWindow.add(travel, forKey: "working")
  }
}

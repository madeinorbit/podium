import ExpoModulesCore
import ExpoUI
import SwiftUI

private let rowHairlineModifier = "podiumRowHairline"
private let rowPressModifier = "podiumListRowPress"
private let searchStartsHiddenModifier = "podiumSearchStartsHidden"
private let workingWordModifier = "podiumWorkingWordGlint"
private let contentVisibilityModifier = "podiumContentVisibility"

public final class PodiumListRowModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PodiumListRow")

    // Called once on the JS thread by WorkingMark.ios.tsx, before any mark mounts.
    Function("setWorkingMarkFrames") { (samples: [Double], dots: Int, rest: [Double], loopMs: Double) in
      WorkingMarkFrames.shared = WorkingMarkFrames(samples: samples, dots: dots, rest: rest, loopMs: loopMs)
    }

    View(PodiumWorkingMarkView.self) {
      Prop("active") { (view: PodiumWorkingMarkView, active: Bool?) in view.active = active ?? false }
      Prop("tint") { (view: PodiumWorkingMarkView, tint: UIColor?) in view.tint = tint ?? .systemBlue }
    }

    View(PodiumWorkingGlintView.self) {
      Prop("active") { (view: PodiumWorkingGlintView, active: Bool?) in view.active = active ?? false }
      Prop("phase") { (view: PodiumWorkingGlintView, phase: Double?) in view.phase = phase ?? 0 }
    }

    View(PodiumBlinkView.self) {
      Prop("active") { (view: PodiumBlinkView, active: Bool?) in view.active = active ?? false }
    }

    OnCreate {
      ViewModifierRegistry.register(rowHairlineModifier) { params, _, _ in
        RowHairlineModifier(
          leading: params["leading"] as? Double ?? 0,
          trailing: params["trailing"] as? Double ?? 12,
          top: params["top"] as? Double ?? 0,
          visible: params["visible"] as? Bool ?? true
        )
      }
      ViewModifierRegistry.register(workingWordModifier) { params, _, _ in
        WorkingWordModifier(phase: params["phase"] as? Double ?? 0, active: params["active"] as? Bool ?? true)
      }
      ViewModifierRegistry.register(contentVisibilityModifier) { _, _, dispatcher in
        ContentVisibilityModifier { visible in
          dispatcher([contentVisibilityModifier: ["visible": visible]])
        }
      }
      ViewModifierRegistry.register(rowPressModifier) { _, _, dispatcher in
        ListRowPressModifier(dispatcher: dispatcher)
      }
      ViewModifierRegistry.register(searchStartsHiddenModifier) { params, _, dispatcher in
        SearchStartsHiddenModifier(canTuck: params["canTuck"] as? Bool, dispatcher: dispatcher)
      }
    }

    OnDestroy {
      ViewModifierRegistry.unregister(rowHairlineModifier)
      ViewModifierRegistry.unregister(workingWordModifier)
      ViewModifierRegistry.unregister(contentVisibilityModifier)
      ViewModifierRegistry.unregister(rowPressModifier)
      ViewModifierRegistry.unregister(searchStartsHiddenModifier)
    }
  }
}

/// Movement past this many points makes the touch a drag, never a tap.
private let dragSlop: CGFloat = 8

/// Whether the current touch sequence moved past the slop. A reference, so the
/// tracker can write it mid-touch without re-rendering the row; each new
/// sequence starts clean, so a tap right after a drag still opens the row.
private final class TouchSequence {
  var moved = false
}

/// Wraps a row's label in the List's own Button, so the system draws the cell's
/// touch-down highlight (with no custom listRowBackground on the row), and opens
/// the row once from a recognized tap, VoiceOver/Switch Control activation, or
/// Return/Space.
///
/// The Button's own action stays empty: SwiftUI's context-menu bridge runs it as
/// the menu's preview action. A TapGesture tolerates tens of points of movement,
/// so a short rightward drag (no leading swipe actions claim it) used to open
/// rows; a passive UIKit touch tracker rejects any tap that follows movement past
/// the slop. A SwiftUI DragGesture cannot do this job: even as a simultaneous
/// gesture it stops the List scrolling when a drag starts on a row.
private struct ListRowPressModifier: ViewModifier {
  let dispatcher: EventDispatcher
  @State private var touch = TouchSequence()

  func body(content: Content) -> some View {
    let button = Button {} label: {
      // A List Button tints its label; hierarchical styles inside derive from
      // this, so rows keep the system label colours instead of the accent.
      content.foregroundStyle(Color.primary)
    }
    .buttonStyle(.automatic)
    .modifier(TouchMovement(touch: touch))
    .simultaneousGesture(
      TapGesture().onEnded {
        if !touch.moved { activate() }
      }
    )
    .accessibilityAction { activate() }

    if #available(iOS 17.0, *) {
      button.onKeyPress(keys: [.return, .space], phases: .up) { _ in
        activate()
        return .handled
      }
    } else {
      button
    }
  }

  private func activate() {
    dispatcher([rowPressModifier: [:]])
  }
}

/// Reports touch movement past the slop without ever taking part in gesture
/// resolution: the recognizer never leaves `.possible` until it fails at touch-up.
private struct TouchMovement: ViewModifier {
  let touch: TouchSequence

  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content.gesture(TouchMovementGesture(touch: touch))
    } else {
      content
    }
  }
}

@available(iOS 18.0, *)
private struct TouchMovementGesture: UIGestureRecognizerRepresentable {
  let touch: TouchSequence

  func makeUIGestureRecognizer(context: Context) -> TouchMovementRecognizer {
    let recognizer = TouchMovementRecognizer()
    recognizer.delegate = context.coordinator
    return recognizer
  }

  func updateUIGestureRecognizer(_ recognizer: TouchMovementRecognizer, context: Context) {
    recognizer.touch = touch
  }

  func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { true }
  }
}

final class TouchMovementRecognizer: UIGestureRecognizer {
  fileprivate var touch: TouchSequence?
  private var start: CGPoint?

  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }

  convenience init() { self.init(target: nil, action: nil) }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    // A new sequence (not a second finger joining this one) starts unmoved.
    guard start == nil else { return }
    start = touches.first?.location(in: nil)
    touch?.moved = false
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
    guard let start, let point = touches.first?.location(in: nil) else { return }
    if hypot(point.x - start.x, point.y - start.y) > dragSlop { touch?.moved = true }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    // Report the release position too: a fast flick may deliver no move event.
    touchesMoved(touches, with: event)
    state = .failed
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    state = .failed
  }

  override func reset() {
    start = nil
  }
}

/// Prepare initial search while the launch surface is still opaque. Native
/// opacity is checked as well as JS permission: a delayed prop commit cannot
/// move an already-visible list. No scroll animation is ever started.
private struct SearchStartsHiddenModifier: ViewModifier {
  let canTuck: Bool?
  let dispatcher: EventDispatcher

  func body(content: Content) -> some View {
    content.background(SearchStartsHiddenProbe(canTuck: canTuck, onReady: {
      dispatcher([searchStartsHiddenModifier: [:]])
    }).frame(width: 0, height: 0))
  }
}

private struct SearchStartsHiddenProbe: UIViewRepresentable {
  let canTuck: Bool?
  let onReady: () -> Void

  func makeUIView(context: Context) -> SearchStartsHiddenView { SearchStartsHiddenView() }
  func updateUIView(_ uiView: SearchStartsHiddenView, context: Context) {
    uiView.configure(canTuck: canTuck, onReady: onReady)
  }
}

/// Observe first interaction without delaying or cancelling UIKit/RN gestures.
/// Keep the latch after the recognizer resets so a late attachment cannot move
/// content after the person has already tapped or dragged it.
private final class InitialSearchTouchObserver: UIGestureRecognizer {
  private(set) var touched = false

  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    touched = true
    state = .failed
  }
}

final class SearchStartsHiddenView: UIView {
  private var started = false
  private var settled = false
  private var preparing = false
  private var canTuck: Bool?
  private var onReady: (() -> Void)?
  private var retryAttempt = 0
  private var retryWork: DispatchWorkItem?
  private weak var launchOverlay: UIView?
  private var foundLaunchOverlay = false
  private let touchObserver = InitialSearchTouchObserver(target: nil, action: nil)

  func configure(canTuck: Bool?, onReady: @escaping () -> Void) {
    guard !settled else { return }
    self.canTuck = canTuck
    self.onReady = onReady
    // Registration belongs to every mounted List, even when the launch tuck
    // is forbidden. Finishing here used to skip didMoveToWindow entirely.
    if started { tuck() }
    else { startIfReady() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil, started { finish() }
    else { startIfReady() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // SwiftUI can attach/layout the List after the probe enters the window.
    // Try in that layout turn rather than waiting for the next 50ms poll.
    if started { tuck() }
  }

  private func startIfReady() {
    guard !started, !settled, window != nil else { return }
    started = true
    tuck()
  }

  private func finish() {
    guard !settled else { return }
    settled = true
    retryWork?.cancel()
    retryWork = nil
    touchObserver.view?.removeGestureRecognizer(touchObserver)
    onReady?()
    onReady = nil
  }

  private func retry() {
    guard retryWork == nil else { return }
    guard retryAttempt < 40 else { finish(); return }
    let immediate = retryAttempt == 0
    retryAttempt += 1
    let work = DispatchWorkItem { [weak self] in
      self?.retryWork = nil
      self?.tuck()
    }
    retryWork = work
    if immediate { DispatchQueue.main.async(execute: work) }
    else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: work) }
  }

  private func tuck() {
    guard !settled, !preparing else { return }
    guard window != nil else { finish(); return }
    preparing = true
    defer { preparing = false }
    // Restore the original attachment boundary before making any launch-only
    // decision. Native large-title and scroll-edge tracking need this on later
    // tabs too; UIKit's implicit discovery does not reach the SwiftUI List.
    guard let list = trackedList(), let screen = searchScreen(),
      let search = screen.navigationItem.searchController,
      list.window === window, list.contentSize.height > 0
    else { retry(); return }
    if screen.contentScrollView(for: .top) !== list {
      screen.setContentScrollView(list, for: .top)
    }
    guard let canTuck else { return }
    guard canTuck, !touchObserver.touched else { finish(); return }
    // A non-animated search offset also collapses UIKit's large title at AX
    // sizes. Keep its native expanded resting state and visible search instead
    // of scrolling the segments under the bar. Registration above still applies.
    guard !traitCollection.preferredContentSizeCategory.isAccessibilityCategory
    else { finish(); return }
    if touchObserver.view == nil { window?.addGestureRecognizer(touchObserver) }
    if launchOverlay == nil, !foundLaunchOverlay {
      launchOverlay = findLaunchOverlay()
      foundLaunchOverlay = launchOverlay != nil
    }
    guard let overlay = launchOverlay else {
      if foundLaunchOverlay { finish() } else { retry() }
      return
    }
    // React owns the overlay's hit policy. Observe its opacity without changing
    // interaction on any native view during startup preparation.
    let opacity = overlay.layer.presentation()?.opacity ?? overlay.layer.opacity
    guard overlay.window === window, !overlay.isHidden, opacity >= 0.999 else { finish(); return }
    guard let navigationBar = screen.navigationController?.navigationBar
    else { retry(); return }
    guard !search.isActive, search.searchBar.text?.isEmpty ?? true,
      !list.isTracking, !list.isDragging, !list.isDecelerating,
      list.refreshControl?.isRefreshing != true
    else { finish(); return }
    UIView.performWithoutAnimation {
      screen.navigationController?.view.layoutIfNeeded()
      list.layoutIfNeeded()
    }
    guard list.window === window, search.searchBar.window === window,
      navigationBar.window === window
    else { retry(); return }
    let rest = -list.adjustedContentInset.top
    let presented = list.layer.presentation()?.bounds.origin.y ?? list.contentOffset.y
    guard abs(list.contentOffset.y - rest) <= 1, abs(presented - rest) <= 1 else { finish(); return }
    // Convert to the list's viewport coordinates, independent of its offset.
    let viewportY = list.bounds.minY
    let navigationFrame = navigationBar.convert(navigationBar.bounds, to: list).offsetBy(dx: 0, dy: -viewportY)
    let searchFrame = search.searchBar.convert(search.searchBar.bounds, to: list).offsetBy(dx: 0, dy: -viewportY)
    guard let target = initialSearchTuckOffset(
      adjustedTopInset: list.adjustedContentInset.top,
      contentTopInset: list.contentInset.top,
      navigationFrame: navigationFrame,
      searchFrame: searchFrame
    ) else { retry(); return }
    UIView.performWithoutAnimation {
      list.setContentOffset(CGPoint(x: list.contentOffset.x, y: target), animated: false)
      list.layoutIfNeeded()
      navigationBar.setNeedsLayout()
      navigationBar.layoutIfNeeded()
    }
    finish()
  }

  private func findLaunchOverlay() -> UIView? {
    guard let window else { return nil }
    var queue: [UIView] = [window]
    while !queue.isEmpty {
      let view = queue.removeFirst()
      if view.accessibilityIdentifier == "podium-launch-overlay" { return view }
      queue.append(contentsOf: view.subviews)
    }
    return nil
  }

  /// The List's collection view: the first one in the nearest enclosing subtree.
  private func trackedList() -> UIScrollView? {
    var ancestor = superview
    while let view = ancestor {
      var queue = [view]
      while !queue.isEmpty {
        let next = queue.removeFirst()
        if let list = next as? UICollectionView { return list }
        queue.append(contentsOf: next.subviews)
      }
      ancestor = view.superview
    }
    return nil
  }

  /// The screen controller whose navigation item carries the search field.
  private func searchScreen() -> UIViewController? {
    var responder: UIResponder? = self
    while let current = responder {
      var controller = current as? UIViewController
      while let vc = controller {
        if vc.navigationItem.searchController != nil { return vc }
        controller = vc.parent
      }
      responder = current.next
    }
    return nil
  }
}

/// Keep the separator independent of text scaling, and extend through List's
/// trailing content inset. The List still owns cell layout and backgrounds.
private struct RowHairlineModifier: ViewModifier {
  @Environment(\.displayScale) private var displayScale
  let leading: Double
  let trailing: Double
  let top: Double
  let visible: Bool

  func body(content: Content) -> some View {
    content
      .listRowSeparator(.hidden)
      .overlay(alignment: .topLeading) {
        if visible {
          Rectangle()
            .fill(Color(uiColor: .separator))
            .frame(height: 1 / max(displayScale, 1))
            .padding(.leading, leading)
            .padding(.trailing, -trailing)
            .offset(y: -top)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
      }
  }
}

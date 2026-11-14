import ExpoModulesCore
import ExpoUI
import SwiftUI

private let rowPressModifier = "podiumListRowPress"
private let searchStartsHiddenModifier = "podiumSearchStartsHidden"

public final class PodiumListRowModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PodiumListRow")

    OnCreate {
      ViewModifierRegistry.register(rowPressModifier) { _, _, dispatcher in
        ListRowPressModifier(dispatcher: dispatcher)
      }
      ViewModifierRegistry.register(searchStartsHiddenModifier) { _, _, _ in
        SearchStartsHiddenModifier()
      }
    }

    OnDestroy {
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

/// UIKit shows a stacked `hidesSearchBarWhenScrolling` search field when its list
/// first appears at rest. Lists should open with the field tucked under the large
/// title, revealed only by a deliberate pull. Once per mounted list this names the
/// List's collection view as the screen's top content scroll view (UIKit's implicit
/// discovery follows drags but ignores programmatic scrolls) and scrolls it by the
/// field's height. Only an animated scroll goes through UIKit's search-hiding path;
/// a programmatic jump collapses the large title too. On a cold launch this runs
/// beneath the splash overlay.
private struct SearchStartsHiddenModifier: ViewModifier {
  func body(content: Content) -> some View {
    content.background(SearchStartsHiddenProbe().frame(width: 0, height: 0))
  }
}

private struct SearchStartsHiddenProbe: UIViewRepresentable {
  func makeUIView(context: Context) -> SearchStartsHiddenView { SearchStartsHiddenView() }
  func updateUIView(_ uiView: SearchStartsHiddenView, context: Context) {}
}

final class SearchStartsHiddenView: UIView {
  private var settled = false

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { DispatchQueue.main.async { self.tuck(attempt: 0) } }
  }

  private func tuck(attempt: Int) {
    guard !settled, window != nil else { return }
    guard let list = trackedList(), let screen = searchScreen(),
      let search = screen.navigationItem.searchController, list.contentSize.height > 0
    else {
      // The list and the header's search controller attach over a few frames.
      if attempt < 40 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.tuck(attempt: attempt + 1) }
      }
      return
    }
    settled = true
    screen.setContentScrollView(list, for: .top)
    let bar = search.searchBar
    let height = bar.bounds.height
    let rest = -list.adjustedContentInset.top
    // Hidden fields have zero height. Leave an active or filled field, and any
    // list the person is already moving, alone.
    guard height > 1, !search.isActive, bar.text?.isEmpty ?? true,
      !list.isTracking, !list.isDecelerating, list.contentOffset.y <= rest + 1
    else { return }
    list.setContentOffset(CGPoint(x: list.contentOffset.x, y: rest + height), animated: true)
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

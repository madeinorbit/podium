import ExpoModulesCore
import ObjectiveC
import UIKit

/// A horizontal pager built on the system paging scroll view, the recognizer
/// Photos, Safari and the App Store page with. UIKit owns tracking, the axis
/// decision, velocity-aware snapping, rubber-banding and every animation; this
/// file only states how the pager relates to the gestures around it:
///
/// - Drags under 45° from horizontal page; steeper ones belong to the page's
///   vertical scroller. Every scroller inside a page waits for the pager to fail,
///   so one gesture never moves both axes.
/// - The navigation stack's edge back swipe is required to fail first (react-
///   native-screens declares that for every scroll view). On the first page a
///   rightward drag never begins here, so the iOS 26 content back swipe gets it.
/// - Inner horizontal scrollers (code blocks, tables) that can still move in the
///   drag's direction scroll first; at their edge the next drag pages.
/// - Row swipe actions must fail before the pager begins, and an active text
///   selection, context menu or other gesture under the finger keeps it still.
///   Drags that start on the composer or a text input never page.
public final class PodiumPagerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PodiumPager")

    View(PodiumPagerView.self) {
      Events("onPageChange", "onPageSettle")

      Prop("backSwipeOnFirstPage") { (view: PodiumPagerView, enabled: Bool?) in
        view.scroller.yieldsFirstPageBackSwipe = enabled ?? true
      }

      AsyncFunction("setPage") { (view: PodiumPagerView, page: Int, animated: Bool) in
        view.setPage(page, animated: animated)
      }.runOnQueue(.main)
    }
  }
}

final class PodiumPagerView: ExpoView, UIScrollViewDelegate {
  /// The page nearest the current offset; fires as a drag crosses the midpoint.
  let onPageChange = EventDispatcher()
  /// The page the pager came to rest on.
  let onPageSettle = EventDispatcher()

  let scroller = PagerScrollView()
  private var pages: [UIView] = []
  private var nearest = 0
  private var resting = 0
  private var laidOutWidth: CGFloat = 0
  /// Scrollers on the hidden page whose status-bar scroll-to-top this pager
  /// switched off, so only the visible page answers a status bar tap.
  private let mutedScrollers = NSHashTable<UIScrollView>.weakObjects()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    scroller.delegate = self
    addSubview(scroller)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let size = bounds.size
    guard size.width > 0 else { return }
    scroller.frame = bounds
    scroller.contentSize = CGSize(
      width: size.width * CGFloat(max(1, pages.count)),
      height: size.height
    )
    if size.width != laidOutWidth {
      laidOutWidth = size.width
      if !scroller.isTracking && !scroller.isDecelerating {
        scroller.contentOffset = CGPoint(x: CGFloat(resting) * size.width, y: 0)
      }
      updatePageVisibility()
    }
  }

  // Fabric mounts the page components inside the scroll view; their frames are
  // Yoga's (page i sits at x = i × width), which are content coordinates here.
  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    scroller.insertSubview(childComponentView, at: index)
    pages.insert(childComponentView, at: min(index, pages.count))
    setNeedsLayout()
    updatePageVisibility()
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    childComponentView.removeFromSuperview()
    pages.removeAll { $0 === childComponentView }
    setNeedsLayout()
  }

  func setPage(_ page: Int, animated: Bool) {
    let target = max(0, min(page, max(0, pages.count - 1)))
    let width = scroller.bounds.width
    guard width > 0 else {
      resting = target
      return
    }
    let offset = CGPoint(x: CGFloat(target) * width, y: 0)
    if scroller.contentOffset == offset {
      settle()
      return
    }
    // The system scroll animation runs on the render server, like a user flick.
    scroller.setContentOffset(offset, animated: animated)
    if !animated { settle() }
  }

  // MARK: UIScrollViewDelegate

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let page = pageAt(scrollView.contentOffset.x)
    if page != nearest {
      nearest = page
      onPageChange(["page": page])
    }
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    // A page drag is never a tap: end the JS touch the finger started, so no
    // Pressable under it fires on release.
    cancelReactTouches()
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { settle() }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    settle()
  }

  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
    settle()
  }

  // MARK: Private

  private func pageAt(_ x: CGFloat) -> Int {
    let width = scroller.bounds.width
    guard width > 0, !pages.isEmpty else { return 0 }
    return max(0, min(pages.count - 1, Int((x / width).rounded())))
  }

  private func settle() {
    let page = pageAt(scroller.contentOffset.x)
    resting = page
    if page != nearest {
      nearest = page
      onPageChange(["page": page])
    }
    updatePageVisibility()
    onPageSettle(["page": page])
  }

  /// Only the resting page is reachable by VoiceOver and the status bar tap.
  private func updatePageVisibility() {
    for (index, page) in pages.enumerated() {
      let visible = index == resting
      page.accessibilityElementsHidden = !visible
      if visible {
        for scrollView in mutedScrollers.allObjects where scrollView.isDescendant(of: page) {
          scrollView.scrollsToTop = true
          mutedScrollers.remove(scrollView)
        }
      } else {
        muteScrollsToTop(in: page)
      }
    }
  }

  private func muteScrollsToTop(in view: UIView) {
    if let scrollView = view as? UIScrollView, scrollView.scrollsToTop {
      scrollView.scrollsToTop = false
      mutedScrollers.add(scrollView)
    }
    for subview in view.subviews { muteScrollsToTop(in: subview) }
  }

  private func cancelReactTouches() {
    var view: UIView? = self
    while let current = view {
      for recognizer in current.gestureRecognizers ?? []
      where recognizer.isEnabled && NSStringFromClass(type(of: recognizer)).hasSuffix("TouchHandler") {
        recognizer.isEnabled = false
        recognizer.isEnabled = true
      }
      view = current.superview
    }
  }
}

final class PagerScrollView: UIScrollView {
  /// On the first page a rightward drag is left to the navigation back swipe.
  var yieldsFirstPageBackSwipe = true

  override init(frame: CGRect) {
    super.init(frame: frame)
    isPagingEnabled = true
    isDirectionalLockEnabled = true
    bounces = true
    alwaysBounceHorizontal = true
    alwaysBounceVertical = false
    showsHorizontalScrollIndicator = false
    showsVerticalScrollIndicator = false
    // The visible page's own scroller answers the status bar tap.
    scrollsToTop = false
    // Touches reach the pages at once; the pan cancels them if it pages.
    delaysContentTouches = false
    canCancelContentTouches = true
    contentInsetAdjustmentBehavior = .never
    automaticallyAdjustsScrollIndicatorInsets = false
    // Paging with the keyboard up must not drop the draft's focus mid-drag.
    keyboardDismissMode = .none
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  // Controls inside pages (buttons, SwiftUI rows) never hold the pan back.
  override func touchesShouldCancel(in view: UIView) -> Bool {
    true
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === panGestureRecognizer else {
      return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
    guard super.gestureRecognizerShouldBegin(gestureRecognizer), bounds.width > 0 else {
      return false
    }
    let pan = panGestureRecognizer
    let translation = pan.translation(in: self)
    var dx = translation.x
    var dy = translation.y
    if dx == 0 && dy == 0 {
      let velocity = pan.velocity(in: self)
      dx = velocity.x
      dy = velocity.y
    }
    // Axis lock by dominant angle: page only below 45°.
    guard abs(dx) > abs(dy) else { return false }
    if yieldsFirstPageBackSwipe && dx > 0 && contentOffset.x <= 1 { return false }
    let location = pan.location(in: self)
    let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
    return !somethingUnderFingerClaims(start, dx: dx)
  }

  /// Every scroller inside a page waits for the pager's axis decision.
  @objc(gestureRecognizer:shouldBeRequiredToFailByGestureRecognizer:)
  func pagerShouldBeRequiredToFail(
    _ gestureRecognizer: UIGestureRecognizer,
    by other: UIGestureRecognizer
  ) -> Bool {
    if gestureRecognizer === panGestureRecognizer, isInnerScrollPan(other) { return true }
    return forwardRelation(
      #selector(pagerShouldBeRequiredToFail(_:by:)), gestureRecognizer, other)
  }

  /// Row swipe actions (Start, Backlog, Dismiss) decide before the pager does.
  @objc(gestureRecognizer:shouldRequireFailureOfGestureRecognizer:)
  func pagerShouldRequireFailure(
    _ gestureRecognizer: UIGestureRecognizer,
    of other: UIGestureRecognizer
  ) -> Bool {
    if gestureRecognizer === panGestureRecognizer, isInnerRowSwipe(other) { return true }
    return forwardRelation(
      #selector(pagerShouldRequireFailure(_:of:)), gestureRecognizer, other)
  }

  private func isInside(_ recognizer: UIGestureRecognizer) -> Bool {
    guard let view = recognizer.view, view !== self else { return false }
    return view.isDescendant(of: self)
  }

  private func isInnerScrollPan(_ recognizer: UIGestureRecognizer) -> Bool {
    guard isInside(recognizer), let scrollView = recognizer.view as? UIScrollView else {
      return false
    }
    return scrollView.panGestureRecognizer === recognizer
  }

  private func isInnerRowSwipe(_ recognizer: UIGestureRecognizer) -> Bool {
    guard isInside(recognizer) else { return false }
    let name = NSStringFromClass(type(of: recognizer))
    return name.contains("SwipeAction") || name.contains("SwipeHandler")
  }

  private func somethingUnderFingerClaims(_ point: CGPoint, dx: CGFloat) -> Bool {
    var view = hitTest(point, with: nil)
    while let current = view, current !== self {
      if let identifier = current.accessibilityIdentifier, identifier.contains("composer") {
        return true
      }
      if let textView = current as? UITextView, textView.isEditable { return true }
      if current is UITextField { return true }
      if let scrollView = current as? UIScrollView, canScroll(scrollView, dx: dx) { return true }
      for recognizer in current.gestureRecognizers ?? []
      where (recognizer.state == .began || recognizer.state == .changed) && holdsTouch(recognizer) {
        return true
      }
      view = current.superview
    }
    return false
  }

  /// Text selection (its loupe and handles) and long-press menus own the touch
  /// once they have begun. Passive trackers that also report `.began` do not.
  private func holdsTouch(_ recognizer: UIGestureRecognizer) -> Bool {
    if recognizer is UILongPressGestureRecognizer { return true }
    let name = NSStringFromClass(type(of: recognizer))
    return ["Loupe", "TextRange", "TextSelection", "ContextMenu", "Highlight"].contains {
      name.contains($0)
    }
  }

  /// Whether an inner scroller can still move with a drag of this direction.
  private func canScroll(_ scrollView: UIScrollView, dx: CGFloat) -> Bool {
    guard scrollView.isScrollEnabled else { return false }
    let inset = scrollView.adjustedContentInset
    let minX = -inset.left
    let maxX = scrollView.contentSize.width + inset.right - scrollView.bounds.width
    guard maxX > minX + 1 else { return false }
    // A leftward drag (dx < 0) moves content toward larger offsets.
    return dx < 0 ? scrollView.contentOffset.x < maxX - 1 : scrollView.contentOffset.x > minX + 1
  }

  /// UIScrollView implements some delegate relations privately; keep its answer
  /// for every pair this pager has no opinion on.
  private func forwardRelation(
    _ selector: Selector,
    _ gestureRecognizer: UIGestureRecognizer,
    _ other: UIGestureRecognizer
  ) -> Bool {
    guard let method = class_getInstanceMethod(UIScrollView.self, selector) else { return false }
    typealias Relation = @convention(c) (
      AnyObject, Selector, UIGestureRecognizer, UIGestureRecognizer
    ) -> Bool
    let implementation = unsafeBitCast(method_getImplementation(method), to: Relation.self)
    return implementation(self, selector, gestureRecognizer, other)
  }
}

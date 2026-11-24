import ExpoModulesCore
import ObjectiveC
import UIKit

/// A horizontal pager built on the system paging scroll view, the recognizer
/// Photos, Safari and the App Store page with. UIKit owns tracking, the axis
/// decision, velocity-aware snapping, rubber-banding and every animation; this
/// file only states how the pager relates to the gestures around it:
///
/// - Drags under 45° from horizontal page; steeper ones belong to the page's
///   vertical scroller. The pager and a page's vertical list each track their
///   own axis and the first past its slop takes the drag, so vertical scrolling
///   starts on the first frame of a vertical drag, as in Mail. Inner scrollers
///   that can move sideways wait for the pager to fail, so one gesture never
///   moves both of them.
/// - The navigation stack's edge back swipe is required to fail first (react-
///   native-screens declares that for every scroll view). On the first page a
///   rightward drag never begins here, so the iOS 26 content back swipe gets it.
///   Once the offset leaves the first page the pager switches the stack's back
///   swipes off itself, in the same frame, so every left-to-right drag on the
///   second page (from the edge too) pages back, however busy JS is.
/// - Inner horizontal scrollers (code blocks, tables) that can still move in the
///   drag's direction scroll first; at their edge the next drag pages.
/// - Row swipe actions wait for the pager. A rightward drag away from the first
///   page always pages back, even across a row, so a page-back flick can never
///   be read as a row swipe [POD-2527]. A leftward drag that starts on a list row
///   belongs to the row's trailing actions, and while a row shows its actions a
///   drag on that list closes them instead of paging. Row actions only reveal
///   (RevealSwipeActions); none commits on a full swipe.
/// - An active text selection, context menu or other gesture under the finger
///   keeps the pager still.
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
  /// The stack whose back swipes this pager switched off while away from page 0.
  private weak var blockedStack: UINavigationController?
  /// The visible page's vertical list: the screen's content scroll view, so the
  /// nav bar's scroll edge lands on it rather than on this horizontal pager.
  private weak var edgeList: UIScrollView?
  private weak var edgeController: UIViewController?
  private let edgeHeaders = NSHashTable<UIView>.weakObjects()
  /// Re-finds `edgeList` after React remounts a page's list (a session switch).
  private var edgeCheck: Timer?
  #if DEBUG
  private var edgeDiagnostic: String?
  #endif

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    scroller.delegate = self
    addSubview(scroller)
    NotificationCenter.default.addObserver(
      self, selector: #selector(revalidateScrollEdge),
      name: UIApplication.didBecomeActiveNotification, object: nil)
  }

  deinit {
    edgeCheck?.invalidate()
    NotificationCenter.default.removeObserver(self)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let size = bounds.size
    guard size.width > 0, size.height > 0 else {
      clearScrollEdge()
      return
    }
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
    updateScrollEdge()
  }

  // Fabric mounts the page components inside the scroll view; their frames are
  // Yoga's (page i sits at x = i × width), which are content coordinates here.
  override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    scroller.insertSubview(childComponentView, at: index)
    pages.insert(childComponentView, at: min(index, pages.count))
    setNeedsLayout()
    updatePageVisibility()
    updateScrollEdge()
  }

  override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    clearHeaderEdges(in: childComponentView)
    childComponentView.removeFromSuperview()
    pages.removeAll { $0 === childComponentView }
    setNeedsLayout()
    updateScrollEdge()
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
    updateBackSwipe()
    let page = pageAt(scrollView.contentOffset.x)
    if page != nearest {
      nearest = page
      updateScrollEdge()
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

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // A screen pushed over this one (or this one popping) must get its back
    // swipe: only a pager on screen, away from page 0, holds it off.
    updateBackSwipe()
    edgeCheck?.invalidate()
    edgeCheck = nil
    guard window != nil else {
      clearScrollEdge()
      return
    }
    updateScrollEdge()
    // React can mount the transcript or header without changing the pager's
    // frame. Reconcile their identities too, not just the old list's window.
    edgeCheck = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      self?.revalidateScrollEdge()
    }
  }

  // MARK: Private

  /// The stack's edge and content back swipes belong to the chat page only.
  /// React Native Screens never toggles these recognizers' `isEnabled` (it
  /// answers through their delegate), so the pager owns that switch.
  private func updateBackSwipe() {
    let block = window != nil && scroller.contentOffset.x > 1
    if block {
      guard blockedStack == nil, let stack = navigationController() else { return }
      // This screen re-enters the window during a pop back to it, which may be
      // the interactive back swipe itself: switching its recognizer off then
      // would strand the transition halfway. Decide once the transition ends.
      if let transition = stack.transitionCoordinator {
        transition.animate(alongsideTransition: nil) { [weak self] _ in self?.updateBackSwipe() }
        return
      }
      blockedStack = stack
      setBackSwipes(of: stack, enabled: false)
    } else if let stack = blockedStack {
      blockedStack = nil
      setBackSwipes(of: stack, enabled: true)
    }
  }

  private func setBackSwipes(of stack: UINavigationController, enabled: Bool) {
    stack.interactivePopGestureRecognizer?.isEnabled = enabled
    if #available(iOS 26.0, *) {
      stack.interactiveContentPopGestureRecognizer?.isEnabled = enabled
    }
  }

  private func navigationController() -> UINavigationController? {
    var responder: UIResponder? = self
    while let current = responder {
      if let controller = current as? UIViewController, let stack = controller.navigationController {
        return stack
      }
      responder = current.next
    }
    return nil
  }

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
    updateScrollEdge()
    onPageSettle(["page": page])
  }

  // MARK: Scroll edge

  /// iOS 26 draws the nav bar's scroll edge on the screen's content scroll
  /// view, and UIKit's heuristic picks this horizontal pager, so the transcript
  /// ran crisp under the bar [POD-2527]. The screen is pointed at the visible
  /// page's list instead, and views marked `header-extension` (the mission
  /// status bar) are edge containers for the visible page's list, with the hard
  /// edge a pinned strip calls for, so bar and strip sit on one backing. The deck's
  /// SwiftUI list takes no UIKit edge effect from in here; its page draws a
  /// bar-material band itself (HeaderBand).
  private func updateScrollEdge() {
    guard window != nil, pages.indices.contains(nearest) else {
      clearScrollEdge()
      return
    }
    let visible = pages[nearest]
    // A loading skeleton and the composer's UITextView can both be the first
    // full-width UIScrollView. Only the transcript's explicit marker is a chat
    // edge target, including while its first layout is still pending.
    let list = nearest == 0 ? transcriptList(in: visible) : primaryList(in: visible)
    if #available(iOS 26.0, *) {
      scroller.topEdgeEffect.isHidden = true
      let visibleHeaders = headerExtensions(in: visible)
      for view in edgeHeaders.allObjects where !visibleHeaders.contains(where: { $0 === view }) {
        clearHeaderEdge(on: view)
      }
      for page in pages {
        for view in headerExtensions(in: page) {
          let frame = view.convert(view.bounds, to: visible)
          guard page === visible, let list, list.window === window,
            view.bounds.width > 0, view.bounds.height > 0,
            frame.minY >= 0, frame.maxY < visible.bounds.height,
            visible.bounds.contains(frame)
          else {
            clearHeaderEdge(on: view)
            continue
          }
          let interaction = edgeInteraction(on: view)
          if interaction.scrollView !== list {
            interaction.scrollView?.topEdgeEffect.style = .soft
            interaction.scrollView = list
          }
          edgeHeaders.add(view)
          // A pinned, tappable strip under the bar takes the hard edge (HIG), so
          // the whole strip sits on the bar material, not on a fading blur.
          if list.topEdgeEffect.style != .hard { list.topEdgeEffect.style = .hard }
          assert(interaction.scrollView?.isDescendant(of: visible) == true)
        }
      }
    }
    let controller = owningController()
    if edgeController !== controller {
      clearContentScrollView()
      edgeController = controller
    }
    edgeList = list
    if let controller, controller.contentScrollView(for: .top) !== list {
      controller.setContentScrollView(list, for: .top)
    }
    #if DEBUG
    let headers = headerExtensions(in: visible).map { $0.convert($0.bounds, to: visible) }
    let target = list.map { "\(type(of: $0))@\(ObjectIdentifier($0)) \($0.convert($0.bounds, to: visible))" } ?? "none"
    let diagnostic = "page=\(nearest) offset=\(scroller.contentOffset.x) pageBounds=\(visible.bounds) list=\(target) headers=\(headers)"
    if edgeDiagnostic != diagnostic {
      edgeDiagnostic = diagnostic
      NSLog("[PodiumPager] scroll-edge %@", diagnostic)
    }
    #endif
  }

  private func clearContentScrollView() {
    if let controller = edgeController, let list = edgeList,
      controller.contentScrollView(for: .top) === list
    {
      controller.setContentScrollView(nil, for: .top)
    }
    edgeController = nil
    edgeList = nil
  }

  private func clearScrollEdge() {
    if #available(iOS 26.0, *) {
      for view in edgeHeaders.allObjects { clearHeaderEdge(on: view) }
    }
    for page in pages { clearHeaderEdges(in: page) }
    clearContentScrollView()
  }

  private func clearHeaderEdges(in page: UIView) {
    if #available(iOS 26.0, *) {
      for view in headerExtensions(in: page) { clearHeaderEdge(on: view) }
    }
  }

  @available(iOS 26.0, *)
  private func clearHeaderEdge(on view: UIView) {
    for interaction in view.interactions.compactMap({ $0 as? UIScrollEdgeElementContainerInteraction }) {
      // The transcript marker owns its normal soft edge. The hard style only
      // belongs to the visible mission strip while this interaction is bound.
      interaction.scrollView?.topEdgeEffect.style = .soft
      interaction.scrollView = nil
      view.removeInteraction(interaction)
    }
    edgeHeaders.remove(view)
  }

  @available(iOS 26.0, *)
  private func edgeInteraction(on view: UIView) -> UIScrollEdgeElementContainerInteraction {
    if let existing = view.interactions.lazy
      .compactMap({ $0 as? UIScrollEdgeElementContainerInteraction }).first
    {
      return existing
    }
    let added = UIScrollEdgeElementContainerInteraction()
    added.edge = .top
    view.addInteraction(added)
    return added
  }

  @objc func revalidateScrollEdge() {
    updateScrollEdge()
  }

  private func transcriptList(in page: UIView) -> UIScrollView? {
    var queue = page.subviews
    while !queue.isEmpty {
      let view = queue.removeFirst()
      if view.accessibilityIdentifier == "chat-transcript-scroll-view" {
        return primaryList(in: view)
      }
      // Never search message previews, nested code scrollers or inputs.
      if !(view is UIScrollView), !view.isHidden { queue.append(contentsOf: view.subviews) }
    }
    return nil
  }

  /// The page's outermost full-width scroll view: the transcript or the deck
  /// list, never a code block or chip row inside it.
  private func primaryList(in page: UIView) -> UIScrollView? {
    guard page.bounds.width > 0 else { return nil }
    var queue: [UIView] = [page]
    while !queue.isEmpty {
      let view = queue.removeFirst()
      if view.isHidden { continue }
      if let list = view as? UIScrollView, list.isScrollEnabled,
        list.bounds.height > 0, list.bounds.width >= page.bounds.width * 0.9
      {
        return list
      }
      queue.append(contentsOf: view.subviews)
    }
    return nil
  }

  private func headerExtensions(in page: UIView) -> [UIView] {
    var found: [UIView] = []
    var queue: [(UIView, Int)] = page.subviews.map { ($0, 0) }
    while !queue.isEmpty {
      let (view, depth) = queue.removeFirst()
      if view.accessibilityIdentifier == "header-extension" {
        found.append(view)
        continue
      }
      // The bar sits near the top of the page tree; lists are never searched.
      if depth < 8, !(view is UIScrollView) {
        queue.append(contentsOf: view.subviews.map { ($0, depth + 1) })
      }
    }
    return found
  }

  private func owningController() -> UIViewController? {
    var responder: UIResponder? = self
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
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

  /// Sideways inner scrollers and row swipes inside a page wait for the pager.
  @objc(gestureRecognizer:shouldBeRequiredToFailByGestureRecognizer:)
  func pagerShouldBeRequiredToFail(
    _ gestureRecognizer: UIGestureRecognizer,
    by other: UIGestureRecognizer
  ) -> Bool {
    if gestureRecognizer === panGestureRecognizer,
      isInnerScrollPan(other) || isInnerRowSwipe(other)
    {
      return true
    }
    return forwardRelation(
      #selector(pagerShouldBeRequiredToFail(_:by:)), gestureRecognizer, other)
  }

  /// The pager waits for nothing inside its pages: row swipes wait for it
  /// instead (above), so the direction decides who gets the drag.
  @objc(gestureRecognizer:shouldRequireFailureOfGestureRecognizer:)
  func pagerShouldRequireFailure(
    _ gestureRecognizer: UIGestureRecognizer,
    of other: UIGestureRecognizer
  ) -> Bool {
    return forwardRelation(
      #selector(pagerShouldRequireFailure(_:of:)), gestureRecognizer, other)
  }

  private func isInside(_ recognizer: UIGestureRecognizer) -> Bool {
    guard let view = recognizer.view, view !== self else { return false }
    return view.isDescendant(of: self)
  }

  /// Only an inner scroller that can move sideways (a code block, a table)
  /// waits for the pager. A vertical-only list must not: this pager's pan
  /// counts horizontal movement only, so on a straight vertical drag it never
  /// fails, and a list waiting on it would not scroll until the finger drifted
  /// sideways [POD-2529]. A vertical list and the pager each track their own
  /// axis, the stock UIKit nesting; the first past its slop takes the drag.
  private func isInnerScrollPan(_ recognizer: UIGestureRecognizer) -> Bool {
    guard isInside(recognizer), let scrollView = recognizer.view as? UIScrollView,
      scrollView.panGestureRecognizer === recognizer
    else {
      return false
    }
    return scrollsHorizontally(scrollView)
  }

  private func scrollsHorizontally(_ scrollView: UIScrollView) -> Bool {
    if scrollView.alwaysBounceHorizontal { return true }
    let inset = scrollView.adjustedContentInset
    return scrollView.contentSize.width + inset.left + inset.right > scrollView.bounds.width + 1
  }

  private func isInnerRowSwipe(_ recognizer: UIGestureRecognizer) -> Bool {
    guard isInside(recognizer) else { return false }
    return isRowSwipeName(NSStringFromClass(type(of: recognizer)))
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
      // Leftward drags on a row reveal its trailing actions; a rightward drag
      // pages back (row swipes wait for the pager).
      if isListRow(current), dx < 0 { return true }
      // While a row shows its actions, any drag in that list closes them first
      // (UIKit lays the actions view over the row, outside the cell).
      if current is UICollectionView || current is UITableView, showsSwipeActions(current) {
        return true
      }
      for recognizer in current.gestureRecognizers ?? []
      where (recognizer.state == .began || recognizer.state == .changed) && holdsTouch(recognizer) {
        return true
      }
      view = current.superview
    }
    return false
  }

  /// A list row that may carry swipe actions: a list or table cell, or any cell
  /// of a collection view that has UIKit's row swipe recognizer.
  private func isListRow(_ view: UIView) -> Bool {
    if view is UICollectionViewListCell || view is UITableViewCell { return true }
    guard view is UICollectionViewCell, let list = enclosingCollectionView(of: view) else {
      return false
    }
    return (list.gestureRecognizers ?? []).contains {
      isRowSwipeName(NSStringFromClass(type(of: $0)))
    }
  }

  private func enclosingCollectionView(of view: UIView) -> UICollectionView? {
    var next = view.superview
    while let current = next, current !== self {
      if let list = current as? UICollectionView { return list }
      next = current.superview
    }
    return nil
  }

  /// Whether a row of `list` currently shows its swipe buttons. UIKit keeps its
  /// actions view (`_UICollectionViewListSwipeActionsView`, or a table's pull
  /// view) in the list after the actions close, but empty: the buttons inside
  /// it exist only while they are revealed.
  private func showsSwipeActions(_ list: UIView, depth: Int = 0) -> Bool {
    guard depth < 3 else { return false }
    for child in list.subviews where !child.isHidden && child.alpha > 0.01 {
      let name = NSStringFromClass(type(of: child))
      if name.contains("SwipeActionsView") || name.contains("SwipeActionPullView") {
        if child.subviews.contains(where: { !$0.isHidden && $0.alpha > 0.01 && $0.bounds.width > 1 }) {
          return true
        }
        continue
      }
      if showsSwipeActions(child, depth: depth + 1) { return true }
    }
    return false
  }

  private func isRowSwipeName(_ name: String) -> Bool {
    name.contains("SwipeAction") || name.contains("SwipeHandler")
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

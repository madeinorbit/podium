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
/// A release this soon after drag movement belongs to that drag.
private let dragWindow: TimeInterval = 0.5

/// Wraps a row's label in the List's own Button, so the system draws the cell's
/// touch-down highlight (with no custom listRowBackground on the row) and
/// VoiceOver, Return and Space activate it once.
///
/// A List Button fires on any release inside the row, and a TapGesture tolerates
/// tens of points of movement; a short rightward drag (no leading swipe actions
/// claim it) therefore opened rows. A simultaneous drag latch rejects any release
/// that follows movement past the slop.
private struct ListRowPressModifier: ViewModifier {
  let dispatcher: EventDispatcher
  @State private var draggedAt = Date.distantPast

  func body(content: Content) -> some View {
    let button = Button {
      if Date().timeIntervalSince(draggedAt) < dragWindow { return }
      activate()
    } label: {
      // A List Button tints its label; hierarchical styles inside derive from
      // this, so rows keep the system label colours instead of the accent.
      content.foregroundStyle(Color.primary)
    }
    .buttonStyle(.automatic)
    .simultaneousGesture(
      DragGesture(minimumDistance: dragSlop)
        .onChanged { _ in draggedAt = Date() }
        .onEnded { _ in draggedAt = Date() }
    )

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

/// UIKit shows a stacked `hidesSearchBarWhenScrolling` search field when its list
/// first appears at rest. Lists should open with the field tucked under the large
/// title, revealed only by a deliberate pull. Once per mounted list, this scrolls
/// the tracked list by the field's height. Only an animated scroll goes through
/// UIKit's search-hiding path; a programmatic jump collapses the large title too.
/// On a cold launch it runs beneath the splash overlay.
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
    guard let list = trackedList(), let search = searchController(), list.contentSize.height > 0
    else {
      // The list and the header's search controller attach over a few frames.
      if attempt < 40 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.tuck(attempt: attempt + 1) }
      }
      return
    }
    settled = true
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

  private func searchController() -> UISearchController? {
    var responder: UIResponder? = self
    while let current = responder {
      var controller = current as? UIViewController
      while let vc = controller {
        if let search = vc.navigationItem.searchController { return search }
        controller = vc.parent
      }
      responder = current.next
    }
    return nil
  }
}

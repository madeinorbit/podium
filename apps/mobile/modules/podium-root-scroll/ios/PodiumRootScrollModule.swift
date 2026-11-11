import ExpoModulesCore
import UIKit

public final class PodiumRootScrollModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PodiumRootScroll")
    View(RootScrollObserverView.self) {
      Events("onRootScroll")
      Prop("revision") { (view: RootScrollObserverView, _: Int) in
        view.refresh()
      }
    }
  }
}

/// iOS 16/17 fallback. KVO leaves SwiftUI's scroll delegate and gestures intact.
/// This zero-size view is a direct child of the root Screen, beside its content.
final class RootScrollObserverView: ExpoView {
  let onRootScroll = EventDispatcher()
  private weak var scrollView: UIScrollView?
  private var observation: NSKeyValueObservation?
  private var discovery: DispatchWorkItem?

  override func didMoveToWindow() {
    super.didMoveToWindow()
    discovery?.cancel()
    observation = nil
    scrollView = nil
    if window != nil { refresh() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if window != nil, scrollView?.window == nil { refresh() }
  }

  func refresh() {
    discovery?.cancel()
    // SwiftUI mounts its collection view after the sibling ExpoView mounts.
    let work = DispatchWorkItem { [weak self] in self?.attachWithinScreen() }
    discovery = work
    DispatchQueue.main.async(execute: work)
  }

  private func attachWithinScreen() {
    guard window != nil, let root = superview else { return }
    guard let scroll = findScroll(in: root) else {
      // The screen may still be mounting. Cancelled as soon as it leaves window.
      let work = DispatchWorkItem { [weak self] in self?.attachWithinScreen() }
      discovery = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: work)
      return
    }
    guard scroll !== scrollView else { return }
    scrollView = scroll
    observation = scroll.observe(\.contentOffset, options: [.initial, .new]) { [weak self] scroll, _ in
      // Expo direct view events are consumed by Reanimated on the UI thread.
      self?.onRootScroll(["offset": max(0, scroll.contentOffset.y + scroll.adjustedContentInset.top)])
    }
  }

  private func findScroll(in view: UIView) -> UIScrollView? {
    if let scroll = view as? UIScrollView { return scroll }
    for child in view.subviews {
      if let scroll = findScroll(in: child) { return scroll }
    }
    return nil
  }

  deinit {
    discovery?.cancel()
    observation?.invalidate()
  }
}

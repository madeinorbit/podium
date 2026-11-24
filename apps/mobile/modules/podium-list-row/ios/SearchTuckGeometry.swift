import CoreGraphics
import Foundation

/// Only remove the search area's visible extent from the expanded resting
/// inset. adjustedContentInset can still reflect the smaller, previous title
/// during initial Dynamic Type layout; the measured bar overlap takes priority.
func initialSearchTuckOffset(
  adjustedTopInset: CGFloat,
  contentTopInset: CGFloat,
  navigationFrame: CGRect,
  searchFrame: CGRect
) -> CGFloat? {
  guard adjustedTopInset.isFinite, contentTopInset.isFinite,
    !navigationFrame.isEmpty, !searchFrame.isEmpty
  else { return nil }
  let visibleSearch = navigationFrame.intersection(searchFrame)
  guard !visibleSearch.isNull, visibleSearch.height > 1 else { return nil }
  let expandedInset = max(adjustedTopInset, contentTopInset + max(0, navigationFrame.maxY))
  guard expandedInset.isFinite, expandedInset >= visibleSearch.height else { return nil }
  return -expandedInset + visibleSearch.height
}

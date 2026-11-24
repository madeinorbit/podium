import CoreGraphics
import Foundation

// Run on the Mac without an app host:
// swiftc -parse-as-library SearchTuckGeometry.swift search-tuck-geometry.swift -o /tmp/search-geometry
@main
struct SearchTuckGeometryRegression {
  static func main() {
    let cases: [(title: CGFloat, search: CGFloat, expected: CGFloat)] = [
      (52, 56, -180), (73.5, 56.5, -201.5), (76, 64, -204), (128, 72, -256), (164, 80, -292)
    ]
    for test in cases {
      let bar = CGRect(x: 0, y: 62, width: 390, height: 44 + test.title + 22 + test.search)
      let search = CGRect(x: 0, y: bar.maxY - test.search, width: 390, height: test.search)
      // The old 236pt inset is stale for the larger AX titles. The target must
      // preserve their entire title/subtitle region, independent of height.
      let target = initialSearchTuckOffset(adjustedTopInset: 236, contentTopInset: 0,
        navigationFrame: bar, searchFrame: search)
      precondition(target == test.expected, "Large title collapsed: \(test)")
    }
    let bar = CGRect(x: 0, y: 62, width: 390, height: 206)
    let clipped = CGRect(x: 0, y: 244, width: 390, height: 72)
    precondition(initialSearchTuckOffset(adjustedTopInset: 236, contentTopInset: 0,
      navigationFrame: bar, searchFrame: clipped) == -244, "Count only visible search")
    let axBar = CGRect(x: 0, y: 62, width: 390, height: 266)
    let axSearch = CGRect(x: 0, y: 256, width: 390, height: 72)
    precondition(initialSearchTuckOffset(adjustedTopInset: 236, contentTopInset: 12,
      navigationFrame: axBar, searchFrame: axSearch) == -268, "Preserve custom content inset")
    precondition(initialSearchTuckOffset(adjustedTopInset: 400, contentTopInset: 0,
      navigationFrame: axBar, searchFrame: axSearch) == -328, "Never shorten an existing expanded inset")
    precondition(initialSearchTuckOffset(adjustedTopInset: 236, contentTopInset: 0,
      navigationFrame: bar, searchFrame: CGRect(x: 0, y: 300, width: 390, height: 56)) == nil)
    precondition(initialSearchTuckOffset(adjustedTopInset: .nan, contentTopInset: 0,
      navigationFrame: bar, searchFrame: clipped) == nil)
    print("PASS: search-only tuck across large-title heights, stale insets and clipped search")
  }
}

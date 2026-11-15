import UIKit
import XCTest
@testable import PodiumListRow

// App-hosted iOS XCTest fixture. The ordinary later-tab path has no launch
// overlay and must still register the real List before reporting completion.
final class SearchScrollTrackingTests: XCTestCase {
  private final class Rows: NSObject, UICollectionViewDataSource {
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { 100 }
    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
      collectionView.dequeueReusableCell(withReuseIdentifier: "row", for: indexPath)
    }
  }

  private struct Rig {
    let window: UIWindow
    let screen: UIViewController
    let list: UICollectionView
    let probe: SearchStartsHiddenView
    let rows: Rows
  }

  @MainActor
  private func rig(canTuck: Bool?, onReady: @escaping () -> Void) -> Rig {
    let screen = UIViewController()
    screen.navigationItem.title = "Tasks"
    screen.navigationItem.searchController = UISearchController(searchResultsController: nil)
    let layout = UICollectionViewFlowLayout()
    layout.itemSize = CGSize(width: 300, height: 44)
    let list = UICollectionView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), collectionViewLayout: layout)
    let rows = Rows()
    list.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "row")
    list.dataSource = rows
    screen.view.addSubview(list)
    let probe = SearchStartsHiddenView()
    probe.configure(canTuck: canTuck, onReady: onReady)
    screen.view.addSubview(probe)
    let navigation = UINavigationController(rootViewController: screen)
    navigation.navigationBar.prefersLargeTitles = true
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: list.frame)
    window.rootViewController = navigation
    return Rig(window: window, screen: screen, list: list, probe: probe, rows: rows)
  }

  @MainActor
  private func showAndWaitForTracking(_ rig: Rig) async throws {
    rig.window.makeKeyAndVisible()
    rig.window.layoutIfNeeded()
    rig.list.layoutIfNeeded()
    let deadline = Date().addingTimeInterval(1)
    while rig.screen.contentScrollView(for: .top) !== rig.list, Date() < deadline {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertTrue(rig.screen.contentScrollView(for: .top) === rig.list)
  }

  @MainActor
  func testFalseBeforeWindowStillRegistersBeforeCompletion() async throws {
    var completions = 0
    let rig = rig(canTuck: false) { completions += 1 }
    defer { rig.window.isHidden = true }
    XCTAssertEqual(completions, 0, "False permission must not settle before native attachment")
    try await showAndWaitForTracking(rig)
    XCTAssertEqual(completions, 1)
    rig.probe.configure(canTuck: false) { completions += 1 }
    XCTAssertEqual(completions, 1)
  }

  @MainActor
  func testPendingPermissionAlreadyRegistersAndCanFinishWithoutTucking() async throws {
    var completions = 0
    let rig = rig(canTuck: nil) { completions += 1 }
    defer { rig.window.isHidden = true }
    try await showAndWaitForTracking(rig)
    XCTAssertEqual(completions, 0)
    rig.probe.configure(canTuck: false) { completions += 1 }
    XCTAssertEqual(completions, 1)
    XCTAssertTrue(rig.screen.contentScrollView(for: .top) === rig.list)
  }
}

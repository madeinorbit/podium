import UIKit
import XCTest
@testable import PodiumPager

// App-hosted iOS 26+ fixture. These tests observe UIKit's actual interactions
// and content-scroll-view registration, including late React child mounts.
@available(iOS 26.0, *)
@MainActor
final class PagerScrollEdgeTests: XCTestCase {
  @MainActor
  private final class Rig {
    let window: UIWindow
    let screen = UIViewController()
    let pager = PodiumPagerView()
    let chat = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let deck = UIView(frame: CGRect(x: 390, y: 0, width: 390, height: 844))
    let header = UIView(frame: CGRect(x: 0, y: 100, width: 390, height: 44))
    let skeleton = UIScrollView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let transcript = UIScrollView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let deckList = UIScrollView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))

    init(transcriptReady: Bool = true, headerReady: Bool = true) {
      let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
      window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: chat.frame)
      window.rootViewController = screen
      pager.frame = chat.frame
      screen.view.addSubview(pager)
      header.accessibilityIdentifier = "header-extension"
      transcript.accessibilityIdentifier = "chat-transcript-scroll-view"
      transcript.contentSize = CGSize(width: 390, height: 2000)
      deckList.contentSize = transcript.contentSize
      // Keep this mounted even after the transcript appears. Membership alone
      // must not let a previously chosen skeleton remain the edge target.
      chat.addSubview(skeleton)
      if transcriptReady { chat.addSubview(transcript) }
      if headerReady { chat.addSubview(header) }
      deck.addSubview(deckList)
      pager.mountChildComponentView(chat, index: 0)
      pager.mountChildComponentView(deck, index: 1)
      window.makeKeyAndVisible()
      window.layoutIfNeeded()
      pager.layoutIfNeeded()
      pager.revalidateScrollEdge()
    }

    var interaction: UIScrollEdgeElementContainerInteraction? {
      header.interactions.compactMap { $0 as? UIScrollEdgeElementContainerInteraction }.first
    }

    func close() {
      pager.removeFromSuperview()
      window.isHidden = true
    }
  }

  func testLoadingSkeletonAndComposerAreNeverHeaderTargets() {
    let rig = Rig(transcriptReady: false)
    defer { rig.close() }
    let composer = UITextView(frame: rig.chat.bounds)
    rig.chat.addSubview(composer)
    rig.pager.revalidateScrollEdge()
    XCTAssertNil(rig.interaction)
    XCTAssertFalse(rig.screen.contentScrollView(for: .top) === rig.skeleton)
    XCTAssertFalse(rig.screen.contentScrollView(for: .top) === composer)

    rig.chat.addSubview(rig.transcript)
    rig.pager.revalidateScrollEdge()
    XCTAssertTrue(rig.interaction?.scrollView === rig.transcript)
    XCTAssertTrue(rig.screen.contentScrollView(for: .top) === rig.transcript)
  }

  func testLateHeaderMountIsBoundWhileTheSameListStaysInTheWindow() {
    let rig = Rig(headerReady: false)
    defer { rig.close() }
    XCTAssertTrue(rig.screen.contentScrollView(for: .top) === rig.transcript)
    rig.chat.addSubview(rig.header)
    rig.pager.revalidateScrollEdge()
    XCTAssertTrue(rig.interaction?.scrollView === rig.transcript)
  }

  func testChangedTranscriptIdentityReplacesAStillMountedOldList() {
    let rig = Rig()
    defer { rig.close() }
    rig.transcript.accessibilityIdentifier = nil
    let replacement = UIScrollView(frame: rig.transcript.frame)
    replacement.accessibilityIdentifier = "chat-transcript-scroll-view"
    rig.chat.addSubview(replacement)
    rig.pager.revalidateScrollEdge()
    XCTAssertTrue(rig.interaction?.scrollView === replacement)
    XCTAssertTrue(rig.screen.contentScrollView(for: .top) === replacement)
    XCTAssertEqual(rig.transcript.topEdgeEffect.style, .soft)
  }

  func testHiddenChatDropsItsInteractionWhenTheVisiblePageChanges() {
    let rig = Rig()
    defer { rig.close() }
    XCTAssertTrue(rig.interaction?.scrollView === rig.transcript)
    // The title changes at the midpoint, before UIKit finishes decelerating.
    rig.pager.scroller.contentOffset.x = rig.pager.bounds.width * 0.6
    rig.pager.scrollViewDidScroll(rig.pager.scroller)
    XCTAssertNil(rig.interaction)
    XCTAssertTrue(rig.screen.contentScrollView(for: .top) === rig.deckList)
    rig.pager.setPage(0, animated: false)
    XCTAssertTrue(rig.interaction?.scrollView === rig.transcript)
  }

  func testRemovedHeaderAndDetachedPagerReleaseTheOldInteraction() {
    let rig = Rig()
    defer { rig.close() }
    let oldInteraction = rig.interaction
    rig.header.removeFromSuperview()
    rig.pager.revalidateScrollEdge()
    XCTAssertNil(oldInteraction?.scrollView)

    rig.chat.addSubview(rig.header)
    rig.pager.revalidateScrollEdge()
    let rebound = rig.interaction
    XCTAssertTrue(rebound?.scrollView === rig.transcript)
    rig.pager.removeFromSuperview()
    XCTAssertNil(rebound?.scrollView)
    XCTAssertFalse(rig.screen.contentScrollView(for: .top) === rig.transcript)
    rig.screen.view.addSubview(rig.pager)
    NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    XCTAssertTrue(rig.interaction?.scrollView === rig.transcript)
  }

  func testZeroAndFullPageHeaderBoundsNeverCreateATranscriptBlur() {
    let rig = Rig()
    defer { rig.close() }
    for frame in [CGRect.zero, rig.chat.bounds] {
      rig.header.frame = frame
      rig.pager.revalidateScrollEdge()
      XCTAssertNil(rig.interaction)
    }
    rig.header.frame = CGRect(x: 0, y: 100, width: 390, height: 44)
    rig.pager.revalidateScrollEdge()
    XCTAssertTrue(rig.interaction?.scrollView === rig.transcript)
  }

  func testZeroPagerHeightReleasesTheHeaderBeforeTheNextTimerTick() {
    let rig = Rig()
    defer { rig.close() }
    let oldInteraction = rig.interaction
    rig.pager.frame.size.height = 0
    rig.pager.setNeedsLayout()
    rig.pager.layoutIfNeeded()
    XCTAssertNil(oldInteraction?.scrollView)
  }
}

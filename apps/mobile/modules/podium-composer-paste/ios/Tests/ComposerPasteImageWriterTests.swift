// MANUAL FIXTURE: not compiled or run by CI. Add to an app-hosted iOS XCTest target to run.

import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import PodiumComposerPaste

// App-hosted iOS fixtures: exercise the real serial worker and main-queue delivery.
final class ComposerPasteImageWriterTests: XCTestCase {
  private final class Calls {
    private let lock = NSLock()
    private var entries: [String] = []

    func append(_ value: String) {
      lock.lock()
      defer { lock.unlock() }
      entries.append(value)
    }

    var values: [String] {
      lock.lock()
      defer { lock.unlock() }
      return entries
    }
  }

  @MainActor
  func testEncodingAndWritesAreOffMainAndBatchesFinishInOrder() {
    let firstImage = UIImage()
    let secondImage = UIImage()
    let started = expectation(description: "first encoder started")
    let firstDone = expectation(description: "first batch delivered")
    let secondDone = expectation(description: "second batch delivered")
    let release = DispatchSemaphore(value: 0)
    let calls = Calls()
    let writer = ComposerPasteImageWriter(
      png: { image in
        XCTAssertFalse(Thread.isMainThread)
        if image === firstImage {
          calls.append("encode first")
          started.fulfill()
          XCTAssertEqual(release.wait(timeout: .now() + 3), .success)
          return Data([1])
        }
        calls.append("encode second")
        return Data([2])
      },
      jpeg: { _ in XCTFail("Under-limit PNG must not be recompressed"); return nil },
      write: { data, _ in
        XCTAssertFalse(Thread.isMainThread)
        calls.append("write \(data.first!)")
      }
    )
    writer.enqueue([.init(type: .png, content: .image(firstImage))], maxBytes: 4) { files in
      XCTAssertTrue(Thread.isMainThread)
      XCTAssertEqual(files.first?["size"] as? Int, 1)
      calls.append("deliver first")
      firstDone.fulfill()
    }
    writer.enqueue([.init(type: .png, content: .image(secondImage))], maxBytes: 4) { _ in
      XCTAssertTrue(Thread.isMainThread)
      calls.append("deliver second")
      secondDone.fulfill()
    }
    wait(for: [started], timeout: 1)
    // The responder can continue and insert text while the first encoder waits.
    // A second batch cannot overtake it or start another encoder concurrently.
    XCTAssertEqual(calls.values, ["encode first"])
    release.signal()
    wait(for: [firstDone, secondDone], timeout: 3)
    let processing = calls.values.filter { !$0.hasPrefix("deliver") }
    XCTAssertEqual(processing, ["encode first", "write 1", "encode second", "write 2"])
    XCTAssertEqual(calls.values.filter { $0.hasPrefix("deliver") }, ["deliver first", "deliver second"])
  }

  @MainActor
  func testSnapshotSurvivesClipboardReplacementAndCapsPayloadsAtFour() {
    let pasteboard = UIPasteboard.withUniqueName()
    defer { UIPasteboard.remove(withName: pasteboard.name) }
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2))
    let image = renderer.image { _ in UIColor.red.setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 2, height: 2)) }
    let original = image.pngData()!
    pasteboard.items = (0..<6).map { ["public.png": original + Data([UInt8($0)])] }
    let images = ComposerPasteImageSnapshot.capture(pasteboard, maxItems: 4, maxBytes: original.count + 1)
    pasteboard.string = "replacement clipboard"
    XCTAssertEqual(images.count, 6)
    for (index, image) in images.enumerated() {
      if index < 4 {
        guard case .data(let data) = image.content else { return XCTFail("Missing original snapshot") }
        XCTAssertEqual(data, original + Data([UInt8(index)]))
      } else {
        guard case .overflow = image.content else { return XCTFail("Overflow retained image payloads") }
      }
    }
    let done = expectation(description: "snapshot written")
    let calls = Calls()
    let writer = ComposerPasteImageWriter(
      png: { _ in XCTFail("Original bytes must not be encoded"); return nil },
      jpeg: { _ in XCTFail("Original bytes must not be encoded"); return nil },
      write: { data, _ in
        XCTAssertFalse(Thread.isMainThread)
        calls.append("\(data.last!)")
      }
    )
    writer.enqueue(images, maxBytes: original.count + 1) { files in
      XCTAssertTrue(Thread.isMainThread)
      XCTAssertEqual(files.count, 6)
      XCTAssertEqual(calls.values, ["0", "1", "2", "3"])
      XCTAssertEqual(files.compactMap { $0["name"] as? String }, (1...6).map { "pasted-image-\($0).png" })
      done.fulfill()
    }
    wait(for: [done], timeout: 3)
  }

  @MainActor
  func testOversizedOriginalSnapshotRetainsOnlyItsSize() {
    let pasteboard = UIPasteboard.withUniqueName()
    defer { UIPasteboard.remove(withName: pasteboard.name) }
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2))
    let original = renderer.image { _ in UIColor.red.setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 2, height: 2)) }.pngData()!
    pasteboard.items = [["public.png": original]]
    let images = ComposerPasteImageSnapshot.capture(pasteboard, maxItems: 4, maxBytes: original.count - 1)
    guard let image = images.first, case .oversized(let size) = image.content else {
      return XCTFail("Oversized snapshot retained encoded bytes")
    }
    XCTAssertEqual(size, original.count)
  }

  @MainActor
  func testBareImageCompressionRunsOnWorkerAndKeepsMatchingMetadata() {
    let done = expectation(description: "compressed image delivered")
    let calls = Calls()
    let writer = ComposerPasteImageWriter(
      png: { _ in XCTAssertFalse(Thread.isMainThread); calls.append("png"); return Data([1, 2, 3]) },
      jpeg: { _ in XCTAssertFalse(Thread.isMainThread); calls.append("jpeg"); return Data([4]) },
      write: { data, url in
        XCTAssertFalse(Thread.isMainThread)
        XCTAssertEqual(data, Data([4]))
        XCTAssertEqual(url.pathExtension, UTType.jpeg.preferredFilenameExtension)
      }
    )
    writer.enqueue([.init(type: .png, content: .image(UIImage()))], maxBytes: 2) { files in
      XCTAssertTrue(Thread.isMainThread)
      XCTAssertEqual(calls.values, ["png", "jpeg"])
      XCTAssertEqual(files.first?["mimeType"] as? String, "image/jpeg")
      XCTAssertEqual(files.first?["size"] as? Int, 1)
      done.fulfill()
    }
    wait(for: [done], timeout: 3)
  }

  @MainActor
  func testReadAndWriteFailuresStayInOrderAndOversizeDataIsNotWritten() {
    struct WriteFailure: LocalizedError { var errorDescription: String? { "fixture write failure" } }
    let done = expectation(description: "errors delivered")
    let calls = Calls()
    let writer = ComposerPasteImageWriter(write: { _, _ in
      XCTAssertFalse(Thread.isMainThread)
      calls.append("write")
      throw WriteFailure()
    })
    writer.enqueue([
      .init(type: .png, content: .unavailable),
      .init(type: .png, content: .data(Data([1]))),
      .init(type: .heic, content: .data(Data([1, 2, 3]))),
      .init(type: .png, content: .overflow)
    ], maxBytes: 2) { files in
      XCTAssertTrue(Thread.isMainThread)
      XCTAssertEqual(calls.values, ["write"])
      XCTAssertEqual(files[0]["error"] as? String, "Could not read pasted-image-1.png from the clipboard.")
      XCTAssertTrue((files[1]["error"] as? String)?.contains("fixture write failure") == true)
      XCTAssertEqual(files[2]["mimeType"] as? String, "image/heic")
      XCTAssertEqual(files[2]["size"] as? Int, 3)
      XCTAssertEqual(files[2]["uri"] as? String, "")
      XCTAssertNil(files[3]["size"])
      done.fulfill()
    }
    wait(for: [done], timeout: 3)
  }
}

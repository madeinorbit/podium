import UIKit
import UniformTypeIdentifiers

/// Immutable references captured during the Paste gesture. Overflow keeps only
/// metadata; at most the existing per-paste limit retains data or UIImages.
struct ComposerPasteImageSnapshot {
  enum Content {
    case data(Data)
    case image(UIImage)
    case oversized(Int)
    case unavailable
    case overflow
  }

  let type: UTType
  let content: Content

  static func capture(_ pasteboard: UIPasteboard, maxItems: Int, maxBytes: Int) -> [Self] {
    dispatchPrecondition(condition: .onQueue(.main))
    var images: [Self] = []
    for item in 0..<pasteboard.numberOfItems {
      autoreleasepool {
        let indexes = IndexSet(integer: item)
        let types = pasteboard.types(forItemSet: indexes)?.first ?? []
        guard let identifier = types.first(where: {
          $0 == "com.apple.uikit.image" || UTType($0)?.conforms(to: .image) == true
        }) else { return }
        let encoded = types.first {
          guard let type = UTType($0) else { return false }
          return type.conforms(to: .image) && type.preferredMIMEType != nil && type.preferredFilenameExtension != nil
        }
        let type = encoded.flatMap { UTType($0) } ?? .png
        let content: Content
        if images.count >= maxItems {
          content = .overflow
        } else if let encoded,
                  let data = pasteboard.data(forPasteboardType: encoded, inItemSet: indexes)?.first {
          content = data.count <= maxBytes ? .data(data) : .oversized(data.count)
        } else if encoded == nil,
                  let image = pasteboard.values(forPasteboardType: identifier, inItemSet: indexes)?.first as? UIImage {
          content = .image(image)
        } else {
          content = .unavailable
        }
        images.append(Self(type: type, content: content))
      }
    }
    return images
  }
}

/// One serial worker encodes and writes one image at a time. Each capped batch
/// releases temporary encoding buffers per item and delivers its result on main.
final class ComposerPasteImageWriter {
  private let queue = DispatchQueue(label: "podium.composer-image-paste", qos: .userInitiated)
  private let png: (UIImage) -> Data?
  private let jpeg: (UIImage) -> Data?
  private let write: (Data, URL) throws -> Void

  init(
    png: @escaping (UIImage) -> Data? = { $0.pngData() },
    jpeg: @escaping (UIImage) -> Data? = { $0.jpegData(compressionQuality: 0.9) },
    write: @escaping (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }
  ) {
    self.png = png
    self.jpeg = jpeg
    self.write = write
  }

  func enqueue(
    _ images: [ComposerPasteImageSnapshot],
    maxBytes: Int,
    completion: @escaping ([[String: Any]]) -> Void
  ) {
    queue.async {
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("composer-paste-\(UUID().uuidString)", isDirectory: true)
      let files = images.enumerated().map { index, image in
        autoreleasepool {
          self.prepare(image, index: index, directory: directory, maxBytes: maxBytes)
        }
      }
      DispatchQueue.main.async { completion(files) }
    }
  }

  private func prepare(
    _ image: ComposerPasteImageSnapshot,
    index: Int,
    directory: URL,
    maxBytes: Int
  ) -> [String: Any] {
    dispatchPrecondition(condition: .notOnQueue(.main))
    var type = image.type
    var name = "pasted-image-\(index + 1).\(type.preferredFilenameExtension ?? "bin")"
    var file: [String: Any] = [
      "name": name,
      "mimeType": type.preferredMIMEType ?? "application/octet-stream",
      "uri": "",
      "previewUri": ""
    ]
    var data: Data?
    switch image.content {
    case .overflow:
      return file
    case .unavailable:
      break
    case .oversized(let size):
      file["size"] = size
      return file
    case .data(let original):
      data = original
    case .image(let original):
      data = png(original)
      // Only a bare UIImage is encoded. Original file data is never changed.
      if let encoded = data, encoded.count > maxBytes, let compressed = jpeg(original) {
        data = compressed
        type = .jpeg
        name = "pasted-image-\(index + 1).\(type.preferredFilenameExtension ?? "jpg")"
        file["name"] = name
        file["mimeType"] = type.preferredMIMEType
      }
    }
    guard let data else {
      file["error"] = "Could not read \(name) from the clipboard."
      return file
    }
    file["size"] = data.count
    if data.count <= maxBytes {
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name)
        try write(data, url)
        file["uri"] = url.absoluteString
        file["previewUri"] = url.absoluteString
      } catch {
        file["error"] = "Could not read \(name): \(error.localizedDescription)"
      }
    }
    return file
  }
}

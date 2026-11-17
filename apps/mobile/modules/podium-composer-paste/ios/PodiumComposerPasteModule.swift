import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

public final class PodiumComposerPasteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PodiumComposerPaste")
    Events("onImagePaste")

    AsyncFunction("bindInput") { (target: Int, maxBytes: Int, maxItems: Int) in
      guard let root = self.appContext?.findView(withTag: target, ofType: UIView.self),
            let input = self.pasteInput(in: root) else {
        throw Exception(name: "ComposerInputUnavailable", description: "The composer text input is unavailable.")
      }
      // RCTUITextView exposes this opt-in block in our RN patch. KVC keeps the
      // bridge independent of RN's private text headers and Fabric wrappers.
      let handler: @convention(block) () -> Void = { [weak self] in
        let files = self?.captureImages(maxBytes: maxBytes, maxItems: maxItems) ?? []
        self?.sendEvent("onImagePaste", ["target": target, "files": files])
      }
      input.setValue(handler, forKey: "podiumImagePasteHandler")
    }.runOnQueue(.main)

    AsyncFunction("unbindInput") { (target: Int) in
      guard let root = self.appContext?.findView(withTag: target, ofType: UIView.self),
            let input = self.pasteInput(in: root) else { return }
      input.setValue(nil, forKey: "podiumImagePasteHandler")
    }.runOnQueue(.main)
  }

  private func pasteInput(in view: UIView) -> UITextView? {
    if let input = view as? UITextView,
       input.responds(to: NSSelectorFromString("setPodiumImagePasteHandler:")) {
      return input
    }
    for child in view.subviews {
      if let input = pasteInput(in: child) { return input }
    }
    return nil
  }

  /// Snapshot during paste:, while UIKit recognizes the explicit user gesture.
  /// Only file URLs cross the bridge. JS reads/encodes them in its existing
  /// serialized picker queue, and uses the same byte and batch limits.
  private func captureImages(maxBytes: Int, maxItems: Int) -> [[String: Any]] {
    let pasteboard = UIPasteboard.general
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("composer-paste-\(UUID().uuidString)", isDirectory: true)
    var files: [[String: Any]] = []
    for item in 0..<pasteboard.numberOfItems {
      autoreleasepool {
        let indexes = IndexSet(integer: item)
        let types = pasteboard.pasteboardTypes(forItemSet: indexes) ?? []
        guard let identifier = types.first(where: {
          $0 == "com.apple.uikit.image" || UTType($0)?.conforms(to: .image) == true
        }) else { return }
        // Prefer a concrete encoded representation over UIKit's UIImage object.
        let encoded = types.first {
          guard let type = UTType($0) else { return false }
          return type.conforms(to: .image) && type.preferredMIMEType != nil && type.preferredFilenameExtension != nil
        }
        var type = encoded.flatMap { UTType($0) } ?? .png
        var name = "pasted-image-\(files.count + 1).\(type.preferredFilenameExtension ?? "bin")"
        var file: [String: Any] = [
          "name": name,
          "mimeType": type.preferredMIMEType ?? "application/octet-stream",
          "uri": "",
          "previewUri": ""
        ]
        // Keep overflow metadata so readAttachmentsSequentially reports the
        // exact omitted count, without ever loading those items' image bytes.
        guard files.count < maxItems else {
          files.append(file)
          return
        }
        do {
          var data: Data?
          if let encoded {
            data = pasteboard.data(forPasteboardType: encoded, inItemSet: indexes)?.first
          } else {
            let image = pasteboard.values(forPasteboardType: identifier, inItemSet: indexes)?.first as? UIImage
            data = image?.pngData()
            // A bare UIImage has no original file to preserve. Try PNG once,
            // then JPEG only if that encoding exceeds the existing byte cap.
            if let png = data, png.count > maxBytes,
               let jpeg = image?.jpegData(compressionQuality: 0.9) {
              data = jpeg
              type = .jpeg
              name = "pasted-image-\(files.count + 1).\(type.preferredFilenameExtension ?? "jpg")"
              file["name"] = name
              file["mimeType"] = type.preferredMIMEType
            }
          }
          guard let data else {
            file["error"] = "Could not read \(name) from the clipboard."
            files.append(file)
            return
          }
          file["size"] = data.count
          if data.count <= maxBytes {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(name)
            try data.write(to: url, options: .atomic)
            file["uri"] = url.absoluteString
            file["previewUri"] = url.absoluteString
          }
        } catch {
          file["error"] = "Could not read \(name): \(error.localizedDescription)"
        }
        files.append(file)
      }
    }
    return files
  }
}

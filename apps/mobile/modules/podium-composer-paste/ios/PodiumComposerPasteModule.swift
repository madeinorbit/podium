import ExpoModulesCore
import UIKit

public final class PodiumComposerPasteModule: Module {
  private let imageWriter = ComposerPasteImageWriter()

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
        guard let self else { return }
        // Pasteboard access stays inside the gesture. Encoding and disk I/O
        // leave the responder immediately, so UIKit can keep handling input.
        let pasteId = UUID().uuidString
        self.sendEvent("onImagePaste", ["target": target, "pasteId": pasteId, "phase": "preparing"])
        let images = ComposerPasteImageSnapshot.capture(UIPasteboard.general, maxItems: maxItems, maxBytes: maxBytes)
        self.imageWriter.enqueue(images, maxBytes: maxBytes) { [weak self] files in
          self?.sendEvent("onImagePaste", ["target": target, "pasteId": pasteId, "phase": "ready", "files": files])
        }
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
}

import ExpoModulesCore
import ExpoUI
import SwiftUI

private let rowPressModifier = "podiumListRowPress"

public final class PodiumListRowModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PodiumListRow")

    OnCreate {
      ViewModifierRegistry.register(rowPressModifier) { _, _, dispatcher in
        ListRowPressModifier(dispatcher: dispatcher)
      }
    }

    OnDestroy {
      ViewModifierRegistry.unregister(rowPressModifier)
    }
  }
}

private struct ListRowPressModifier: ViewModifier {
  let dispatcher: EventDispatcher

  func body(content: Content) -> some View {
    // The Button keeps the system List's touch-down highlight. Its default
    // release-inside action is intentionally empty; only a recognized tap opens.
    let button = content
      .buttonStyle(.automatic)
      .simultaneousGesture(TapGesture().onEnded {
        activate()
      })
      .accessibilityAction {
        activate()
      }

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

import SwiftUI

/// Cell appearance includes List prefetch. Only intersection with the nearest
/// scroll viewport should enable clocks; scrolling reports Boolean crossings,
/// never a JS callback per frame. Older iOS uses the row's appearance lifetime.
struct ContentVisibilityModifier: ViewModifier {
  let onChange: (Bool) -> Void

  @ViewBuilder
  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content
        .onScrollVisibilityChange(threshold: 0.01, onChange)
        .onDisappear { onChange(false) }
    } else {
      content
        .onAppear { onChange(true) }
        .onDisappear { onChange(false) }
    }
  }
}

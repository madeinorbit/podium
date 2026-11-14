import ExpoModulesCore
import PDFKit
import UIKit

/// A PDF artifact on PDFKit's own page view, the renderer Files and Mail use.
/// PDFKit owns pinch, panning, rubber-banding and the page layout; this view
/// pins the minimum zoom to the fitted page width, adds the double-tap toggle
/// (zoom in at the tap, back to fit) and reports whether the pages are zoomed
/// past fit, so the viewer can keep its pager and pull-to-dismiss still while
/// a pan should move the page instead.
public final class PodiumPdfModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PodiumPdf")

    View(PodiumPdfView.self) {
      Events("onZoomChange", "onLoadError")

      /// A local file:// URL; the app fetches the bytes over its authenticated path.
      Prop("uri") { (view: PodiumPdfView, uri: String?) in
        view.load(uri)
      }
    }
  }
}

/// How far past fit the double tap zooms, as a multiple of the fitted scale.
private let doubleTapZoom: CGFloat = 2.5
/// The deepest zoom, as a multiple of the fitted scale.
private let maxZoom: CGFloat = 5

final class PodiumPdfView: ExpoView {
  let onZoomChange = EventDispatcher()
  let onLoadError = EventDispatcher()

  private let pdfView = PDFView()
  private var loadedUri: String?
  private var zoomed = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    pdfView.autoScales = true
    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.pageShadowsEnabled = true
    pdfView.backgroundColor = .secondarySystemBackground
    addSubview(pdfView)

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(scaleChanged),
      name: .PDFViewScaleChanged,
      object: pdfView
    )

    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    pdfView.addGestureRecognizer(doubleTap)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let wasFit = !zoomed
    pdfView.frame = bounds
    updateScaleLimits()
    // A new size (first layout, rotation) keeps an unzoomed document fitted.
    if wasFit, pdfView.document != nil {
      pdfView.scaleFactor = pdfView.scaleFactorForSizeToFit
    }
  }

  func load(_ uri: String?) {
    guard uri != loadedUri else { return }
    loadedUri = uri
    guard let uri, let url = URL(string: uri), let document = PDFDocument(url: url) else {
      pdfView.document = nil
      if uri != nil { onLoadError(["message": "This PDF could not be opened."]) }
      return
    }
    pdfView.document = document
    updateScaleLimits()
    pdfView.scaleFactor = pdfView.scaleFactorForSizeToFit
    report()
  }

  private func updateScaleLimits() {
    let fit = pdfView.scaleFactorForSizeToFit
    guard fit > 0 else { return }
    pdfView.minScaleFactor = fit
    pdfView.maxScaleFactor = fit * maxZoom
  }

  @objc private func scaleChanged() {
    report()
  }

  private func report() {
    let fit = pdfView.scaleFactorForSizeToFit
    let now = fit > 0 && pdfView.scaleFactor > fit * 1.01
    guard now != zoomed else { return }
    zoomed = now
    onZoomChange(["zoomed": now])
  }

  @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
    guard gesture.state == .ended, pdfView.document != nil else { return }
    let fit = pdfView.scaleFactorForSizeToFit
    guard let scroller = pageScroller(in: pdfView),
      let content = scroller.delegate?.viewForZooming?(in: scroller)
    else {
      // No scroll view to animate through: jump between the two scales.
      pdfView.scaleFactor = zoomed ? fit : min(fit * doubleTapZoom, pdfView.maxScaleFactor)
      return
    }
    if zoomed {
      scroller.setZoomScale(scroller.minimumZoomScale, animated: true)
      return
    }
    // The scroll view's zoom scale and PDFKit's scale factor move together;
    // aim the scroll view at the same multiple of fit, centred on the tap.
    let target = min(scroller.zoomScale * doubleTapZoom, scroller.maximumZoomScale)
    let point = gesture.location(in: content)
    let size = CGSize(
      width: scroller.bounds.width / target,
      height: scroller.bounds.height / target
    )
    scroller.zoom(
      to: CGRect(
        x: point.x - size.width / 2,
        y: point.y - size.height / 2,
        width: size.width,
        height: size.height
      ),
      animated: true
    )
  }

  /// PDFKit's document scroll view, the one whose zoom drives the scale factor.
  private func pageScroller(in view: UIView) -> UIScrollView? {
    for sub in view.subviews {
      if let scroller = sub as? UIScrollView, scroller.maximumZoomScale > scroller.minimumZoomScale {
        return scroller
      }
      if let found = pageScroller(in: sub) { return found }
    }
    return nil
  }
}

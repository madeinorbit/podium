// Native WKWebView capture. Compile/run only on the leased Mac runner.
// Session cookie arrives on stdin. Nonpersistent storage prevents disk caches.
import Cocoa
import WebKit

final class Capture: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var timer: Timer?
    var minute = -1
    var busy = false
    var navigationFinished = false
    var navigationError: Int?
    var attributed = false
    let args = CommandLine.arguments
    var root: URL { URL(fileURLWithPath: args[2], isDirectory: true) }
    func applicationDidFinishLaunching(_ notification: Notification) {
        try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let probe = try! String(contentsOfFile: args[3], encoding: .utf8)
        config.userContentController.addUserScript(WKUserScript(source: probe, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1000), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled,.closable,.resizable,.miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Podium Memory 5862"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let url = URL(string: args[1])!
        let token = readLine() ?? ""
        guard !token.isEmpty else { NSApp.terminate(nil); return }
        var properties: [HTTPCookiePropertyKey:Any] = [.name:"podium_session",.value:token,.domain:url.host!,.path:"/"]
        if url.scheme == "https" { properties[.secure] = "TRUE" }
        let cookie = HTTPCookie(properties: properties)!
        config.websiteDataStore.httpCookieStore.setCookie(cookie) {
            print("{\"event\":\"cookie-set\",\"secure\":\(cookie.isSecure)}"); fflush(stdout)
            self.web.load(URLRequest(url: url))
        }
        let owned = "{\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"nonpersistent\":true}"
        try! owned.write(to: root.appendingPathComponent("owned-app.json"), atomically: true, encoding: .utf8)
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { _ in
            self.sample()
            self.timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in self.sample() }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { navigationFinished = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationError = (error as NSError).code }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationError = (error as NSError).code }
    func sample() {
        if busy { return }
        busy = true
        let control = root.appendingPathComponent("control.js")
        if let source = try? String(contentsOf: control, encoding: .utf8) {
            try? FileManager.default.removeItem(at: control)
            web.evaluateJavaScript(source) { _, error in
                print("{\"event\":\"control\",\"ok\":\(error == nil)}"); fflush(stdout)
                self.busy = false
                self.sample()
            }
            return
        }
        if !attributed {
            attributed = true
            print("{\"event\":\"attribution-start\"}"); fflush(stdout)
            web.evaluateJavaScript("const until=performance.now()+2500;let n=0;while(performance.now()<until)n+=Math.sqrt(n+1);n") { _, _ in
                print("{\"event\":\"attribution-end\"}"); fflush(stdout)
                self.busy = false
                self.sample()
            }
            return
        }
        minute += 1
        let script = "JSON.stringify(window.__memoryWK.sample(\(minute)))"
        web.evaluateJavaScript(script) { result, error in
            defer { self.busy = false }
            if let value = result as? String {
                let path = self.root.appendingPathComponent("sample-\(self.minute).json")
                try? value.write(to: path, atomically: true, encoding: .utf8)
                print(value)
                fflush(stdout)
            } else {
                print("{\"event\":\"probe-error\",\"minute\":\(self.minute),\"loading\":\(self.web.isLoading),\"navigationFinished\":\(self.navigationFinished),\"navigationError\":\(self.navigationError.map(String.init) ?? "null")}")
                fflush(stdout)
            }
            if self.minute >= Int(self.args[4])! {
                self.timer?.invalidate()
                self.web.stopLoading()
                self.web.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
                    for cookie in cookies { self.web.configuration.websiteDataStore.httpCookieStore.delete(cookie) }
                    self.window.close()
                    NSApp.terminate(nil)
                }
            }
        }
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let capture = Capture()
application.delegate = capture
application.run()

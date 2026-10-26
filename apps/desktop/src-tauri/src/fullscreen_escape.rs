//! Escape belongs to the web app, even in a native macOS fullscreen Space.
//!
//! AppKit's NSWindow `cancelOperation:` fallback exits fullscreen when an Escape
//! reaches it. Suppress that fallback on the main window only. The real keyboard
//! event still travels through WebKit, including text input, iframes and terminals.
//! Window > Full Screen and its native shortcut still use `toggleFullScreen:`.

use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use objc2_app_kit::NSWindowStyleMask;

static WINDOW_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

extern "C" fn cancel_operation(window: &AnyObject, _cmd: Sel, sender: *mut AnyObject) {
    // SAFETY: This method is installed only on an NSWindow subclass. Its sender
    // and the method signature are the same as NSResponder's cancelOperation:.
    unsafe {
        let style: NSWindowStyleMask = msg_send![window, styleMask];
        if style.contains(NSWindowStyleMask::FullScreen) {
            return;
        }
        // Use our registered superclass, even if AppKit later subclasses the
        // instance again. Looking up window.class().superclass() could recurse.
        let superclass = WINDOW_CLASS.get().unwrap().superclass().unwrap();
        let _: () = msg_send![super(window, superclass), cancelOperation: sender];
    }
}

/// Called immediately after creation, inside the main-thread window builder.
pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let _main_thread = objc2::MainThreadMarker::new()
        .expect("fullscreen Escape routing must be installed on the main thread");
    let native = window.ns_window()?;
    // SAFETY: Tauri returns the live NSWindow, and the caller is on its UI thread.
    unsafe { install_on_window(&*native.cast::<AnyObject>()) };
    Ok(())
}

/// The receiver must implement NSWindow's styleMask and cancelOperation: methods,
/// and its owner must serialize class changes on the owning thread.
unsafe fn install_on_window(window: &AnyObject) {
    let subclass = WINDOW_CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new(c"PodiumMainWindowEscape", window.class())
            .expect("main window Escape class must be unique");
        // SAFETY: The override has NSResponder's void-returning, nullable-id ABI.
        unsafe {
            builder.add_method(
                sel!(cancelOperation:),
                cancel_operation as extern "C" fn(_, _, _),
            );
        }
        builder.register()
    });
    if window.class() == *subclass {
        return;
    }
    let superclass = subclass.superclass().unwrap();
    assert_eq!(window.class(), superclass);
    assert_eq!(subclass.instance_size(), superclass.instance_size());
    // SAFETY: This is a subclass of the current class, adds no ivars and overrides
    // one ABI-compatible method. No shared AppKit or Tauri class is modified.
    let previous = unsafe { AnyObject::set_class(window, subclass) };
    assert_eq!(previous, superclass);
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use objc2::rc::Retained;
    use objc2::runtime::NSObject;
    use objc2::{define_class, AllocAnyThread, DefinedClass};

    use super::*;

    #[derive(Default)]
    struct WindowState {
        fullscreen: Cell<bool>,
        native_cancellations: Cell<usize>,
    }

    // Exercise Objective-C dispatch and per-window isolation without opening a
    // GUI or entering a fullscreen Space on the test runner.
    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "PodiumFullscreenEscapeTestWindow"]
        #[ivars = WindowState]
        struct TestWindow;

        impl TestWindow {
            #[unsafe(method(styleMask))]
            fn style_mask(&self) -> NSWindowStyleMask {
                if self.ivars().fullscreen.get() {
                    NSWindowStyleMask::FullScreen
                } else {
                    NSWindowStyleMask::empty()
                }
            }

            #[unsafe(method(cancelOperation:))]
            fn cancel_operation(&self, _sender: Option<&AnyObject>) {
                let calls = &self.ivars().native_cancellations;
                calls.set(calls.get() + 1);
            }
        }
    );

    impl TestWindow {
        fn new() -> Retained<Self> {
            let window = Self::alloc().set_ivars(WindowState::default());
            unsafe { msg_send![super(window), init] }
        }

        fn cancel(&self) {
            let _: () = unsafe { msg_send![self, cancelOperation: None::<&AnyObject>] };
        }
    }

    #[test]
    fn fullscreen_cancellation_is_suppressed_only_on_the_installed_window() {
        let window = TestWindow::new();
        let untouched = TestWindow::new();
        let original_class = window.class();
        unsafe {
            install_on_window(window.as_ref());
            install_on_window(window.as_ref());
        }
        assert_eq!(
            window.class().instance_size(),
            original_class.instance_size()
        );
        assert_eq!(untouched.class(), original_class);

        window.cancel();
        assert_eq!(window.ivars().native_cancellations.get(), 1);

        window.ivars().fullscreen.set(true);
        window.cancel();
        window.cancel();
        assert_eq!(window.ivars().native_cancellations.get(), 1);

        untouched.ivars().fullscreen.set(true);
        untouched.cancel();
        assert_eq!(untouched.ivars().native_cancellations.get(), 1);

        window.ivars().fullscreen.set(false);
        window.cancel();
        assert_eq!(window.ivars().native_cancellations.get(), 2);
    }
}

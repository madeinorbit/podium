//! Escape belongs to the web app, even in a native macOS fullscreen Space.
//!
//! AppKit's NSWindow `cancelOperation:` fallback exits fullscreen when an Escape
//! reaches it. Suppress that fallback on the main window only. The real keyboard
//! event still travels through WebKit, including text input, iframes and terminals.
//! Window > Full Screen and its native shortcut still use `toggleFullScreen:`.

use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{ffi, msg_send, sel};
use objc2_app_kit::NSWindowStyleMask;

// The class that received the override, and the one window it applies to.
// Never swap the window's class: on macOS 27 AppKit asserts in titlebar layout
// (NSDP_getComputedPropertyValue) for an instance whose isa is a runtime subclass.
static PATCHED_CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
static MAIN_WINDOW: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());

extern "C" fn cancel_operation(window: &AnyObject, _cmd: Sel, sender: *mut AnyObject) {
    // SAFETY: This method is installed only on an NSWindow class. Its sender
    // and the method signature are the same as NSResponder's cancelOperation:.
    unsafe {
        if ptr::eq(window, MAIN_WINDOW.load(Ordering::Relaxed)) {
            let style: NSWindowStyleMask = msg_send![window, styleMask];
            if style.contains(NSWindowStyleMask::FullScreen) {
                return;
            }
        }
        // Use the patched class's superclass, even if AppKit later subclasses the
        // instance. Looking up window.class().superclass() could recurse.
        let patched = PATCHED_CLASS.get().copied().flatten().unwrap();
        let _: () =
            msg_send![super(window, patched.superclass().unwrap()), cancelOperation: sender];
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

/// The receiver must implement NSWindow's styleMask and inherit, not define,
/// cancelOperation:. Other instances of its class keep the inherited behavior.
unsafe fn install_on_window(window: &AnyObject) {
    let patched = PATCHED_CLASS.get_or_init(|| {
        let class = window.class();
        // SAFETY: The override has NSResponder's void-returning, nullable-id ABI.
        // class_addMethod refuses a class that defines the selector itself.
        let added = unsafe {
            let imp: Imp = std::mem::transmute(cancel_operation as extern "C" fn(_, _, _));
            ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(cancelOperation:),
                imp,
                c"v@:@".as_ptr(),
            )
        };
        if added == Bool::NO {
            log::error!(
                "{} already defines cancelOperation:; fullscreen Escape not routed",
                class.name().to_string_lossy()
            );
            return None;
        }
        Some(class)
    });
    if let Some(patched) = patched {
        assert_eq!(window.class(), *patched);
        MAIN_WINDOW.store(
            window as *const AnyObject as *mut AnyObject,
            Ordering::Relaxed,
        );
    }
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
    // GUI or entering a fullscreen Space on the test runner. The base stands in
    // for NSWindow, so the test class inherits cancelOperation: as TaoWindow does.
    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "PodiumFullscreenEscapeTestBase"]
        struct TestBase;

        impl TestBase {
            #[unsafe(method(cancelOperation:))]
            fn cancel_operation(&self, _sender: Option<&AnyObject>) {
                let _: () = unsafe { msg_send![self, recordNativeCancellation] };
            }
        }
    );

    define_class!(
        #[unsafe(super(TestBase, NSObject))]
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

            #[unsafe(method(recordNativeCancellation))]
            fn record_native_cancellation(&self) {
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
        assert_eq!(window.class(), original_class);
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

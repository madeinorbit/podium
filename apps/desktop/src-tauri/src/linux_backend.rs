use std::ffi::OsStr;

/// Only AppImages need to undo linuxdeploy's forced X11 backend.
fn backend_override(
    appimage: Option<&OsStr>,
    wayland_display: Option<&OsStr>,
    force_x11: Option<&OsStr>,
) -> Option<&'static str> {
    appimage?;
    if force_x11.is_some() {
        Some("x11")
    } else if wayland_display.is_some() {
        Some("wayland")
    } else {
        None
    }
}

/// Call first in main, while the process is single-threaded and before GTK initializes.
pub fn configure() {
    if let Some(backend) = backend_override(
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        std::env::var_os("PODIUM_FORCE_X11").as_deref(),
    ) {
        // AppRun has already exported GDK_BACKEND=x11 to work around tauri#8541.
        // A launch-line GDK_BACKEND cannot override that hook; this runs after it.
        std::env::set_var("GDK_BACKEND", backend);
    }
}

#[cfg(test)]
mod tests {
    use super::backend_override;
    use std::ffi::OsStr;

    #[test]
    fn appimages_use_native_wayland_when_available() {
        assert_eq!(
            backend_override(
                Some(OsStr::new("/opt/Podium.AppImage")),
                Some(OsStr::new("wayland-1")),
                None,
            ),
            Some("wayland"),
        );
    }

    #[test]
    fn any_force_x11_value_selects_x11_with_or_without_wayland() {
        for value in ["1", "0", ""] {
            for display in [Some(OsStr::new("wayland-1")), None] {
                assert_eq!(
                    backend_override(
                        Some(OsStr::new("/opt/Podium.AppImage")),
                        display,
                        Some(OsStr::new(value)),
                    ),
                    Some("x11"),
                );
            }
        }
    }

    #[test]
    fn appimages_without_wayland_keep_the_existing_backend() {
        assert_eq!(
            backend_override(Some(OsStr::new("/opt/Podium.AppImage")), None, None),
            None,
        );
    }

    #[test]
    fn other_linux_packages_keep_the_existing_backend() {
        for display in [Some(OsStr::new("wayland-1")), None] {
            for force in [Some(OsStr::new("1")), None] {
                assert_eq!(backend_override(None, display, force), None);
            }
        }
    }

    #[test]
    fn environment_presence_does_not_require_nonempty_values() {
        assert_eq!(
            backend_override(Some(OsStr::new("")), Some(OsStr::new("")), None),
            Some("wayland"),
        );
    }
}

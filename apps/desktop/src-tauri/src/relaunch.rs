//! Starting the next shell when this one restarts itself (after an update, a payload repair or
//! onboarding), so the restarted window comes back where the user left it.
//!
//! Tauri's own restart starts the new process only after `cleanup_before_exit`, which hides
//! every window on Windows, and on macOS it runs the bundle's executable directly instead of
//! launching the app. Neither is a launch the OS lets come to the front: the old process exits,
//! the system activates whatever app was behind Podium, and the new window opens under it. To
//! the user the app simply vanished.
//!
//! So the shell starts the next process itself, from `RunEvent::Exit` (before Tauri's cleanup),
//! and leaves Tauri's restart as the fallback:
//! - macOS: through LaunchServices (`open -n`), which activates the new instance the way a Dock
//!   click does. `-g` keeps it in the background when Podium was not frontmost, so an update
//!   finishing behind another app never steals focus.
//! - Windows: the process the foreground window's process starts may take the foreground, and
//!   the old window is still foreground at this point; `AllowSetForegroundWindow` hands the
//!   right on explicitly.
//! - Linux: a plain spawn, as Tauri does, only earlier (the compositor decides about focus).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, Manager};

const NONE: u8 = 0;
const BACKGROUND: u8 = 1;
const FOREGROUND: u8 = 2;

/// A restart Tauri has been asked for, and whether Podium was frontmost when it was.
///
/// Noted at `RunEvent::ExitRequested` (code `RESTART_EXIT_CODE`), while the window is certainly
/// still live; by `RunEvent::Exit` the event loop is already winding down.
#[derive(Default)]
pub struct PendingRestart(AtomicU8);

impl PendingRestart {
    pub fn note(&self, app: &AppHandle) {
        let foreground = app
            .get_webview_window("main")
            .is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
        self.0.store(
            if foreground { FOREGROUND } else { BACKGROUND },
            Ordering::Release,
        );
    }

    /// `None` when no restart is pending, else whether the next shell should come to the front.
    pub fn take(&self) -> Option<bool> {
        match self.0.swap(NONE, Ordering::AcqRel) {
            NONE => None,
            state => Some(state == FOREGROUND),
        }
    }
}

/// Start the next shell. `false` means nothing was started and Tauri's own restart must run.
pub fn start_next(app: &AppHandle, foreground: bool) -> bool {
    let env = app.env();
    let Ok(exe) = tauri::process::current_binary(&env) else {
        return false;
    };
    let args: Vec<OsString> = env.args_os.iter().skip(1).cloned().collect();

    #[cfg(target_os = "macos")]
    if let Some(bundle) = macos_bundle(&exe) {
        let podium_env: Vec<(OsString, OsString)> = std::env::vars_os()
            .filter(|(name, _)| name.to_string_lossy().starts_with("PODIUM_"))
            .collect();
        let argv = open_argv(&bundle, &args, &podium_env, foreground);
        // `open` returns once LaunchServices has the launch, so its status is the verdict; an
        // unspawned or refused launch falls back to Tauri's direct spawn rather than to nothing.
        return match std::process::Command::new("/usr/bin/open")
            .args(&argv)
            .status()
        {
            Ok(status) if status.success() => {
                log::info!("relaunching through LaunchServices (foreground: {foreground})");
                true
            }
            Ok(status) => {
                log::warn!("open refused the relaunch ({status}); falling back to a direct spawn");
                false
            }
            Err(error) => {
                log::warn!(
                    "cannot run open for the relaunch ({error}); falling back to a direct spawn"
                );
                false
            }
        };
    }

    match std::process::Command::new(&exe).args(&args).spawn() {
        Ok(child) => {
            #[cfg(windows)]
            if foreground {
                allow_foreground(child.id());
            }
            #[cfg(not(windows))]
            let _ = (child, foreground);
            true
        }
        Err(error) => {
            log::warn!("cannot spawn the restarted shell ({error}); leaving it to Tauri");
            false
        }
    }
}

/// The `.app` bundle an executable at `<bundle>.app/Contents/MacOS/<name>` belongs to.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// Arguments to `/usr/bin/open` that launch a NEW instance of `bundle` (the old one is still
/// alive while this runs, and without `-n` LaunchServices would just activate it). A launch
/// through LaunchServices gets the launchd environment, not ours, so the `PODIUM_*` overrides a
/// dev or demo instance was started with travel explicitly.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn open_argv(
    bundle: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
    foreground: bool,
) -> Vec<OsString> {
    let mut argv: Vec<OsString> = vec!["-n".into()];
    if !foreground {
        argv.push("-g".into());
    }
    for (name, value) in env {
        let mut pair = name.clone();
        pair.push("=");
        pair.push(value);
        argv.push("--env".into());
        argv.push(pair);
    }
    argv.push(bundle.into());
    if !args.is_empty() {
        argv.push("--args".into());
        argv.extend(args.iter().cloned());
    }
    argv
}

#[cfg(windows)]
fn allow_foreground(pid: u32) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn AllowSetForegroundWindow(pid: u32) -> i32;
    }
    if unsafe { AllowSetForegroundWindow(pid) } == 0 {
        log::warn!("could not hand the foreground to the restarted shell");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(argv: &[OsString]) -> Vec<&str> {
        argv.iter().map(|a| a.to_str().unwrap()).collect()
    }

    #[test]
    fn bundle_is_found_only_for_an_executable_inside_contents_macos() {
        assert_eq!(
            macos_bundle(Path::new("/Applications/Podium.app/Contents/MacOS/Podium")),
            Some(PathBuf::from("/Applications/Podium.app"))
        );
        assert_eq!(macos_bundle(Path::new("/repo/target/debug/Podium")), None);
        assert_eq!(
            macos_bundle(Path::new("/x/Podium/Contents/MacOS/Podium")),
            None
        );
        assert_eq!(
            macos_bundle(Path::new("/x/Podium.app/Contents/Resources/Podium")),
            None
        );
    }

    #[test]
    fn a_frontmost_shell_relaunches_activated_as_a_new_instance() {
        let argv = open_argv(Path::new("/Applications/Podium.app"), &[], &[], true);
        assert_eq!(strings(&argv), ["-n", "/Applications/Podium.app"]);
    }

    #[test]
    fn a_background_shell_relaunches_without_stealing_focus() {
        let argv = open_argv(Path::new("/Applications/Podium.app"), &[], &[], false);
        assert_eq!(strings(&argv), ["-n", "-g", "/Applications/Podium.app"]);
    }

    #[test]
    fn overrides_and_arguments_survive_the_launchservices_hop() {
        let argv = open_argv(
            Path::new("/Applications/Podium.app"),
            &["--flag".into(), "value".into()],
            &[("PODIUM_STATE_DIR".into(), "/tmp/demo state".into())],
            true,
        );
        assert_eq!(
            strings(&argv),
            [
                "-n",
                "--env",
                "PODIUM_STATE_DIR=/tmp/demo state",
                "/Applications/Podium.app",
                "--args",
                "--flag",
                "value"
            ]
        );
    }

    #[test]
    fn a_noted_restart_is_taken_once() {
        let pending = PendingRestart::default();
        assert_eq!(pending.take(), None);
        pending.0.store(FOREGROUND, Ordering::Release);
        assert_eq!(pending.take(), Some(true));
        assert_eq!(pending.take(), None);
        pending.0.store(BACKGROUND, Ordering::Release);
        assert_eq!(pending.take(), Some(false));
    }
}

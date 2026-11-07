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
//!   finishing behind another app never steals focus. The launch waits for this process to exit:
//!   while two instances of the bundle run, the Dock gives the new one a second, unpinned tile
//!   (tauri-apps/tauri#16449). Chromium's relauncher works the same way: a helper waits for the
//!   parent, then launches through LaunchServices, activated only if the parent was active.
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
        return match waiter_command(std::process::id(), Path::new("/usr/bin/open"), &exe, &argv)
            .spawn()
        {
            Ok(_) => {
                log::info!("relaunching through LaunchServices once this shell exits (foreground: {foreground})");
                true
            }
            Err(error) => {
                log::warn!("cannot start the relaunch waiter ({error}); leaving it to Tauri");
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

/// How long the waiter gives this process to exit before it launches anyway, in 0.1 s steps.
const WAIT_STEPS: u32 = 100;

/// The relaunch waiter: `sh -c WAITER_SCRIPT sh <pid> <open> <exe> <open arguments…>`. It waits
/// (bounded) for `<pid>` to exit, then runs `<open>` with the open arguments; if that fails it
/// runs `<exe>` directly with the app's own arguments, which are whatever follows `--args`
/// (an `--env NAME=VALUE` pair or the bundle path is never that word).
const WAITER_SCRIPT: &str = r#"pid=$1; open=$2; exe=$3; steps=$4; shift 4
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$steps" ]; do sleep 0.1; i=$((i+1)); done
"$open" "$@" && exit 0
while [ "$#" -gt 0 ] && [ "$1" != --args ]; do shift; done
[ "$#" -gt 0 ] && shift
exec "$exe" "$@"
"#;

/// The waiter that launches the next shell once `pid` has exited. It runs detached: its own
/// process group, so nothing aimed at the exiting shell's group reaches it, and stdio on
/// `/dev/null`, so it never writes to a terminal or pipe whose reader left with the old shell.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn waiter_command(
    pid: u32,
    open: &Path,
    exe: &Path,
    open_args: &[OsString],
) -> std::process::Command {
    waiter_command_with_steps(pid, open, exe, open_args, WAIT_STEPS)
}

#[cfg_attr(not(unix), allow(dead_code))]
fn waiter_command_with_steps(
    pid: u32,
    open: &Path,
    exe: &Path,
    open_args: &[OsString],
    steps: u32,
) -> std::process::Command {
    use std::process::Stdio;
    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(WAITER_SCRIPT)
        .arg("sh")
        .arg(pid.to_string())
        .arg(open)
        .arg(exe)
        .arg(steps.to_string())
        .args(open_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command
}

/// Arguments to `/usr/bin/open` that launch a NEW instance of `bundle`. The waiter normally runs
/// it after the old one has exited, but if that took too long the old one is still alive, and
/// without `-n` LaunchServices would just activate the dying instance. A launch
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

    /// A stand-in for `/usr/bin/open` or the app: records its arguments, one per line, and
    /// whether `old` was still alive when it ran, then exits with `status`.
    #[cfg(unix)]
    fn recorder(dir: &Path, name: &str, old: u32, status: u8) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        let log = dir.join(format!("{name}.log"));
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nif kill -0 {old} 2>/dev/null; then echo old-alive; else echo old-gone; fi > '{log}'\nprintf '%s\\n' \"$@\" >> '{log}'\nexit {status}\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn scratch(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("podium-relaunch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Run the waiter against a stand-in old shell that exits after 0.3 s.
    #[cfg(unix)]
    fn run_waiter(dir: &Path, open_status: u8, open_args: &[OsString]) {
        let mut old = std::process::Command::new("sleep")
            .arg("0.3")
            .spawn()
            .unwrap();
        let open = recorder(dir, "open", old.id(), open_status);
        let exe = recorder(dir, "exe", old.id(), 0);
        let mut waiter = waiter_command(old.id(), &open, &exe, open_args)
            .spawn()
            .unwrap();
        // Reap the stand-in as launchd reaps the real shell; an unreaped zombie answers kill -0.
        old.wait().unwrap();
        assert!(waiter.wait().unwrap().success());
    }

    #[cfg(unix)]
    fn log_lines(dir: &Path, name: &str) -> Option<Vec<String>> {
        std::fs::read_to_string(dir.join(format!("{name}.log")))
            .ok()
            .map(|log| log.lines().map(str::to_owned).collect())
    }

    #[cfg(unix)]
    #[test]
    fn the_waiter_launches_only_after_the_old_shell_has_exited() {
        let dir = scratch("waits");
        let argv = open_argv(Path::new("/Applications/Podium.app"), &[], &[], true);
        run_waiter(&dir, 0, &argv);
        assert_eq!(
            log_lines(&dir, "open").unwrap(),
            ["old-gone", "-n", "/Applications/Podium.app"]
        );
        assert_eq!(log_lines(&dir, "exe"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_open_falls_back_to_the_executable_with_the_app_arguments() {
        let dir = scratch("fallback");
        let argv = open_argv(
            Path::new("/Applications/Podium.app"),
            &["--flag".into(), "two words".into()],
            &[("PODIUM_STATE_DIR".into(), "/tmp/demo".into())],
            false,
        );
        run_waiter(&dir, 1, &argv);
        assert_eq!(log_lines(&dir, "open").unwrap()[0], "old-gone");
        assert_eq!(
            log_lines(&dir, "exe").unwrap(),
            ["old-gone", "--flag", "two words"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_shell_that_never_exits_is_relaunched_anyway_after_the_bound() {
        let dir = scratch("bound");
        let mut old = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let open = recorder(&dir, "open", old.id(), 0);
        let started = std::time::Instant::now();
        let status = waiter_command_with_steps(old.id(), &open, &open, &["-n".into()], 3)
            .status()
            .unwrap();
        let _ = old.kill();
        let _ = old.wait();
        assert!(status.success());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(log_lines(&dir, "open").unwrap(), ["old-alive", "-n"]);
        let _ = std::fs::remove_dir_all(&dir);
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

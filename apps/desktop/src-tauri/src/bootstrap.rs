use std::net::TcpListener;
use std::path::{Path, PathBuf};

/// Bind an ephemeral loopback port and return it (best-effort; falls back to 18787).
///
/// NOTE: The port is not reserved between this call and when the backend binds it (TOCTOU).
/// This is acceptable for a localhost picker — the window between pick and bind is tiny and
/// the port is only used locally.
pub fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(18787)
}

/// The script injected before page load so the bundled web UI talks to the local backend
/// (Phase 2 serverConfig reads window.__PODIUM_SERVER__ first).
pub fn injection_script(port: u16) -> String {
    format!("window.__PODIUM_SERVER__ = 'ws://127.0.0.1:{port}';")
}

/// Block until http://127.0.0.1:<port>/health accepts a TCP connection or the budget runs
/// out. Returns true if the port became reachable. (A TCP connect is enough — the server
/// only binds once it is serving.)
pub fn wait_for_port(port: u16, attempts: u32, delay_ms: u64) -> bool {
    use std::net::TcpStream;
    for _ in 0..attempts {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
    }
    false
}

/// Copy `src` to `<cache_dir>/podium-sidecar` (chmod 0o755 on unix), re-copying when
/// missing/size-differs/source-newer; return the runnable path.
fn ensure_executable_into(src: &Path, cache_dir: &Path) -> std::io::Result<PathBuf> {
    use std::fs;

    let dst = cache_dir.join("podium-sidecar");

    // Re-copy if: cache missing, OR sizes differ, OR source is newer than cache.
    let src_meta = fs::metadata(src)?;
    let needs_copy = match fs::metadata(&dst) {
        Err(_) => true,
        Ok(dst_meta) => {
            if dst_meta.len() != src_meta.len() {
                true
            } else {
                // Compare mtimes — re-copy if source is strictly newer.
                match (src_meta.modified(), dst_meta.modified()) {
                    (Ok(src_mtime), Ok(dst_mtime)) => src_mtime > dst_mtime,
                    // If mtime is unavailable (some platforms), be conservative and copy.
                    _ => true,
                }
            }
        }
    };

    if needs_copy {
        fs::create_dir_all(cache_dir)?;
        fs::copy(src, &dst)?;
    }

    // Ensure executable bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dst)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dst, perms)?;
    }

    Ok(dst)
}

/// Return a path to an executable copy of `path`.
///
/// AppImage mounts are read-only and may not preserve the executable bit, so we
/// copy the binary to a writable cache dir and chmod it there.  We re-copy when
/// the cache is missing, the source size differs, or the source is newer than the cache.
///
/// Cache location: `$PODIUM_STATE_DIR/bin/podium-sidecar` if set,
/// otherwise `~/.podium/bin/podium-sidecar`.
pub fn ensure_executable(path: &Path) -> std::io::Result<PathBuf> {
    let base = std::env::var("PODIUM_STATE_DIR")
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{home}/.podium")
        });
    ensure_executable_into(path, &std::path::Path::new(&base).join("bin"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_free_port_is_nonzero() {
        assert!(pick_free_port() > 0);
    }

    #[test]
    fn injection_script_embeds_the_port() {
        let s = injection_script(18799);
        assert!(s.contains("ws://127.0.0.1:18799"));
        assert!(s.contains("__PODIUM_SERVER__"));
    }

    #[test]
    fn wait_for_port_times_out_on_a_closed_port() {
        // A port nothing is listening on returns false quickly.
        assert!(!wait_for_port(1, 2, 10));
    }

    #[test]
    fn ensure_executable_into_returns_path_to_existing_executable() {
        use std::fs;
        use std::io::Write;

        // Separate temp dirs for source and cache (no env mutation).
        let tmp = std::env::temp_dir()
            .join(format!("podium-ensure-exe-test-{}", std::process::id()));
        let src_dir = tmp.join("src");
        let cache_dir = tmp.join("cache");
        fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.join("fake-podium");
        fs::File::create(&src)
            .unwrap()
            .write_all(b"#!/bin/sh\necho hello\n")
            .unwrap();

        let result = ensure_executable_into(&src, &cache_dir)
            .expect("ensure_executable_into failed");

        assert!(result.exists(), "result path does not exist: {result:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&result).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "file is not executable, mode={mode:o}");
        }

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ensure_executable_into_recopy_when_source_differs() {
        use std::fs;
        use std::io::Write;

        let tmp = std::env::temp_dir()
            .join(format!("podium-freshness-test-{}", std::process::id()));
        let src_dir = tmp.join("src");
        let cache_dir = tmp.join("cache");
        fs::create_dir_all(&src_dir).unwrap();

        let src = src_dir.join("fake-podium");

        // First copy: write initial content.
        fs::File::create(&src)
            .unwrap()
            .write_all(b"version-1")
            .unwrap();
        let result = ensure_executable_into(&src, &cache_dir)
            .expect("first copy failed");
        assert_eq!(fs::read(&result).unwrap(), b"version-1");

        // Second copy: different size → must re-copy regardless of mtime.
        fs::File::create(&src)
            .unwrap()
            .write_all(b"version-2-longer")
            .unwrap();

        let result2 = ensure_executable_into(&src, &cache_dir)
            .expect("second copy failed");
        assert_eq!(
            fs::read(&result2).unwrap(),
            b"version-2-longer",
            "cache was not refreshed when source size changed"
        );

        // Third copy: same content again — should NOT re-copy (idempotent).
        let result3 = ensure_executable_into(&src, &cache_dir)
            .expect("third copy failed");
        assert_eq!(
            fs::read(&result3).unwrap(),
            b"version-2-longer",
            "cache content changed unexpectedly on idempotent call"
        );

        let _ = fs::remove_dir_all(&tmp);
    }
}

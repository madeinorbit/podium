use std::net::TcpListener;
use std::path::{Path, PathBuf};

/// Bind an ephemeral loopback port and return it (best-effort; falls back to 18787).
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

/// Return a path to an executable copy of `path`.
///
/// AppImage mounts are read-only and may not preserve the executable bit, so we
/// copy the binary to a writable cache dir and chmod it there.  We skip the copy
/// if the cached file already exists AND has the same size as the source (cheap
/// freshness check that avoids a 100 MB copy on every launch).
///
/// Cache location: `$PODIUM_STATE_DIR/bin/podium-sidecar` if set,
/// otherwise `~/.podium/bin/podium-sidecar`.
pub fn ensure_executable(path: &Path) -> std::io::Result<PathBuf> {
    use std::fs;

    // Determine cache destination.
    let cache_dir = if let Ok(d) = std::env::var("PODIUM_STATE_DIR") {
        PathBuf::from(d).join("bin")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join(".podium").join("bin")
    };
    let dst = cache_dir.join("podium-sidecar");

    // Only re-copy when missing or stale (different size).
    let src_meta = fs::metadata(path)?;
    let needs_copy = match fs::metadata(&dst) {
        Ok(dst_meta) => dst_meta.len() != src_meta.len(),
        Err(_) => true,
    };

    if needs_copy {
        fs::create_dir_all(&cache_dir)?;
        fs::copy(path, &dst)?;
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
    fn ensure_executable_returns_path_to_existing_executable() {
        use std::fs;
        use std::io::Write;

        // Create a temporary source file.
        let tmp_dir = std::env::temp_dir().join(format!("podium-ensure-exe-test-{}", std::process::id()));
        fs::create_dir_all(&tmp_dir).unwrap();
        let src = tmp_dir.join("fake-podium");
        let mut f = fs::File::create(&src).unwrap();
        f.write_all(b"#!/bin/sh\necho hello\n").unwrap();
        drop(f);

        // Override PODIUM_STATE_DIR so the cache lands in our temp dir.
        let state_dir = tmp_dir.join("state");
        std::env::set_var("PODIUM_STATE_DIR", &state_dir);

        let result = ensure_executable(&src).expect("ensure_executable failed");

        // The returned path must exist and be executable.
        assert!(result.exists(), "result path does not exist: {result:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&result).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "file is not executable, mode={mode:o}");
        }

        // Clean up.
        let _ = fs::remove_dir_all(&tmp_dir);
    }
}

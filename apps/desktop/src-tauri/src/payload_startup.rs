//! Cold-start ownership and the bundled CLI boundary. Policy, preparation and
//! activation live in @podium/runtime; the shell only supplies its immutable source.
use crate::bootstrap;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Executor, Row};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Same rollback-mode SQLite protocol as runtime/installation-lease.ts. A read
/// transaction is a lifetime shared usage lease. Startup mutation needs EXCLUSIVE.
pub struct PayloadUsageLease {
    connection: SqliteConnection,
    pub install: PathBuf,
    pub exclusive: bool,
}

fn canonical_path(path: &Path) -> std::io::Result<PathBuf> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => return path.canonicalize(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let absolute = std::path::absolute(path)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| std::io::Error::other("payload has no parent"))?;
    let name = absolute
        .file_name()
        .ok_or_else(|| std::io::Error::other("payload has no filename"))?;
    Ok(canonical_path(parent)?.join(name))
}

impl PayloadUsageLease {
    pub fn acquire(install: &Path) -> Result<Self, String> {
        let install = canonical_path(install).map_err(|error| error.to_string())?;
        let metadata = PathBuf::from(format!("{}.lifecycle", install.display()));
        std::fs::create_dir_all(&metadata).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        std::fs::File::open(metadata.parent().expect("payload metadata has a parent"))
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "cannot sync payload installation ownership")?;
        let (connection, exclusive) = tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(metadata.join("usage.sqlite"))
                .create_if_missing(true)
                .busy_timeout(Duration::from_secs(30));
            let mut connection = SqliteConnection::connect_with(&options).await?;
            let mode = sqlx::query("PRAGMA journal_mode")
                .fetch_one(&mut connection)
                .await?;
            if mode.get::<String, _>(0) != "delete" {
                return Err(sqlx::Error::Protocol(
                    "installation lease must use DELETE journal mode".into(),
                ));
            }
            connection
                .execute("CREATE TABLE IF NOT EXISTS installation_lease (id INTEGER PRIMARY KEY)")
                .await?;
            connection.execute("PRAGMA busy_timeout = 0").await?;
            let exclusive = match connection.execute("BEGIN EXCLUSIVE").await {
                Ok(_) => true,
                Err(sqlx::Error::Database(error)) if error.code().as_deref() == Some("5") => false,
                Err(error) => return Err(error),
            };
            if !exclusive {
                connection.execute("PRAGMA busy_timeout = 30000").await?;
                connection.execute("BEGIN").await?;
                connection
                    .execute("SELECT id FROM installation_lease LIMIT 1")
                    .await?;
            }
            Ok::<_, sqlx::Error>((connection, exclusive))
        })
        .map_err(|_| "cannot acquire payload installation ownership".to_string())?;
        Ok(Self {
            connection,
            install,
            exclusive,
        })
    }

    /// Do not leave a mutation-to-spawn gap. Another contender that won this gap
    /// finishes first; this frame then takes shared usage before reading/spawning.
    fn into_shared(mut self) -> Result<Self, String> {
        if self.exclusive {
            tauri::async_runtime::block_on(async {
                self.connection.execute("COMMIT").await?;
                self.connection
                    .execute("PRAGMA busy_timeout = 30000")
                    .await?;
                self.connection.execute("BEGIN").await?;
                self.connection
                    .execute("SELECT id FROM installation_lease LIMIT 1")
                    .await?;
                Ok::<_, sqlx::Error>(())
            })
            .map_err(|_| "cannot retain payload installation usage".to_string())?;
            self.exclusive = false;
        }
        Ok(self)
    }

    fn register_state_root(&self, state: &Path) -> Result<(), String> {
        let state = canonical_path(state).map_err(|_| "cannot resolve payload state root")?;
        let roots = PathBuf::from(format!("{}.lifecycle", self.install.display())).join("roots");
        std::fs::create_dir_all(&roots).map_err(|_| "cannot register payload state root")?;
        #[cfg(unix)]
        std::fs::File::open(roots.parent().expect("payload state roots have a parent"))
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "cannot sync payload state-root directory")?;
        // The runtime also writes SHA256-named records. Readers inspect record content,
        // not filenames; a collision here refuses rather than losing an older root.
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        state.hash(&mut hash);
        let path = roots.join(format!("native-{:016x}.json", hash.finish()));
        let record = serde_json::json!({ "format": 1, "stateDir": state });
        let present = match std::fs::symlink_metadata(&path) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err("cannot inspect payload state-root record".into()),
        };
        if present {
            let prior: serde_json::Value = serde_json::from_slice(
                &std::fs::read(&path).map_err(|_| "cannot read payload state-root record")?,
            )
            .map_err(|_| "invalid payload state-root record")?;
            return if prior == record {
                Ok(())
            } else {
                Err("payload state-root collision".into())
            };
        }
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut file = std::fs::File::create(&temporary)
            .map_err(|_| "cannot stage payload state-root record")?;
        file.write_all(format!("{record}\n").as_bytes())
            .map_err(|_| "cannot write payload state-root record")?;
        file.sync_all()
            .map_err(|_| "cannot sync payload state-root record")?;
        std::fs::rename(temporary, path).map_err(|_| "cannot publish payload state-root record")?;
        #[cfg(unix)]
        std::fs::File::open(roots)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "cannot sync payload state roots")?;
        Ok(())
    }
}

fn run_bundled_startup(
    seed: &Path,
    lease: &PayloadUsageLease,
    app_managed: bool,
) -> Result<serde_json::Value, String> {
    let binary = seed.join(if cfg!(windows) {
        "podium-cli.exe"
    } else {
        "podium-cli"
    });
    let request = serde_json::json!({
        "seed": seed,
        "installDir": lease.install,
        "stateDir": bootstrap::state_dir(),
        // The signed source supplies its build channel. The CLI independently
        // checks every instance's configured/env channel against this authority.
        "channel": bootstrap::build_update_channel().as_str(),
        "releaseBuild": true,
        "exclusive": true,
        "appManaged": app_managed,
    });
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .arg("--desktop-payload-startup")
        .env("PODIUM_DESKTOP_PAYLOAD_STARTUP", request.to_string())
        .env("PODIUM_HOME", seed)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "cannot start bundled payload preparation")?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if child
            .try_wait()
            .map_err(|_| "cannot observe bundled payload preparation")?
            .is_some()
        {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("bundled payload preparation timed out; recovery bytes retained".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "cannot read bundled payload preparation")?;
    if !output.status.success() {
        return Err("bundled payload preparation failed; existing payload retained".into());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "invalid bundled payload preparation result".into())
}

/// Called exactly once from Tauri setup, never by the child respawn monitor.
pub fn prepare(seed: &Path, install: &Path, app_data: &Path) -> Result<PayloadUsageLease, String> {
    let lease = PayloadUsageLease::acquire(install)?;
    let app_managed = canonical_path(&app_data.join("payload"))
        .map_err(|_| "cannot resolve application payload root")?
        == lease.install;
    if let Err(error) = lease.register_state_root(&bootstrap::state_dir()) {
        log::warn!("desktop payload startup: bundled fallback deferred: {error}");
        return lease.into_shared();
    }
    if lease.exclusive {
        if cfg!(debug_assertions) {
            // Debug/source shells only perform the existing first-install seed.
            if !lease.install.exists() {
                if PathBuf::from(format!("{}.old", lease.install.display())).exists()
                    || PathBuf::from(format!("{}.prepared", lease.install.display())).exists()
                    || bootstrap::state_dir()
                        .join("runtime/machine-update.json")
                        .exists()
                {
                    return Err("payload recovery is pending; first-install seed deferred".into());
                }
                bootstrap::seed_payload_if_absent(seed, &lease.install)
                    .map_err(|error| format!("payload seed failed: {error}"))?;
            }
            log::info!("desktop payload startup: debug shell preserves installed runtime");
        } else {
            match run_bundled_startup(seed, &lease, app_managed) {
                Ok(result) if result["outcome"] == "seed" => {
                    bootstrap::seed_payload_if_absent(seed, &lease.install)
                        .map_err(|error| format!("payload seed failed: {error}"))?;
                    log::info!("desktop payload startup: seeded missing runtime");
                }
                Ok(result) => log::info!("desktop payload startup: {result}"),
                Err(error) => log::warn!("desktop payload startup: {error}"),
            }
        }
    } else {
        log::info!("desktop payload startup: live installation owner; bundled fallback deferred until a later eligible cold start");
    }
    lease.into_shared()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "podium-native-payload-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parent_successor_and_other_instance_share_usage_but_block_startup_mutation() {
        let fixture = Fixture::new();
        let install = fixture.0.join("payload");
        let initial = PayloadUsageLease::acquire(&install).unwrap();
        assert!(initial.exclusive);
        let frame = initial.into_shared().unwrap();
        let successor = PayloadUsageLease::acquire(&install).unwrap();
        let other_instance = PayloadUsageLease::acquire(&install).unwrap();
        assert!(!successor.exclusive);
        assert!(!other_instance.exclusive);
        frame.register_state_root(&fixture.0.join("blue")).unwrap();
        other_instance
            .register_state_root(&fixture.0.join("green"))
            .unwrap();
        let roots = PathBuf::from(format!("{}.lifecycle", install.display())).join("roots");
        assert_eq!(std::fs::read_dir(roots).unwrap().count(), 2);
    }

    #[test]
    fn independent_installations_do_not_share_a_lease() {
        let fixture = Fixture::new();
        let first = PayloadUsageLease::acquire(&fixture.0.join("blue")).unwrap();
        let second = PayloadUsageLease::acquire(&fixture.0.join("green")).unwrap();
        assert!(first.exclusive && second.exclusive);
    }

    #[test]
    fn corrupt_root_history_is_preserved_and_refused() {
        let fixture = Fixture::new();
        let lease = PayloadUsageLease::acquire(&fixture.0.join("payload")).unwrap();
        let state = fixture.0.join("state");
        lease.register_state_root(&state).unwrap();
        let roots = PathBuf::from(format!("{}.lifecycle", lease.install.display())).join("roots");
        let record = std::fs::read_dir(roots)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::write(&record, "{corrupt history").unwrap();
        assert!(lease.register_state_root(&state).is_err());
        assert_eq!(std::fs::read_to_string(record).unwrap(), "{corrupt history");
    }

    #[cfg(unix)]
    #[test]
    fn broken_alias_and_root_record_never_become_empty_history() {
        let fixture = Fixture::new();
        let missing = fixture.0.join("missing");
        let alias = fixture.0.join("broken-alias");
        std::os::unix::fs::symlink(&missing, &alias).unwrap();
        assert!(canonical_path(&alias.join("payload")).is_err());
        let lease = PayloadUsageLease::acquire(&fixture.0.join("payload")).unwrap();
        let state = fixture.0.join("state");
        lease.register_state_root(&state).unwrap();
        let roots = PathBuf::from(format!("{}.lifecycle", lease.install.display())).join("roots");
        let record = std::fs::read_dir(roots)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::remove_file(&record).unwrap();
        std::os::unix::fs::symlink(&missing, &record).unwrap();
        assert!(lease.register_state_root(&state).is_err());
        assert_eq!(std::fs::read_link(record).unwrap(), missing);
    }

    #[cfg(unix)]
    #[test]
    fn aliases_resolve_to_the_same_installation_before_seeding() {
        let fixture = Fixture::new();
        let actual = fixture.0.join("data");
        let alias = fixture.0.join("alias");
        std::fs::create_dir_all(&actual).unwrap();
        std::os::unix::fs::symlink(&actual, &alias).unwrap();
        let first = PayloadUsageLease::acquire(&actual.join("payload"))
            .unwrap()
            .into_shared()
            .unwrap();
        let second = PayloadUsageLease::acquire(&alias.join("payload")).unwrap();
        assert_eq!(first.install, second.install);
        assert!(!second.exclusive);
    }
}

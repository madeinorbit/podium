#![cfg(windows)]
//! A real Windows job boundary: kill the launcher's job, then attach to the
//! detached host and kill its child over SPEC-6. No daemon/browser stand-in.
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::ptr::null;
use std::time::Duration;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::*;

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn frame(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 1) as u32).to_be_bytes().to_vec();
    out.push(ty);
    out.extend(payload);
    out
}
fn recv(pipe: &mut fs::File) -> (u8, Vec<u8>) {
    let mut length = [0; 4];
    pipe.read_exact(&mut length).unwrap();
    let n = u32::from_be_bytes(length) as usize;
    assert!((1..=16_777_216).contains(&n));
    let mut p = vec![0; n];
    pipe.read_exact(&mut p).unwrap();
    (p[0], p[1..].to_vec())
}
#[test]
fn detached_host_survives_termination_of_launcher_job() {
    let name = format!(r"\\.\pipe\podium-host-job-test-{}", std::process::id());
    let pidfile =
        std::env::temp_dir().join(format!("podium-host-job-test-{}.pid", std::process::id()));
    let exe = env!("CARGO_BIN_EXE_podium-host");
    let mut cmd = wide(format!(
        "\"{exe}\" create --socket {name} --pidfile \"{}\" --no-pty --linger-secs 0 -- powershell.exe -NoLogo -NoProfile -Command \"Write-Output JOB_BOUNDARY; Start-Sleep 60\"",
        pidfile.display()
    ));
    unsafe {
        let job = Handle(CreateJobObjectW(null(), null()));
        assert!(!job.0.is_null());
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        assert_ne!(
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32
            ),
            0
        );
        let mut si: STARTUPINFOW = zeroed();
        si.cb = size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = zeroed();
        assert_ne!(
            CreateProcessW(
                wide(exe).as_ptr(),
                cmd.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                null(),
                null(),
                &si,
                &mut pi
            ),
            0
        );
        let process = Handle(pi.hProcess);
        let thread = Handle(pi.hThread);
        assert_ne!(AssignProcessToJobObject(job.0, process.0), 0);
        assert_ne!(ResumeThread(thread.0), u32::MAX);
        assert_eq!(WaitForSingleObject(process.0, 30_000), WAIT_OBJECT_0);
        let mut code = 999;
        assert_ne!(GetExitCodeProcess(process.0, &mut code), 0);
        assert_eq!(code, 0);
        // Windows kills all non-breakaway descendants in this job now.
        assert_ne!(TerminateJobObject(job.0, 91), 0);
        drop(job);
    }
    let mut pipe = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&name)
        .unwrap();
    let mut hello = vec![0, 1, 1];
    hello.extend(0u64.to_be_bytes());
    pipe.write_all(&frame(1, &hello)).unwrap();
    let (ty, welcome) = recv(&mut pipe);
    assert_eq!(ty, 0x81);
    let pid = u32::from_be_bytes(welcome[2..6].try_into().unwrap());
    assert_eq!(fs::read_to_string(&pidfile).unwrap(), format!("{pid}\n"));
    let host = Handle(unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    });
    assert!(!host.0.is_null());
    assert_eq!(unsafe { WaitForSingleObject(host.0, 0) }, WAIT_TIMEOUT);
    pipe.write_all(&frame(5, &[])).unwrap();
    loop {
        let (ty, p) = recv(&mut pipe);
        if ty == 0x86 {
            assert_eq!(p[0], 1);
            break;
        }
    }
    pipe.write_all(&frame(8, &[])).unwrap();
    loop {
        if recv(&mut pipe).0 == 0x88 {
            break;
        }
    }
    drop(pipe);
    assert_eq!(
        unsafe { WaitForSingleObject(host.0, 10_000) },
        WAIT_OBJECT_0
    );
    assert!(!pidfile.exists());
    std::thread::sleep(Duration::from_millis(10));
    assert!(
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)
            .is_err()
    );
}

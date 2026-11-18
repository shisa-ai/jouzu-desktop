use std::{io::Write, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Entry {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}

pub(crate) fn validate(entries: &[Entry]) -> Result<(), String> {
    let mut names = std::collections::HashSet::new();
    for entry in entries {
        if entry.name.is_empty()
            || entry.name.len() > 128
            || !entry
                .name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || entry.name.as_bytes()[0].is_ascii_digit()
            || entry.value.contains('\0')
            || entry.value.len() > 32767
        {
            return Err("Invalid environment entry".into());
        }
        let name = entry.name.to_ascii_uppercase();
        if ["JOUZU_HOME", "JOUZU_LAUNCHER_BASH", "NODE_OPTIONS", "PATH"].contains(&name.as_str())
            || name.starts_with("JOUZU_LAUNCHER_DEV_")
        {
            return Err("This variable is managed by the launcher".into());
        }
        if !names.insert(name) {
            return Err("Duplicate variable name".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn protect(input: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    #[repr(C)]
    struct Blob {
        count: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut u8,
            prompt: *mut u8,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut u8,
            prompt: *mut u8,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(pointer: *mut u8) -> *mut u8;
    }
    let data = Blob {
        count: input
            .len()
            .try_into()
            .map_err(|_| "Environment data too large")?,
        data: input.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        count: 0,
        data: std::ptr::null_mut(),
    };
    unsafe {
        let ok = if decrypt {
            CryptUnprotectData(
                &data,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptProtectData(
                &data,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Windows credential protection failed".into());
        }
        let bytes = std::slice::from_raw_parts(output.data, output.count as usize).to_vec();
        LocalFree(output.data);
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("Secure environment storage is not available on this platform".into())
}

fn path(home: &Path) -> std::path::PathBuf {
    home.join("launcher-environment.bin")
}

pub fn read(home: &Path) -> Result<Vec<Entry>, String> {
    let bytes = match std::fs::read(path(home)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Cannot read environment settings".into()),
    };
    let entries: Vec<Entry> =
        serde_json::from_slice(&protect(&bytes, true)?).map_err(|_| "Invalid environment settings")?;
    validate(&entries)?;
    Ok(entries)
}

/// The enabled saved variables, read from disk at the moment of the call. Every
/// process the host starts (configuration service, warm and session runtimes)
/// calls this at start, so a saved change applies to the next process without a
/// host restart and nothing holds a stale copy.
pub fn enabled(home: &Path) -> Result<Vec<(String, String)>, String> {
    Ok(read(home)?
        .into_iter()
        .filter(|entry| entry.enabled)
        .map(|entry| (entry.name, entry.value))
        .collect())
}

pub fn save(home: &Path, entries: &[Entry]) -> Result<(), String> {
    validate(entries)?;
    std::fs::create_dir_all(home).map_err(|_| "Cannot create settings directory")?;
    let bytes = serde_json::to_vec(entries).map_err(|_| "Cannot encode environment settings")?;
    let encrypted = protect(&bytes, false)?;
    let target = path(home);
    let temp = target.with_extension("bin.tmp");
    let mut file = std::fs::File::create(&temp).map_err(|_| "Cannot prepare settings file")?;
    file.write_all(&encrypted)
        .map_err(|_| "Cannot save environment settings")?;
    std::fs::rename(&temp, &target)
        .map_err(|_| "Cannot replace environment settings".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg_attr(not(windows), allow(dead_code))]
    fn entry(name: &str, value: &str, enabled: bool) -> Entry {
        Entry { name: name.into(), value: value.into(), enabled }
    }

    #[test]
    fn nothing_saved_is_an_empty_list() {
        let home = tempfile::tempdir().unwrap();
        assert!(enabled(home.path()).unwrap().is_empty());
    }

    #[test]
    fn an_unreadable_file_is_an_error_not_an_empty_list() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(path(home.path()), b"not protected data").unwrap();
        assert!(enabled(home.path()).is_err());
    }

    /// Issue #63: a value saved now is what the next read returns, and disabled
    /// entries are left out.
    #[cfg(windows)]
    #[test]
    fn the_next_read_sees_what_was_just_saved() {
        let home = tempfile::tempdir().unwrap();
        save(home.path(), &[entry("SHISA_API_KEY", "first", true), entry("OFF", "x", false)]).unwrap();
        assert_eq!(enabled(home.path()).unwrap(), vec![("SHISA_API_KEY".to_string(), "first".to_string())]);
        save(home.path(), &[entry("SHISA_API_KEY", "second", true)]).unwrap();
        assert_eq!(enabled(home.path()).unwrap(), vec![("SHISA_API_KEY".to_string(), "second".to_string())]);
    }
}

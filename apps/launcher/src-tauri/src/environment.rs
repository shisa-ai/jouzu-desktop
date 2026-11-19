use crate::runtime;
use serde::{Deserialize, Serialize};
use std::process::Command;
#[derive(Serialize, Deserialize, Clone)]
pub struct Entry {
    pub name: String,
    pub value: String,
    pub enabled: bool,
}
fn validate(entries: &[Entry]) -> Result<(), String> {
    let mut names = std::collections::HashSet::new();
    for e in entries {
        if e.name.is_empty()
            || e.name.len() > 128
            || !e
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || e.name.as_bytes()[0].is_ascii_digit()
            || e.value.contains('\0')
            || e.value.len() > 32767
        {
            return Err("Invalid environment entry".into());
        }
        let name = e.name.to_ascii_uppercase();
        if ["JOUZU_HOME", "JOUZU_LAUNCHER_BASH", "NODE_OPTIONS", "PATH"].contains(&name.as_str())
            || name.starts_with("JOUZU_LAUNCHER_DEV_")
        {
            return Err("This variable is managed by Jouzu Desktop".into());
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
#[tauri::command]
pub fn environment_read() -> Result<Vec<Entry>, String> {
    let path = runtime::effective_home()?.join("launcher-environment.bin");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot read environment settings".into()),
    };
    let entries: Vec<Entry> = serde_json::from_slice(&protect(&bytes, true)?)
        .map_err(|_| "Invalid environment settings")?;
    validate(&entries)?;
    Ok(entries)
}
#[tauri::command]
pub fn environment_save(entries: Vec<Entry>) -> Result<(), String> {
    validate(&entries)?;
    let data = runtime::effective_home()?;
    std::fs::create_dir_all(&data).map_err(|_| "Cannot create settings directory")?;
    let bytes = serde_json::to_vec(&entries).map_err(|_| "Cannot encode environment settings")?;
    let encrypted = protect(&bytes, false)?;
    let mut file =
        tempfile::NamedTempFile::new_in(&data).map_err(|_| "Cannot prepare settings file")?;
    use std::io::Write;
    file.write_all(&encrypted)
        .map_err(|_| "Cannot save environment settings")?;
    file.persist(data.join("launcher-environment.bin"))
        .map_err(|_| "Cannot replace environment settings")?;
    Ok(())
}
pub fn apply(command: &mut Command) -> Result<(), String> {
    for entry in environment_read()? {
        if entry.enabled {
            command.env(entry.name, entry.value);
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_names_and_duplicates() {
        let entry = |name: &str| Entry {
            name: name.into(),
            value: "test".into(),
            enabled: true,
        };
        assert!(validate(&[entry("EXAMPLE"), entry("example")]).is_err());
        assert!(validate(&[entry("PATH")]).is_err());
        assert!(validate(&[entry("EXAMPLE")]).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn protected_roundtrip() {
        let value = b"fixture-not-a-real-secret";
        let encrypted = protect(value, false).unwrap();
        assert!(!encrypted.windows(value.len()).any(|v| v == value));
        assert_eq!(protect(&encrypted, true).unwrap(), value);
    }
}

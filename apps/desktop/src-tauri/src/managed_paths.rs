//! Where an installation keeps its files. Both binaries resolve this the same way, so the app's
//! console and a terminal entry read the same installation.

use std::path::PathBuf;

pub fn managed_root() -> Result<PathBuf, String> {
    // A development run keeps everything under the directory it names, so nothing it writes can be
    // mistaken for an installed state.
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("JOUZU_DESKTOP_DEV_HOME") {
        return Ok(PathBuf::from(root));
    }
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
        return Ok(PathBuf::from(local).join("Shisa.ai").join("JouzuDesktop"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Shisa.ai")
            .join("JouzuDesktop"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share")))
            .ok_or("HOME is unavailable")?;
        return Ok(base.join("Shisa.ai").join("JouzuDesktop"));
    }
}

/// The home Jouzu runs with: the user's `JOUZU_HOME` when set, otherwise `data` beside this
/// installation (`%LOCALAPPDATA%\Shisa.ai\JouzuDesktop\data` on Windows), the home every
/// Desktop release since 1.0 has used. Desktop's `jz` and `jouzu` commands use it too.
///
/// This location must not change between releases and its contents are never copied to or
/// from another home: the runtime's Flow state records the absolute path of its folder, so
/// a session only continues in the home it was created in (#112).
pub fn effective_home() -> Result<PathBuf, String> {
    if let Some(home) = user_home() {
        return Ok(home);
    }
    Ok(default_home(&managed_root()?))
}

/// The user's `JOUZU_HOME`. A development run ignores it, so it stays inside the directory
/// it names.
fn user_home() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var_os("JOUZU_DESKTOP_DEV_HOME").is_some() {
        return None;
    }
    std::env::var_os("JOUZU_HOME").filter(|value| !value.is_empty()).map(PathBuf::from)
}

fn default_home(managed: &std::path::Path) -> PathBuf {
    managed.join("data")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Existing sessions live here. Moving the default strands them (#112).
    #[test]
    fn the_default_home_is_data_beside_the_installation() {
        let managed = PathBuf::from("C:/Users/u/AppData/Local/Shisa.ai/JouzuDesktop");
        assert_eq!(default_home(&managed), managed.join("data"));
    }

    #[cfg(windows)]
    #[test]
    fn the_installation_is_the_desktop_folder() {
        if std::env::var_os("JOUZU_DESKTOP_DEV_HOME").is_some() {
            return;
        }
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap());
        assert_eq!(managed_root().unwrap(), local.join("Shisa.ai").join("JouzuDesktop"));
    }
}

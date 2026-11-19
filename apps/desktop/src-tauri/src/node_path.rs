use std::path::{Path, PathBuf};

/// Node's entrypoint resolver rejects Windows verbatim paths. Keep canonical
/// paths for containment checks and convert only at the process boundary.
pub fn node_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            let mut output = match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut value = PathBuf::from(r"\\");
                    value.push(server);
                    value.push(share);
                    value
                }
                _ => return path.to_path_buf(),
            };
            for component in components {
                if !matches!(component, Component::RootDir) {
                    output.push(component.as_os_str());
                }
            }
            return output;
        }
    }
    path.to_path_buf()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn converts_only_verbatim_disk_and_unc_prefixes() {
        for (input, expected) in [
            (r"\\?\C:\Users\Test User\app\bootstrap.mjs", r"C:\Users\Test User\app\bootstrap.mjs"),
            (r"\\?\UNC\server\share\app\bootstrap.mjs", r"\\server\share\app\bootstrap.mjs"),
            (r"C:\app\bootstrap.mjs", r"C:\app\bootstrap.mjs"),
        ] {
            assert_eq!(node_path(Path::new(input)), PathBuf::from(expected));
        }
    }
}

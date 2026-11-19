//! Release selection and download planning; no network or installation side effects.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperatingSystem {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Architecture {
    X64,
    Arm64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub os: OperatingSystem,
    pub arch: Architecture,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComponentKind {
    Jouzu,
    Node,
    GitBash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Component {
    pub id: String,
    pub kind: ComponentKind,
    pub version: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    pub entrypoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub schema_version: u32,
    pub id: String,
    pub target: Target,
    pub minimum_launcher_version: String,
    pub components: Vec<Component>,
}

/// Receipt produced only after installed content has been verified. The caller
/// must not populate these from unverified directory names or cached metadata.
#[derive(Debug)]
pub struct VerifiedComponent {
    pub id: String,
    pub sha256: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DownloadPlan {
    pub component_ids: Vec<String>,
    pub bytes: u64,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn safe_entrypoint(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.contains(char::from(92))
        && !value.contains(':')
        && !value.chars().any(char::is_control)
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !part.contains(['<', '>', '"', '|', '?', '*'])
                && !matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
}

impl Release {
    /// Structural checks are NOT signature verification. Network callers must
    /// authenticate exact metadata bytes before trusting this model.
    pub fn validate(&self, target: &Target, launcher_version: &str) -> Result<(), String> {
        if self.schema_version != 1 || !valid_id(&self.id) {
            return Err("Unsupported release schema or invalid release ID".into());
        }
        if &self.target != target {
            return Err("Release does not match execution target".into());
        }
        let minimum = semver::Version::parse(&self.minimum_launcher_version)
            .map_err(|_| "Invalid minimum launcher version")?;
        let current =
            semver::Version::parse(launcher_version).map_err(|_| "Invalid launcher version")?;
        if current < minimum {
            return Err("Update Jouzu Desktop before installing this release".into());
        }
        if self.components.is_empty() || self.components.len() > 3 {
            return Err("Invalid component count".into());
        }
        let mut ids = HashSet::new();
        let mut kinds = HashSet::new();
        for component in &self.components {
            if !valid_id(&component.id) || !ids.insert(&component.id) {
                return Err("Invalid or duplicate component ID".into());
            }
            if !kinds.insert(format!("{:?}", component.kind)) {
                return Err("Duplicate component kind".into());
            }
            if component.version.is_empty() || component.version.len() > 128 {
                return Err("Invalid component version".into());
            }
            if component.bytes == 0 || component.bytes > 8 * 1024 * 1024 * 1024 {
                return Err("Invalid component download size".into());
            }
            if component.sha256.len() != 64
                || !component
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("Invalid component SHA-256".into());
            }
            if !safe_entrypoint(&component.entrypoint) {
                return Err("Unsafe component entrypoint".into());
            }
            let url = url::Url::parse(&component.url).map_err(|_| "Invalid artifact URL")?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err("Artifacts require HTTPS without credentials or fragments".into());
            }
            if component.kind == ComponentKind::Node && url.host_str() != Some("nodejs.org") {
                return Err("Node must come from its official distribution".into());
            }
            if component.kind == ComponentKind::GitBash {
                if self.target.os != OperatingSystem::Windows {
                    return Err("Git for Windows cannot be installed into this target".into());
                }
                if url.host_str() != Some("github.com")
                    || !url
                        .path()
                        .starts_with("/git-for-windows/git/releases/download/")
                {
                    return Err("Git must come from official Git for Windows releases".into());
                }
            }
        }
        if !self
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Jouzu)
            || !self
                .components
                .iter()
                .any(|c| c.kind == ComponentKind::Node)
        {
            return Err("Release must select Jouzu and Node".into());
        }
        Ok(())
    }

    pub fn plan(
        &self,
        target: &Target,
        launcher_version: &str,
        installed: &[VerifiedComponent],
    ) -> Result<DownloadPlan, String> {
        self.validate(target, launcher_version)?;
        let mut plan = DownloadPlan {
            component_ids: vec![],
            bytes: 0,
        };
        for component in &self.components {
            if let Some(existing) = installed.iter().find(|entry| entry.id == component.id) {
                if existing.sha256 != component.sha256 {
                    return Err("Component identity was reused with different content".into());
                }
            } else {
                plan.component_ids.push(component.id.clone());
                plan.bytes = plan
                    .bytes
                    .checked_add(component.bytes)
                    .ok_or("Download size overflow")?;
            }
        }
        Ok(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release() -> Release {
        Release {
            schema_version: 1,
            id: "release-1".into(),
            target: Target {
                os: OperatingSystem::Windows,
                arch: Architecture::X64,
            },
            minimum_launcher_version: "0.1.0".into(),
            components: vec![
                Component {
                    id: "node-a".into(),
                    kind: ComponentKind::Node,
                    version: "24.19.0".into(),
                    url: "https://nodejs.org/dist/v24.19.0/node.zip".into(),
                    bytes: 100,
                    sha256: "a".repeat(64),
                    entrypoint: "node.exe".into(),
                },
                Component {
                    id: "jouzu-b".into(),
                    kind: ComponentKind::Jouzu,
                    version: "0.1.18".into(),
                    url: "https://github.com/shisa-ai/jouzu/releases/download/test/app.zip".into(),
                    bytes: 200,
                    sha256: "b".repeat(64),
                    entrypoint: "app/node_modules/jouzu/dist/cli.js".into(),
                },
            ],
        }
    }
    #[test]
    fn application_update_reuses_node() {
        let r = release();
        let p = r
            .plan(
                &r.target,
                "0.1.0",
                &[VerifiedComponent {
                    id: "node-a".into(),
                    sha256: "a".repeat(64),
                }],
            )
            .unwrap();
        assert_eq!(
            p,
            DownloadPlan {
                component_ids: vec!["jouzu-b".into()],
                bytes: 200
            }
        );
    }
    #[test]
    fn current_install_needs_no_downloads() {
        let r = release();
        let installed = r
            .components
            .iter()
            .map(|c| VerifiedComponent {
                id: c.id.clone(),
                sha256: c.sha256.clone(),
            })
            .collect::<Vec<_>>();
        assert_eq!(r.plan(&r.target, "0.1.0", &installed).unwrap().bytes, 0);
    }
    #[test]
    fn rejects_changed_identity() {
        let r = release();
        assert!(r
            .plan(
                &r.target,
                "0.1.0",
                &[VerifiedComponent {
                    id: "node-a".into(),
                    sha256: "c".repeat(64)
                }]
            )
            .is_err());
    }
    #[test]
    fn rejects_unsafe_entrypoints() {
        for path in [
            "../node",
            "/node",
            "C:/node",
            "a//b",
            "a/./b",
            "node:stream",
            "NUL.txt",
            "a/b.",
            "a/b ",
            "a/*",
        ] {
            let mut r = release();
            r.components[0].entrypoint = path.into();
            assert!(r.validate(&r.target, "0.1.0").is_err(), "{path}");
        }
    }
    #[test]
    fn rejects_wrong_target_and_launcher() {
        let r = release();
        assert!(r
            .validate(
                &Target {
                    os: OperatingSystem::Linux,
                    arch: Architecture::X64
                },
                "0.1.0"
            )
            .is_err());
        assert!(r.validate(&r.target, "0.0.9").is_err());
    }
    #[test]
    fn rejects_bad_urls_hashes_and_duplicates() {
        for url in [
            "http://nodejs.org/node.zip",
            "https://user@nodejs.org/node.zip",
            "https://example.org/node.zip",
            "https://nodejs.org/node.zip#fragment",
        ] {
            let mut r = release();
            r.components[0].url = url.into();
            assert!(r.validate(&r.target, "0.1.0").is_err());
        }
        let mut r = release();
        r.components[0].sha256 = "wrong".into();
        assert!(r.validate(&r.target, "0.1.0").is_err());
        let mut r = release();
        r.components.push(r.components[0].clone());
        assert!(r.validate(&r.target, "0.1.0").is_err());
    }
    #[test]
    fn git_uses_official_origin_and_is_reused() {
        let mut r = release();
        r.components.push(Component {
            id: "git-a".into(),
            kind: ComponentKind::GitBash,
            version: "2.55.0.5".into(),
            url: "https://github.com/git-for-windows/git/releases/download/test/git.exe".into(),
            bytes: 300,
            sha256: "c".repeat(64),
            entrypoint: "bin/bash.exe".into(),
        });
        let installed = vec![
            VerifiedComponent {
                id: "node-a".into(),
                sha256: "a".repeat(64),
            },
            VerifiedComponent {
                id: "git-a".into(),
                sha256: "c".repeat(64),
            },
        ];
        assert_eq!(
            r.plan(&r.target, "0.1.0", &installed)
                .unwrap()
                .component_ids,
            vec!["jouzu-b"]
        );
        r.components[2].url =
            "https://github.com/another/publisher/releases/download/git.exe".into();
        assert!(r.validate(&r.target, "0.1.0").is_err());
    }
    #[test]
    fn rejects_unknown_json_fields() {
        let mut value = serde_json::to_value(release()).unwrap();
        value["script"] = "execute".into();
        assert!(serde_json::from_value::<Release>(value).is_err());
    }
}

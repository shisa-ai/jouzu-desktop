//! Runtime version policy. The allowlist is internal data; it is not a new UI.

pub const MINIMUM_VERSION: &str = "0.2.5";
pub const VERIFIED_VERSIONS: &[&str] = &["0.2.5"];

pub fn is_verified(version: &str) -> bool {
    VERIFIED_VERSIONS.contains(&version)
}

pub fn is_mandatory(installed: &str) -> bool {
    let verified = is_verified(installed);
    let Ok(installed) = semver::Version::parse(installed) else {
        return true;
    };
    let Ok(minimum) = semver::Version::parse(MINIMUM_VERSION) else {
        return true;
    };
    installed < minimum || !verified
}

pub fn is_current(installed: &str) -> bool {
    installed == MINIMUM_VERSION && is_verified(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_the_floor_is_mandatory() {
        assert!(is_mandatory("0.2.4"));
        assert!(is_mandatory("not-a-version"));
    }

    #[test]
    fn unlisted_versions_are_never_current() {
        assert!(is_mandatory("0.2.6"));
        assert!(!is_current("0.2.6"));
        assert!(is_verified("0.2.5"));
        assert!(is_current("0.2.5"));
    }
}

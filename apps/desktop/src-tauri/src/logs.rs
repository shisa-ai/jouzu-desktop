use std::{
    fs::{create_dir_all, metadata, rename, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// A log file rotates once it reaches this size, so diagnostics cannot grow without bound.
const MAX_BYTES: u64 = 1024 * 1024;

/// The most a single note may carry, so one caller cannot fill the log with one message.
const MAX_NOTE: usize = 300;

/// Logs live beside the managed state: one root holds everything an installation writes, and the
/// uninstaller removes it with the rest.
pub fn directory(managed: &Path) -> PathBuf {
    managed.join("logs")
}

/// Append one timestamped line. Diagnostics never fail the operation they describe, so every error
/// here is dropped rather than returned.
pub fn append(managed: &Path, file: &str, message: &str) {
    let directory = directory(managed);
    if create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join(file);
    if metadata(&path).map(|size| size.len() >= MAX_BYTES).unwrap_or(false) {
        let _ = rename(&path, directory.join(format!("{file}.1")));
    }
    if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(handle, "{} {message}", timestamp());
    }
}

/// A note from a caller outside Rust, such as the interface watching the app's own update. A
/// note stays one line: control characters are dropped and its length is bounded, so a caller cannot
/// forge the lines around it.
pub fn note(managed: &Path, message: &str) {
    let line: String = message
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_NOTE)
        .collect();
    if !line.trim().is_empty() {
        append(managed, "desktop.log", &line);
    }
}

/// ISO 8601 in UTC, so a line can be read without a tool that knows an epoch, and without a time
/// library the release does not otherwise need.
fn timestamp() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => iso8601(elapsed.as_secs() as i64),
        Err(_) => "1970-01-01T00:00:00Z".to_string(),
    }
}

fn iso8601(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// The inverse of days-from-civil, so a date comes out of a count of days.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_part + 2) / 5 + 1) as u32;
    let month = if month_part < 10 { month_part + 3 } else { month_part - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}


/// Crash records are kept next to the logs and pruned to this many files, so a repeated failure cannot
/// fill the disk.
const MAX_CRASHES: usize = 5;

/// A panic otherwise closes the window with nothing on disk. The record is one JSON line so a report
/// can carry it once the user reviews it.
pub fn write_crash(managed: &Path, message: &str, location: &str, version: &str) -> Option<PathBuf> {
    let directory = directory(managed);
    create_dir_all(&directory).ok()?;
    let stamp = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_secs(),
        Err(_) => 0,
    };
    let path = directory.join(format!("crash-{stamp}.json"));
    let record = serde_json::json!({
        "time": stamp,
        "version": version,
        "location": location,
        "message": message,
    });
    let mut handle = OpenOptions::new().create(true).truncate(true).write(true).open(&path).ok()?;
    writeln!(handle, "{record}").ok()?;
    prune_crashes(&directory, MAX_CRASHES);
    Some(path)
}

/// Remove the oldest records beyond `keep`, newest first by the stamp in the file name.
fn prune_crashes(directory: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut records: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let stamp = name.strip_prefix("crash-")?.strip_suffix(".json")?.parse::<u64>().ok()?;
            Some((stamp, path))
        })
        .collect();
    records.sort_by_key(|(stamp, _)| *stamp);
    while records.len() > keep {
        let (_, path) = records.remove(0);
        let _ = std::fs::remove_file(path);
    }
}

/// Install the record keeper. The previous hook still runs, so the default panic output survives.
pub fn install_panic_hook(managed: PathBuf, version: &'static str) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|place| format!("{}:{}", place.file(), place.line()))
            .unwrap_or_default();
        write_crash(&managed, &info.to_string(), &location, version);
        previous(info);
    }));
}


/// The crash records, newest first, each with the path a caller passes back to dismiss it.
pub fn crash_records(managed: &Path) -> Vec<serde_json::Value> {
    let directory = directory(managed);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return Vec::new();
    };
    let mut records: Vec<serde_json::Value> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let stamp = name.strip_prefix("crash-")?.strip_suffix(".json")?.parse::<u64>().ok()?;
            let mut record: serde_json::Value =
                serde_json::from_str(std::fs::read_to_string(&path).ok()?.trim()).ok()?;
            if let Some(object) = record.as_object_mut() {
                object.insert("path".into(), serde_json::json!(path.to_string_lossy()));
                object.insert("stamp".into(), serde_json::json!(stamp));
            }
            Some(record)
        })
        .collect();
    records.sort_by_key(|record| std::cmp::Reverse(record["stamp"].as_u64().unwrap_or(0)));
    records
}

/// Delete one record. Only a file inside the log directory can be removed, so a caller cannot name an
/// arbitrary path.
pub fn dismiss_crash(managed: &Path, path: &str) -> Result<(), String> {
    let directory = directory(managed);
    let candidate = Path::new(path);
    if candidate.parent() != Some(directory.as_path()) {
        return Err("Not a crash record".into());
    }
    std::fs::remove_file(candidate).map_err(|_| "The crash record is already gone".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_without_a_time_library() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso8601(1_767_000_000), "2025-12-29T09:20:00Z");
        assert_eq!(iso8601(1_757_971_300), "2025-09-15T21:21:40Z");
        assert_eq!(iso8601(1_759_713_000), "2025-10-06T01:10:00Z");
    }

    #[test]
    fn appends_a_line_per_call_and_rotates_at_the_cap() {
        let temp = tempfile::tempdir().unwrap();
        let managed = temp.path();
        append(managed, "desktop.log", "first");
        append(managed, "desktop.log", "second");
        let text = std::fs::read_to_string(directory(managed).join("desktop.log")).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().last().unwrap().ends_with(" second"));

        std::fs::write(
            directory(managed).join("desktop.log"),
            "x".repeat(MAX_BYTES as usize),
        )
        .unwrap();
        append(managed, "desktop.log", "after rotation");
        assert_eq!(
            std::fs::metadata(directory(managed).join("desktop.log.1"))
                .unwrap()
                .len(),
            MAX_BYTES
        );
        let current = std::fs::read_to_string(directory(managed).join("desktop.log")).unwrap();
        assert!(current.ends_with(" after rotation\n"));
        assert!(current.len() < 64);
    }

    #[test]
    fn keeps_a_note_on_one_line_and_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let managed = temp.path();
        note(managed, "first\nsecond\tthird");
        note(managed, "   ");
        note(managed, &"x".repeat(2_000));
        let text = std::fs::read_to_string(directory(managed).join("desktop.log")).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().next().unwrap().ends_with(" firstsecondthird"));
        let bounded = text.lines().nth(1).unwrap();
        assert!(bounded.ends_with(&"x".repeat(MAX_NOTE)));
        assert!(bounded.len() <= 20 + 1 + MAX_NOTE);
    }

    #[test]
    fn keeps_the_newest_crash_records_and_writes_one_json_line() {
        let temp = tempfile::tempdir().unwrap();
        let managed = temp.path();
        let path = write_crash(managed, "boom", "src/main.rs:1", "0.0.0").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 1);
        let record: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(record["message"], "boom");
        assert_eq!(record["location"], "src/main.rs:1");

        for stamp in 1..=8u64 {
            std::fs::write(directory(managed).join(format!("crash-{stamp}.json")), "{}").unwrap();
        }
        prune_crashes(&directory(managed), MAX_CRASHES);
        let kept = std::fs::read_dir(directory(managed))
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("crash-"))
            .count();
        assert_eq!(kept, MAX_CRASHES);
        assert!(!directory(managed).join("crash-1.json").exists());
    }

    #[test]
    fn lists_records_newest_first_and_refuses_a_path_outside_the_logs() {
        let temp = tempfile::tempdir().unwrap();
        let managed = temp.path();
        write_crash(managed, "older", "src/a.rs:1", "0.0.0").unwrap();
        std::fs::write(directory(managed).join("crash-1900000000.json"), "{}").unwrap();
        let records = crash_records(managed);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["stamp"], 1_900_000_000u64);
        let outside = temp.path().join("elsewhere.json");
        std::fs::write(&outside, "{}").unwrap();
        assert!(dismiss_crash(managed, outside.to_str().unwrap()).is_err());
        assert!(outside.exists());
        dismiss_crash(managed, records[0]["path"].as_str().unwrap()).unwrap();
        assert_eq!(crash_records(managed).len(), 1);
    }
}

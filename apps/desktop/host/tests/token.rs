//! #130: the host's API token never lands in a file.
//!
//! The agent's tools run as the same user as the host and can read any file in
//! the host home. The token goes only to the process that started the host, on
//! its first stdout line; `host.json` keeps what is needed to find the host.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::Path,
    process::{Command, Stdio},
};

fn files_under(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_under(&path, out);
        } else {
            out.push(path);
        }
    }
}

fn get(port: u16, path: &str, token: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    answer
}

#[test]
fn the_token_is_handed_to_the_starter_and_written_nowhere() {
    let scratch = tempfile::tempdir().unwrap();
    let home = scratch.path().join("home");
    let dist = scratch.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
    let mut host = Command::new(env!("CARGO_BIN_EXE_jouzu-host"))
        .arg("--dist").arg(&dist)
        .arg("--home").arg(&home)
        .arg("--runtime-home").arg(scratch.path().join("runtime"))
        .arg("--runtime").arg("node")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(host.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&line).expect("the first stdout line is the ready record");
    let port = ready["port"].as_u64().unwrap() as u16;
    let token = ready["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64);

    let info: serde_json::Value = serde_json::from_slice(&std::fs::read(home.join("host.json")).unwrap()).unwrap();
    assert_eq!(info["port"].as_u64(), Some(port as u64));
    assert!(info.get("token").is_none(), "host.json names no token: {info}");
    let mut files = Vec::new();
    files_under(&home, &mut files);
    for file in files {
        let bytes = std::fs::read(&file).unwrap_or_default();
        assert!(!String::from_utf8_lossy(&bytes).contains(&token), "{} holds the token", file.display());
    }

    assert!(get(port, "/v1/health", &token).starts_with("HTTP/1.1 200"));
    assert!(get(port, "/v1/sessions", "not-the-token").starts_with("HTTP/1.1 401"));
    let _ = host.kill();
    let _ = host.wait();
}

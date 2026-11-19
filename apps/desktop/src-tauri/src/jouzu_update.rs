use std::{io::{BufRead,BufReader,Write},process::{Command,Stdio},sync::atomic::{AtomicBool,Ordering}};
use tauri::Emitter;
static ACTIVE: AtomicBool = AtomicBool::new(false);
struct Guard;
impl Drop for Guard {fn drop(&mut self){ACTIVE.store(false,Ordering::SeqCst);}}

#[tauri::command]
pub async fn jouzu_update(app: tauri::AppHandle, action: String, version: Option<String>) -> Result<serde_json::Value,String> {
 if action != "check" && action != "install" {return Err("Invalid update action".into());}
 if ACTIVE.swap(true,Ordering::SeqCst){return Err("A Jouzu update is already running".into());}
 let guard=Guard;
 if action=="install" {
  // The running desktop runtime holds the shared update-session lock. Stop it
  // before taking the exclusive installer lock; the frontend reconnects after install.
  crate::host_bootstrap::stop_sessions()?;
 }
 tauri::async_runtime::spawn_blocking(move || {
  let _guard=guard;
  let root=crate::runtime::application_root(&app)?;
  let managed=crate::runtime::managed_root()?;
  let _lease=crate::update_lock::lock(&managed, action=="install")?;
  let current_app=crate::active_app::resolve_app(&root,&managed)?;
  let package:serde_json::Value=serde_json::from_slice(&std::fs::read(current_app.join("node_modules/jouzu/package.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
  let current=semver::Version::parse(package["version"].as_str().ok_or("Missing current version")?).map_err(|e|e.to_string())?;
  if action=="install" {
   let target_text=version.as_deref().ok_or("Missing update version")?;
   if !crate::runtime_policy::is_verified(target_text) {
    return Err("This Jouzu version is not in the verified runtime list".into());
   }
   let target=semver::Version::parse(target_text).map_err(|e|e.to_string())?;
   if target<=current{return Err("Update must be newer than the active version".into());}
  }
  let mut command=Command::new(crate::runtime_install::node_executable(&root));
  command.arg(root.join("runtime/desktop-tools/update-service.mjs")).arg(&root).arg(&managed).arg(&action).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  // The staged health check uses os.tmpdir(). A desktop child can inherit a TEMP
  // directory it cannot create under; keep the check inside the managed update root.
  let updater_temp=managed.join("updates").join("tmp");
  std::fs::create_dir_all(&updater_temp).map_err(|e|e.to_string())?;
  command.env("TEMP",&updater_temp).env("TMP",&updater_temp).env("TMPDIR",&updater_temp);
  command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
  #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
  let mut child=command.spawn().map_err(|_|"Cannot start Jouzu updater")?;
  child.stdin.take().ok_or("Updater input unavailable")?.write_all(serde_json::json!({"version":version}).to_string().as_bytes()).map_err(|_|"Cannot send update request")?;
  let stderr=child.stderr.take().ok_or("Updater events unavailable")?;
  let events=app.clone();
  let reader=std::thread::spawn(move||{for line in BufReader::new(stderr).lines().map_while(Result::ok){if let Ok(value)=serde_json::from_str::<serde_json::Value>(&line){let _=events.emit("jouzu-update-progress",value);}}});
  let output=child.wait_with_output().map_err(|_|"Cannot read updater result")?;
  let _=reader.join();
  let mut value:serde_json::Value=serde_json::from_slice(&output.stdout).map_err(|_|"Invalid updater response")?;
  if !output.status.success(){return Err(value["error"].as_str().unwrap_or("Jouzu update failed").to_string());}
  let candidate_text=value["version"].as_str().ok_or("Missing candidate version")?;
  let candidate=semver::Version::parse(candidate_text).map_err(|_|"Invalid candidate version")?;
  value["available"]=serde_json::json!(candidate>current && crate::runtime_policy::is_verified(candidate_text));
  Ok(value)
 }).await.map_err(|e|e.to_string())?
}



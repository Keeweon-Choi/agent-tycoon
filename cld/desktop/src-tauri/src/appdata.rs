//! The bundle identifier changed from `dev.cldgui.pixeloffice` to `dev.agenttycoon.app` (11-01).
//! Tauri names the app data folders after it (config, this device's SSH keys, logs, and the
//! webview profile with the office's localStorage and IndexedDB device key), so the first launch
//! of the new app copies the old folders to the new names before anything else touches them.
//! Standard library only: `rustc --test` runs the tests without Tauri.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The identifier the app data folders had before 11-01.
pub const OLD_ID: &str = "dev.cldgui.pixeloffice";

/// Copies the folder `old` to `new` when `new` does not exist yet: into `<new>.moving` first,
/// checked file by file, then renamed into place, so a crash leaves no half folder under the
/// new name and the next launch starts over. Returns whether it copied.
/// ponytail: `old` stays as a fallback; delete the old folders in a later release.
pub fn carry_over(old: &Path, new: &Path) -> io::Result<bool> {
    if new.exists() || !old.is_dir() {
        return Ok(false);
    }
    let moving = PathBuf::from(format!("{}.moving", new.display()));
    if moving.exists() {
        fs::remove_dir_all(&moving)?; // a copy cut short last time
    }
    if let Err(e) = copy_tree(old, &moving).and_then(|()| same_tree(old, &moving)) {
        let _ = fs::remove_dir_all(&moving);
        return Err(e);
    }
    fs::rename(&moving, new)?;
    Ok(true)
}

/// Folders and plain files only; links are left out (a webview profile has none).
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Every folder and file of `from` is in `to` with the same size.
fn same_tree(from: &Path, to: &Path) -> io::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            same_tree(&entry.path(), &target)?;
        } else if kind.is_file() && fs::metadata(&target)?.len() != entry.metadata()?.len() {
            return Err(io::Error::other(format!(
                "복사본 크기가 다릅니다: {}",
                target.display()
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("appdata-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn old_folder(root: &Path) -> PathBuf {
        let old = root.join(OLD_ID);
        fs::create_dir_all(old.join("ssh")).unwrap();
        fs::write(old.join("config.json"), "{\"mode\":\"ssh\"}").unwrap();
        fs::write(old.join("ssh").join("id_ed25519"), "key").unwrap();
        old
    }

    #[test]
    fn fresh_copies_and_keeps_the_old_folder() {
        let root = temp("fresh");
        let (old, new) = (old_folder(&root), root.join("dev.agenttycoon.app"));
        assert!(carry_over(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("ssh").join("id_ed25519")).unwrap(), "key");
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "{\"mode\":\"ssh\"}");
        assert!(old.join("ssh").join("id_ed25519").is_file());
        assert!(!root.join("dev.agenttycoon.app.moving").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn already_moved_touches_nothing() {
        let root = temp("moved");
        let (old, new) = (old_folder(&root), root.join("dev.agenttycoon.app"));
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("config.json"), "newer").unwrap();
        assert!(!carry_over(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "newer");
        assert!(!new.join("ssh").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn half_moved_starts_over() {
        let root = temp("half");
        let (old, new) = (old_folder(&root), root.join("dev.agenttycoon.app"));
        let moving = root.join("dev.agenttycoon.app.moving");
        fs::create_dir_all(moving.join("ssh")).unwrap();
        fs::write(moving.join("ssh").join("id_ed25519"), "k").unwrap(); // cut short
        fs::write(moving.join("stale"), "x").unwrap();
        assert!(carry_over(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("ssh").join("id_ed25519")).unwrap(), "key");
        assert!(!new.join("stale").exists());
        assert!(!moving.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_old_folder_does_nothing() {
        let root = temp("none");
        let new = root.join("dev.agenttycoon.app");
        assert!(!carry_over(&root.join(OLD_ID), &new).unwrap());
        assert!(!new.exists());
        fs::remove_dir_all(root).unwrap();
    }
}

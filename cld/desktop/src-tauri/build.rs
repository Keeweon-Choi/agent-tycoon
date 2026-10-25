use std::fs;
use std::path::{Path, PathBuf};

/// Where the daemon bundles come from (H §3.2): `<dir>/<target>/` each holding one
/// `agent-tycoon-daemon-*-<target>.tar.gz` with the SHA256SUMS, SHA256SUMS.sig and
/// agent-tycoon-release.pub that sign it (cld/release/bundle/build.mjs output).
const BUNDLES_ENV: &str = "AGENT_TYCOON_BUNDLES";
/// Default, relative to the repo root: the git-ignored `out/bundles/` (`build.mjs --out out/bundles/<target>`).
const BUNDLES_DEFAULT: &str = "out/bundles";
const SIGNED: [&str; 3] = ["SHA256SUMS", "SHA256SUMS.sig", "agent-tycoon-release.pub"];

/// The bundles an installer for this target carries: Windows both its own and WSL's (Linux x64).
fn targets() -> Vec<&'static str> {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    match (
        var("CARGO_CFG_TARGET_OS").as_str(),
        var("CARGO_CFG_TARGET_ARCH").as_str(),
    ) {
        ("windows", _) => vec!["win-x64", "linux-x64"],
        ("linux", "x86_64") => vec!["linux-x64"],
        ("linux", "aarch64") => vec!["linux-arm64"],
        ("macos", "aarch64") => vec!["darwin-arm64"],
        ("macos", "x86_64") => vec!["darwin-x64"],
        _ => vec![],
    }
}

/// The bundle's SHA-256 as its SHA256SUMS lists it, checked against the file itself.
fn listed_sha256(dir: &Path, name: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let sums =
        fs::read_to_string(dir.join("SHA256SUMS")).map_err(|e| format!("SHA256SUMS: {e}"))?;
    let listed = sums
        .lines()
        .find_map(|l| l.strip_suffix(name)?.strip_suffix("  "))
        .ok_or_else(|| format!("{name} is not in SHA256SUMS"))?;
    let bytes = fs::read(dir.join(name)).map_err(|e| format!("{name}: {e}"))?;
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if actual == listed {
        Ok(actual)
    } else {
        Err(format!("{name} does not match its SHA256SUMS line"))
    }
}

/// Copies only the bundle and its signed list into `daemon/<target>/` (tauri.conf.json resources),
/// never the rest of a build folder (dev-key/, downloads/, stage/). Returns what is missing.
/// Each bundle's SHA-256 goes into the binary (`AGENT_TYCOON_BUNDLE_PINS`, `target=sha256,…`):
/// the app checks the bundle against it before anything is unpacked.
fn stage_daemons(out: &Path) -> Vec<String> {
    println!("cargo:rerun-if-env-changed={BUNDLES_ENV}");
    let source = std::env::var(BUNDLES_ENV).map_or_else(
        |_| {
            let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
            manifest.join("../../..").join(BUNDLES_DEFAULT) // cld/desktop/src-tauri -> repo root
        },
        PathBuf::from,
    );
    let _ = fs::remove_dir_all(out);
    let mut missing = Vec::new();
    let mut pins = Vec::new();
    for target in targets() {
        let dir = source.join(target);
        for name in SIGNED {
            println!("cargo:rerun-if-changed={}", dir.join(name).display());
        }
        let tail = format!("-{target}.tar.gz");
        let bundles: Vec<String> = fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok()?.file_name().into_string().ok())
                    .filter(|n| n.starts_with("agent-tycoon-daemon-") && n.ends_with(&tail))
                    .collect()
            })
            .unwrap_or_default();
        let mut files: Vec<String> = SIGNED.iter().map(|s| s.to_string()).collect();
        match bundles.as_slice() {
            [one] => {
                println!("cargo:rerun-if-changed={}", dir.join(one).display());
                match listed_sha256(&dir, one) {
                    Ok(sha) => pins.push(format!("{target}={sha}")),
                    Err(e) => missing.push(format!("{}: {e}", dir.display())),
                }
                files.push(one.clone())
            }
            [] => missing.push(format!("{}: no agent-tycoon-daemon-*{tail}", dir.display())),
            _ => missing.push(format!(
                "{}: more than one daemon bundle ({})",
                dir.display(),
                bundles.join(", ")
            )),
        }
        let into = out.join(target);
        let _ = fs::create_dir_all(&into);
        for name in files {
            if fs::copy(dir.join(&name), into.join(&name)).is_err() {
                missing.push(dir.join(&name).display().to_string());
            }
        }
    }
    println!(
        "cargo:rustc-env=AGENT_TYCOON_BUNDLE_PINS={}",
        pins.join(",")
    );
    missing
}

fn main() {
    let out = Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("daemon");
    let missing = stage_daemons(&out);
    if !missing.is_empty() {
        let text = format!(
            "daemon bundles missing for this installer (set {BUNDLES_ENV}=<dir with <target>/ folders>, default <repo>/{BUNDLES_DEFAULT}):\n  {}",
            missing.join("\n  ")
        );
        // A release installer without its bundles cannot install anything: stop. Checks and dev builds go on.
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            panic!("{text}");
        }
        println!("cargo:warning={}", text.replace('\n', " |"));
    }
    // Listing the commands puts them under the ACL: a page may call only what a
    // capability in capabilities/ grants it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "ui_state",
            "save_config",
            "reconnect",
            "open_settings",
            "toggle_fullscreen",
            "toggle_on_top",
            "open_external",
            "ssh_password",
            "accept_host_key",
            "device_key",
            "register_again",
            "forget_key",
            "start_here",
            "local_options",
            "local_choose",
            "choose_local",
            "local_install",
            "local_start",
        ]),
    ))
    .expect("failed to run tauri-build");
}

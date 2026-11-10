//! DESKTOP-ACTIONS (11-03): every download of the window goes to the user's Downloads folder,
//! under a name that is safe on Windows and does not overwrite a file already there.
//! Standard library only: `rustc --test` runs the tests without Tauri.

use std::path::{Path, PathBuf};

/// Longest name kept (in chars, the extension included): well under Windows' 255.
const NAME_MAX: usize = 150;
const FALLBACK: &str = "download";
/// How many `name (n).ext` are tried before the download is refused.
const NUMBERED_MAX: u32 = 9_999;

/// The last path component of `suggested` with characters Windows refuses replaced, trailing dots
/// and spaces dropped, a reserved device name (CON, NUL, COM1, …) prefixed, and the length capped.
pub fn safe_name(suggested: &str) -> String {
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    name = name.trim_end_matches(['.', ' ']).trim_start().to_string();
    if name.chars().count() > NAME_MAX {
        let (stem, ext) = split(&name);
        let keep = NAME_MAX.saturating_sub(ext.chars().count());
        name = stem.chars().take(keep).collect::<String>() + ext;
    }
    if name.is_empty() || name.chars().all(|c| c == '.') {
        return FALLBACK.into();
    }
    // Windows ignores spaces before the extension when it matches a device name ("CON .txt").
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let numbered = |prefix: &str| {
        stem.strip_prefix(prefix).is_some_and(|rest| {
            let mut digits = rest.chars();
            matches!(
                (digits.next(), digits.next()),
                (Some('0'..='9' | '¹' | '²' | '³'), None)
            )
        })
    };
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || numbered("COM")
        || numbered("LPT");
    if reserved {
        name.insert(0, '_');
    }
    name
}

/// `name` and its extension (with the dot); a leading dot is part of the name (".env").
fn split(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    }
}

/// `dir/name`, or `dir/stem (n).ext` with the first n that is free; None when all are taken
/// (the caller cancels the download rather than write over a file).
/// ponytail: checked, not reserved, so two downloads of one name in the same instant may race;
/// WebView2 then writes the second over the first.
pub fn unique(dir: &Path, name: &str) -> Option<PathBuf> {
    unique_within(dir, name, NUMBERED_MAX)
}

fn unique_within(dir: &Path, name: &str, max: u32) -> Option<PathBuf> {
    let first = dir.join(name);
    if !first.exists() {
        return Some(first);
    }
    let (stem, ext) = split(name);
    (1..=max)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|path| !path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn keeps_a_plain_name() {
        assert_eq!(safe_name("report.pdf"), "report.pdf");
        assert_eq!(safe_name("사진 1.png"), "사진 1.png");
        assert_eq!(safe_name(".env"), ".env");
    }

    #[test]
    fn drops_folders_and_windows_refused_characters() {
        assert_eq!(safe_name("C:\\Users\\x\\..\\evil.exe"), "evil.exe");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("a<b>c:d\"e|f?g*h.txt"), "a_b_c_d_e_f_g_h.txt");
        assert_eq!(safe_name("tab\there\n.txt"), "tab_here_.txt");
        assert_eq!(safe_name("name. . "), "name");
        assert_eq!(safe_name(".."), FALLBACK);
        assert_eq!(safe_name(""), FALLBACK);
        assert_eq!(safe_name("dir/"), FALLBACK);
    }

    #[test]
    fn prefixes_device_names() {
        assert_eq!(safe_name("con"), "_con");
        assert_eq!(safe_name("NUL.txt"), "_NUL.txt");
        assert_eq!(safe_name("com1.log"), "_com1.log");
        assert_eq!(safe_name("lpt9"), "_lpt9");
        assert_eq!(safe_name("console.txt"), "console.txt");
        assert_eq!(safe_name("comx.txt"), "comx.txt");
        assert_eq!(safe_name("CONIN$"), "_CONIN$");
        assert_eq!(safe_name("conout$.log"), "_conout$.log");
        assert_eq!(safe_name("COM¹.txt"), "_COM¹.txt");
        assert_eq!(safe_name("lpt³"), "_lpt³");
        assert_eq!(safe_name("com0"), "_com0");
        assert_eq!(safe_name("CON .txt"), "_CON .txt");
        assert_eq!(safe_name("com10.txt"), "com10.txt");
        assert_eq!(safe_name("com¹²"), "com¹²");
        assert_eq!(safe_name("conin.txt"), "conin.txt");
    }

    #[test]
    fn caps_the_length_and_keeps_the_extension() {
        let long = format!("{}.png", "가".repeat(400));
        let safe = safe_name(&long);
        assert_eq!(safe.chars().count(), NAME_MAX);
        assert!(safe.ends_with(".png"));
    }

    #[test]
    fn never_overwrites_a_file_already_there() {
        let dir = std::env::temp_dir().join(format!("dl-unique-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique(&dir, "a.txt"), Some(dir.join("a.txt")));
        fs::write(dir.join("a.txt"), "1").unwrap();
        assert_eq!(unique(&dir, "a.txt"), Some(dir.join("a (1).txt")));
        fs::write(dir.join("a (1).txt"), "2").unwrap();
        assert_eq!(unique(&dir, "a.txt"), Some(dir.join("a (2).txt")));
        fs::write(dir.join("noext"), "3").unwrap();
        assert_eq!(unique(&dir, "noext"), Some(dir.join("noext (1)")));
        // Every numbered name taken: refused, never the first name again.
        assert_eq!(unique_within(&dir, "a.txt", 2), Some(dir.join("a (2).txt")));
        fs::write(dir.join("a (2).txt"), "4").unwrap();
        assert_eq!(unique_within(&dir, "a.txt", 2), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}

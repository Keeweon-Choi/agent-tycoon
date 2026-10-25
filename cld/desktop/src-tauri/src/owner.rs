//! Who holds the listening socket on a local port: the check behind "the login code goes
//! only to the ssh this app started". Pids of every listener on the port, any address, so a
//! second listener beside ours counts against us. None means "could not tell", which the
//! caller treats as a refusal (`connect::judge`).

/// Pids with a listening TCP socket on `port`.
pub fn listener_pids(port: u16) -> Option<Vec<u32>> {
    imp::listener_pids(port)
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_LISTENER,
    };

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;

    pub fn listener_pids(port: u16) -> Option<Vec<u32>> {
        let mut pids = Vec::new();
        for family in [AF_INET, AF_INET6] {
            let mut size = 0u32;
            // u64 words keep the buffer 8-byte aligned for the table structs.
            let mut buf: Vec<u64> = Vec::new();
            let mut rc = ERROR_INSUFFICIENT_BUFFER;
            // The table can grow between the size query and the read: a few tries.
            for _ in 0..4 {
                if rc != ERROR_INSUFFICIENT_BUFFER {
                    break;
                }
                let ptr = if buf.is_empty() {
                    std::ptr::null_mut()
                } else {
                    buf.as_mut_ptr().cast()
                };
                // SAFETY: `ptr` is null or a buffer of at least `size` bytes; `size` is in/out.
                rc = unsafe {
                    GetExtendedTcpTable(ptr, &mut size, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
                };
                if rc == ERROR_INSUFFICIENT_BUFFER {
                    buf = vec![0u64; (size as usize).div_ceil(8)];
                }
            }
            if rc != 0 || buf.is_empty() {
                return None;
            }
            // SAFETY: on success the buffer holds dwNumEntries rows right after the count.
            unsafe {
                if family == AF_INET {
                    let table = buf.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
                    let rows = std::slice::from_raw_parts(
                        (*table).table.as_ptr(),
                        (*table).dwNumEntries as usize,
                    );
                    for row in rows {
                        // The port sits in the low 16 bits, network byte order.
                        if u16::from_be(row.dwLocalPort as u16) == port {
                            pids.push(row.dwOwningPid);
                        }
                    }
                } else {
                    let table = buf.as_ptr().cast::<MIB_TCP6TABLE_OWNER_PID>();
                    let rows = std::slice::from_raw_parts(
                        (*table).table.as_ptr(),
                        (*table).dwNumEntries as usize,
                    );
                    for row in rows {
                        if u16::from_be(row.dwLocalPort as u16) == port {
                            pids.push(row.dwOwningPid);
                        }
                    }
                }
            }
        }
        Some(pids)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::fs;

    /// Inodes of the LISTEN sockets on `port` in a /proc/net/tcp or tcp6 table.
    pub fn listening_inodes(table: &str, port: u16) -> Vec<u64> {
        table
            .lines()
            .skip(1)
            .filter_map(|line| {
                let f: Vec<&str> = line.split_whitespace().collect();
                let local_port = u16::from_str_radix(f.get(1)?.rsplit(':').next()?, 16).ok()?;
                (f.get(3) == Some(&"0A") && local_port == port).then(|| f.get(9)?.parse().ok())?
            })
            .collect()
    }

    pub fn listener_pids(port: u16) -> Option<Vec<u32>> {
        let mut inodes = Vec::new();
        let mut read_any = false;
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(text) = fs::read_to_string(table) {
                read_any = true;
                inodes.extend(listening_inodes(&text, port));
            }
        }
        if !read_any {
            return None;
        }
        let mut pids = Vec::new();
        let mut found = vec![false; inodes.len()];
        for entry in fs::read_dir("/proc").ok()?.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<u32>().ok())
            else {
                continue;
            };
            // Other users' processes are unreadable: their sockets stay unfound -> unknown.
            let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(link) = fs::read_link(fd.path()) else {
                    continue;
                };
                let link = link.to_string_lossy();
                let inode = link
                    .strip_prefix("socket:[")
                    .and_then(|s| s.strip_suffix(']'));
                if let Some(i) = inode.and_then(|s| s.parse::<u64>().ok()) {
                    if let Some(at) = inodes.iter().position(|&x| x == i) {
                        found[at] = true;
                        if !pids.contains(&pid) {
                            pids.push(pid);
                        }
                    }
                }
            }
        }
        // A listener whose owner we could not see might be anyone's.
        found.iter().all(|&f| f).then_some(pids)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const TABLE: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:47A8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000 100 0 0 10 0\n\
   1: 00000000:47A8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000 100 0 0 10 0\n\
   2: 0100007F:47A8 0100007F:9999 01 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000 100 0 0 10 0\n\
   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000 100 0 0 10 0\n";

        #[test]
        fn listeners_on_a_port() {
            // 0x47A8 = 18344: both LISTEN rows, not the established one, not port 8080
            assert_eq!(listening_inodes(TABLE, 18344), vec![11111, 22222]);
            assert_eq!(listening_inodes(TABLE, 8080), vec![44444]);
            assert!(listening_inodes(TABLE, 1).is_empty());
            assert!(listening_inodes("garbage\nx y z", 1).is_empty());
        }

        /// Real sockets, no network: a listener of this process is found with our pid.
        #[test]
        fn own_listener_is_found() {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = l.local_addr().unwrap().port();
            assert_eq!(listener_pids(port), Some(vec![std::process::id()]));
            drop(l);
            assert_eq!(listener_pids(port), Some(vec![]));
        }
    }
}

// Any other platform: owner lookup is not implemented, so the answer is "unknown" and the
// caller refuses to send. Safe default; add a lookup before enabling ssh mode there.
#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    pub fn listener_pids(_port: u16) -> Option<Vec<u32>> {
        None
    }
}

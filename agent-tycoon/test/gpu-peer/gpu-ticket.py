#!/usr/bin/env python3
# An independent GPU queue peer for the engine's cross-compat tests (T-0021).
# It speaks the queue's on-disk protocol from another implementation:
# fcntl.flock on `.admit`, on its ticket `q-<seq>-<id>` and its lease `l-<id>`,
# the same key=value order. It touches only the folder given.
#
#   gpu-ticket.py hold <dir> <project>   queue (exclusive), wait for the head with no
#                                        holders, lease, print LEASED; on SIGTERM clean up
#   gpu-ticket.py sweep <dir>            sweep: remove what no live owner holds;
#                                        print {"removed": […], "holders": […], "queue": […]}
import fcntl, glob, json, os, signal, sys, time


def kv(p):
    try:
        return dict(l.split("=", 1) for l in open(p).read().splitlines() if "=" in l)
    except OSError:
        return {}


def owned(p):
    try:
        fd = os.open(p, os.O_RDWR)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return False
    except OSError:
        return True
    finally:
        os.close(fd)


class Admit:
    def __init__(self, d): self.d = d
    def __enter__(self):
        os.makedirs(self.d, exist_ok=True)
        self.fd = os.open(f"{self.d}/.admit", os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(self.fd, fcntl.LOCK_EX)
        return self
    def __exit__(self, *a): os.close(self.fd)


def sweep(d):
    out = []
    for p in sorted(glob.glob(f"{d}/q-*") + glob.glob(f"{d}/l-*")):
        if owned(p): continue
        try: os.remove(p); out.append(os.path.basename(p))
        except OSError: pass
    return out


def state(d):
    item = lambda p: {**kv(p), "file": os.path.basename(p)}
    return [item(p) for p in sorted(glob.glob(f"{d}/l-*"))], [item(p) for p in sorted(glob.glob(f"{d}/q-*"))]


def hold(d, project):
    T = L = None; gid = tp = lp = None
    def bye(*_): raise SystemExit(143)
    signal.signal(signal.SIGTERM, bye)
    try:
        with Admit(d):
            n = int((open(f"{d}/.seq").read().strip() if os.path.exists(f"{d}/.seq") else "0") or 0) + 1
            open(f"{d}/.seq", "w").write(str(n))
            gid = f"g-{time.strftime('%m%d-%H%M%S')}-{project}"
            base, k = gid, 1
            while glob.glob(f"{d}/*-{gid}"): k += 1; gid = f"{base}-{k}"
            tp = f"{d}/q-{n:08d}-{gid}"; T = os.open(tp, os.O_CREAT | os.O_RDWR, 0o644); fcntl.flock(T, fcntl.LOCK_EX)
            os.write(T, "".join(f"{a}={b}\n" for a, b in (("id", gid), ("project", project), ("pid", os.getpid()), ("label", "peer"),
                     ("vram", ""), ("exclusive", "1"), ("requested", time.strftime('%Y-%m-%dT%H:%M:%S+09:00')), ("log", ""))).encode())
        print(f"QUEUED {gid}", flush=True)
        while True:
            with Admit(d):
                sweep(d); hs, qs = state(d)
                mine = [q for q in qs if q.get("id") == gid]
                if not mine: print("CANCELLED", flush=True); return 4
                if qs[0].get("id") == gid and not hs:
                    lp = f"{d}/l-{gid}"; L = os.open(lp, os.O_CREAT | os.O_RDWR, 0o644); fcntl.flock(L, fcntl.LOCK_EX)
                    os.write(L, (open(f"{d}/{mine[0]['file']}").read() + "started=now\n").encode())
                    os.remove(f"{d}/{mine[0]['file']}"); os.close(T); T = None; break
            time.sleep(0.5)
        print(f"LEASED {gid}", flush=True)
        while True: time.sleep(1)
    finally:
        for fd, p in ((T, tp), (L, lp)):
            if fd is None: continue
            for f in glob.glob(f"{d}/q-*-{gid}") if p == tp else [p]:
                try: os.remove(f)
                except OSError: pass
            os.close(fd)


if __name__ == "__main__":
    cmd, d = sys.argv[1], sys.argv[2]
    if cmd == "hold": sys.exit(hold(d, sys.argv[3]))
    with Admit(d):
        removed = sweep(d); hs, qs = state(d)
    print(json.dumps({"removed": removed, "holders": hs, "queue": qs}))

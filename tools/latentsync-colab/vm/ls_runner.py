"""latentsync-colab/v1 -- VM runner: install LatentSync (pinned), fetch weights (sha256-verified), lip-sync every
clip in ONE process (models loaded once), report status. Started detached by ls_kick.py. Standard library only.

Layout (ROOT=/content/ls): config.json + inputs/ + vm/ (from the bundle), status.json (atomic, single writer),
host.heartbeat (touched by every ls_poll.py), abort, release.request, out/<id>.raw.mp4, out/results.jsonl,
logs/{runner,setup,infer}.log. LatentSync lives in /content/LatentSync, its venv in /content/ls-venv.

Watchdog (same rules as colab-comfy fk_runner.py): hard deadline or a host heartbeat older than
heartbeatStaleSec -> kill the current step, leave release.request (the next poll cell unassigns from kernel code)
and also try runtime.unassign() here. After a terminal phase the runner idles so the watchdog still covers a
vanished host. Nothing is ever retried.
"""
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile

PROTOCOL = "latentsync-colab/v1"
# LS_ROOT / LS_DIR / LS_VENV / LS_SKIP_SETUP are test hooks only (test/runner_test.sh); the VM uses the defaults.
ROOT = os.environ.get("LS_ROOT", "/content/ls")
LS_DIR = os.environ.get("LS_DIR", "/content/LatentSync")
VENV = os.environ.get("LS_VENV", "/content/ls-venv")
TERMINAL = ("done", "failed", "aborted")
START = time.time()
# The runner inherits the Colab kernel's environment, including MPLBACKEND=module://matplotlib_inline.backend_inline,
# which the venv's matplotlib rejects at import (latentsync.utils.util imports pyplot): first L4 run, 2026-10-19.
os.environ["MPLBACKEND"] = "Agg"

CFG = json.load(open(os.path.join(ROOT, "config.json")))
PINS = json.load(open(os.path.join(ROOT, "vm", "pins.json")))


def log(msg):
    sys.stdout.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stdout.flush()


class Status:
    def __init__(self):
        self.lock = threading.RLock()
        self.doc = {"protocol": PROTOCOL, "ok": True, "phase": "setup", "startedAt": START, "heartbeatAt": START,
                    "error": None, "setup": {}, "env": None, "loadSec": None,
                    "clips": [{"id": c["id"], "state": "queued", "wallSec": None, "peakVramMiB": None,
                               "output": None, "bytes": None, "sha256": None, "error": None} for c in CFG["clips"]]}
        self.save()

    def save(self):
        with self.lock:
            self.doc["heartbeatAt"] = time.time()
            tmp = os.path.join(ROOT, "status.json.tmp")
            with open(tmp, "w") as f:
                json.dump(self.doc, f, separators=(",", ":"))
            os.replace(tmp, os.path.join(ROOT, "status.json"))

    def set(self, **kw):
        with self.lock:
            self.doc.update(kw)
            self.save()

    @property
    def phase(self):
        return self.doc["phase"]


ST = Status()
CHILD = {"proc": None}
STOP = threading.Event()


def run(cmd, logname, cwd=None, env=None, timeout=None):
    """Run one step in its own process group; returns rc (or raises on watchdog/abort)."""
    with open(os.path.join(ROOT, "logs", logname), "ab") as lf:
        lf.write(("\n$ %s\n" % " ".join(cmd)).encode())
        lf.flush()
        p = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, cwd=cwd, env=env, start_new_session=True)
        CHILD["proc"] = p
        try:
            rc = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            raise RuntimeError("step timed out after %ss: %s" % (timeout, " ".join(cmd[:3])))
        finally:
            CHILD["proc"] = None
    if STOP.is_set():
        raise RuntimeError("stopped by watchdog/abort")
    return rc


def must(cmd, logname, **kw):
    rc = run(cmd, logname, **kw)
    if rc != 0:
        raise RuntimeError("rc=%s: %s (see logs/%s)" % (rc, " ".join(cmd[:4]), logname))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def fetch_weights(result):
    """Download every pinned file with curl, verify sha256 + size, unzip buffalo_l. Runs in a thread."""
    t0 = time.time()
    try:
        for f in PINS["files"]:
            dest = os.path.join(LS_DIR, f["dest"])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            must(["curl", "-fsSL", "--retry", "3", "-o", dest + ".part", f["url"]], "setup.log", timeout=1800)
            size = os.path.getsize(dest + ".part")
            if f.get("bytes") and size != f["bytes"]:
                raise RuntimeError("size mismatch %s: %d != %d" % (f["dest"], size, f["bytes"]))
            if f.get("sha256") and sha256(dest + ".part") != f["sha256"]:
                raise RuntimeError("sha256 mismatch: " + f["dest"])
            os.replace(dest + ".part", dest)
            if f.get("unzipTo"):
                with zipfile.ZipFile(dest) as z:
                    z.extractall(os.path.join(LS_DIR, f["unzipTo"]))
            log("weight ok: %s (%d bytes)" % (f["dest"], size))
        result["ok"] = True
    except BaseException as e:  # noqa: BLE001
        result["error"] = "%s: %s" % (type(e).__name__, e)
    result["sec"] = round(time.time() - t0, 1)


def setup():
    t0 = time.time()
    lsp = PINS["latentsync"]
    must(["git", "clone", "-q", lsp["repo"], LS_DIR], "setup.log", timeout=300)
    must(["git", "-C", LS_DIR, "checkout", "-q", lsp["commit"]], "setup.log", timeout=60)
    head = subprocess.check_output(["git", "-C", LS_DIR, "rev-parse", "HEAD"]).decode().strip()
    if head != lsp["commit"]:
        raise RuntimeError("LatentSync HEAD %s != pinned %s" % (head, lsp["commit"]))
    git_sec = round(time.time() - t0, 1)

    weights = {}
    wt = threading.Thread(target=fetch_weights, args=(weights,), daemon=True)
    wt.start()

    t1 = time.time()
    must([sys.executable, "-m", "pip", "install", "-q", "uv==" + PINS["uv"]], "setup.log", timeout=300)
    must([sys.executable, "-m", "uv", "venv", "-q", "-p", PINS["python"], VENV], "setup.log", timeout=600)
    must([sys.executable, "-m", "uv", "pip", "install", "--python", os.path.join(VENV, "bin", "python"),
          "--require-hashes", "--index-strategy", "unsafe-best-match",
          "--extra-index-url", "https://download.pytorch.org/whl/cu121",
          "-r", os.path.join(ROOT, "vm", "requirements.lock.txt")], "setup.log", timeout=1500)
    pip_sec = round(time.time() - t1, 1)

    while wt.is_alive():
        wt.join(timeout=5)
        if STOP.is_set():
            raise RuntimeError("stopped by watchdog/abort")
    if not weights.get("ok"):
        raise RuntimeError("weights: " + str(weights.get("error")))

    probe = ("import json,torch,onnxruntime as o;"
             "p=torch.cuda.get_device_properties(0);"
             "print(json.dumps({'gpu':p.name,'vramMiB':p.total_memory//2**20,'torch':torch.__version__,"
             "'cuda':torch.version.cuda,'cudnn':torch.backends.cudnn.version(),'onnxProviders':o.get_available_providers()}))")
    out = subprocess.check_output([os.path.join(VENV, "bin", "python"), "-c", probe], cwd=LS_DIR, timeout=300)
    env = json.loads(out.decode().strip().splitlines()[-1])
    if "CUDAExecutionProvider" not in env["onnxProviders"]:
        raise RuntimeError("onnxruntime has no CUDAExecutionProvider: LatentSync's face detector requires CUDA")
    ST.set(env=env, setup={"gitSec": git_sec, "pipSec": pip_sec, "downloadSec": weights.get("sec"),
                            "setupSec": round(time.time() - t0, 1)})
    log("setup done: %s" % json.dumps(ST.doc["setup"]))


def infer():
    ST.set(phase="infer")
    results = os.path.join(ROOT, "out", "results.jsonl")
    env = dict(os.environ, HF_HUB_OFFLINE="1", PYTHONUNBUFFERED="1", PYTHONPATH=LS_DIR)  # script is in vm/, package in LS_DIR
    budget = max(60, CFG["hardDeadlineEpoch"] - time.time() - 60)
    box = {}

    def target():
        try:
            box["rc"] = run([os.path.join(VENV, "bin", "python"), "-u", os.path.join(ROOT, "vm", "ls_infer.py"), ROOT],
                            "infer.log", cwd=LS_DIR, env=env, timeout=budget)
        except BaseException as e:  # noqa: BLE001
            box["error"] = "%s: %s" % (type(e).__name__, e)
    t = threading.Thread(target=target, daemon=True)
    t.start()
    while t.is_alive():
        t.join(timeout=5)
        merge_results(results)
    merge_results(results)
    if "error" in box:
        raise RuntimeError(box["error"])
    if box.get("rc") != 0:
        raise RuntimeError("ls_infer.py rc=%s (see logs/infer.log)" % box.get("rc"))


def merge_results(path):
    if not os.path.exists(path):
        return
    with ST.lock:
        for line in open(path):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("event") == "loaded":
                ST.doc["loadSec"] = r.get("loadSec")
                continue
            for c in ST.doc["clips"]:
                if c["id"] == r.get("id"):
                    c.update({k: v for k, v in r.items() if k in c})
        ST.save()


def watchdog():
    stale = float(CFG.get("heartbeatStaleSec", 900))
    while True:
        time.sleep(5)
        reason = None
        if os.path.exists(os.path.join(ROOT, "abort")):
            reason = "abort"
        elif time.time() > CFG["hardDeadlineEpoch"]:
            reason = "hard-deadline"
        else:
            try:
                ref = os.path.getmtime(os.path.join(ROOT, "host.heartbeat"))
            except OSError:
                ref = START
            if time.time() - ref > stale:
                reason = "heartbeat-missing"
        if not reason:
            if ST.phase not in TERMINAL:
                ST.save()  # runner heartbeat
            continue
        STOP.set()
        p = CHILD["proc"]
        if p is not None:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
        with ST.lock:
            if ST.phase not in TERMINAL:
                ST.doc["phase"] = "aborted"
                ST.doc["ok"] = False
                ST.doc["error"] = "watchdog: " + reason
            ST.doc["watchdog"] = {"reason": reason, "at": time.time()}
            ST.save()
        log("watchdog fired: " + reason)
        if reason == "abort":
            return  # the host asked: it will stop the session itself
        with open(os.path.join(ROOT, "release.request"), "w") as f:
            f.write(reason + "\n")
        try:
            from google.colab import runtime
            runtime.unassign()
        except BaseException as e:  # noqa: BLE001 - unverified from a detached process; ls_poll.py also does it
            log("self-release failed: %s: %s" % (type(e).__name__, e))
        return


def main():
    threading.Thread(target=watchdog, daemon=True).start()
    try:
        if os.environ.get("LS_SKIP_SETUP") != "1":
            setup()
        infer()
        bad = [c["id"] for c in ST.doc["clips"] if c["state"] != "done"]
        if bad:
            ST.set(phase="failed", ok=False, error="clips not done: " + ",".join(bad))
        else:
            ST.set(phase="done")
    except BaseException as e:  # noqa: BLE001
        if ST.phase not in TERMINAL:
            ST.set(phase="failed", ok=False, error="%s: %s" % (type(e).__name__, e))
        log("runner error: %s: %s" % (type(e).__name__, e))
    log("phase=%s; idling until the host stops the VM (watchdog still armed)" % ST.phase)
    while True:
        time.sleep(30)


if __name__ == "__main__":
    main()

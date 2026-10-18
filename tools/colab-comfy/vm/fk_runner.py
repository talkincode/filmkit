"""colab-comfy/v1 -- VM runner: setup, launch ComfyUI, run jobs strictly one at a time, report status.

Started by fk_kick.py (setsid nohup). Python standard library only.

Layout (root FK_ROOT, default /content/fk): jobs.json (input), status.json (output, atomic),
host.heartbeat, abort, out/<key>.mp4, logs/{setup,comfy,runner,mon}.log, setup.done, runner.pid.
jobs.json extras the runner understands (additive to PLAN §5.5):
  requiredClasses        top-level list of ComfyUI node classes checked via /object_info/<class>
  jobs[i].outputPrefixAt [nodeId, inputName] where to put `fk/<key>`; default: every node that has
                         a `filename_prefix` input (the SaveVideo node)
Test overrides (env): FK_COMFY_URL (do NOT launch ComfyUI), FK_COMFY_DIR, FK_COMFY_INPUT_DIR,
FK_COMFY_OUTPUT_DIR, FK_POLL_SEC, FK_STATUS_EVERY, FK_WATCHDOG_TICK, FK_COMFY_DEAD_SEC,
FK_SELF_RELEASE_MARKER, FK_FAKE_SETUP / FK_FAKE_ENV (see fk_setup.py).

No generation is ever retried (AGENTS: no retry policy). One failed job does not stop the batch,
except when ComfyUI itself died.
"""
import copy
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fk_setup  # noqa: E402

PROTOCOL = "colab-comfy/v1"
TERMINAL = ("done", "failed", "aborted")
OOM_MARKERS = ("outofmemoryerror", "cuda out of memory", "out of memory")

ROOT = os.environ.get("FK_ROOT", "/content/fk")
COMFY_DIR = os.environ.get("FK_COMFY_DIR", os.path.join(os.path.dirname(ROOT.rstrip("/")) or "/", "ComfyUI"))
INPUT_DIR = os.environ.get("FK_COMFY_INPUT_DIR", os.path.join(COMFY_DIR, "input"))
OUTPUT_DIR = os.environ.get("FK_COMFY_OUTPUT_DIR", os.path.join(COMFY_DIR, "output"))
POLL_SEC = float(os.environ.get("FK_POLL_SEC", "2"))
STATUS_EVERY = float(os.environ.get("FK_STATUS_EVERY", "15"))
WATCHDOG_TICK = float(os.environ.get("FK_WATCHDOG_TICK", "5"))
COMFY_DEAD_SEC = float(os.environ.get("FK_COMFY_DEAD_SEC", "20"))
START = time.time()


def log(msg):
    sys.stdout.write("%s %s\n" % (time.strftime("%H:%M:%S"), fk_setup.redact(msg)))
    sys.stdout.flush()


# ---------------------------------------------------------------- status (single writer: this class)
class Status:
    """All status.json state lives here; every write is tmp + os.replace under one lock."""

    def __init__(self, jobs_doc):
        self.lock = threading.RLock()
        self.doc = {
            "protocol": PROTOCOL, "phase": "setup", "heartbeatAt": time.time(), "error": None,
            "setup": {"startedAt": 0, "finishedAt": 0, "pipSec": 0, "downloadSec": 0},
            "env": None,
            "jobs": [{"key": j["key"], "state": "queued", "promptId": None, "submittedAt": None,
                      "finishedAt": None, "wallSec": None, "peakVramMiB": None, "output": None,
                      "error": None} for j in jobs_doc["jobs"]],
        }

    def save(self):
        with self.lock:
            self.doc["heartbeatAt"] = time.time()
            path = os.path.join(ROOT, "status.json")
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.doc, f, separators=(",", ":"))
            os.replace(tmp, path)

    def update(self, **fields):
        with self.lock:
            self.doc.update(fields)
            self.save()

    def job(self, index, **fields):
        with self.lock:
            self.doc["jobs"][index].update(fields)
            self.save()

    @property
    def phase(self):
        return self.doc["phase"]

    def fail_rest(self, from_index, kind, message):
        """Mark every job from from_index on that is not finished as failed."""
        with self.lock:
            for j in self.doc["jobs"][from_index:]:
                if j["state"] in ("queued", "running"):
                    j["state"] = "failed"
                    j["finishedAt"] = time.time()
                    j["error"] = {"kind": kind, "message": fk_setup.redact(message)[:2000]}
            self.save()


# ---------------------------------------------------------------- monitor (peak VRAM)
class Monitor(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.samples = []  # (epoch, memMiB)
        self.lock = threading.Lock()

    def run(self):
        if shutil.which("nvidia-smi") is None:
            log("monitor: nvidia-smi not found, peak VRAM will be null")
            return
        with open(os.path.join(ROOT, "logs", "mon.log"), "a") as out:
            while True:
                try:
                    r = subprocess.run(["nvidia-smi", "--query-gpu=memory.used,utilization.gpu",
                                        "--format=csv,noheader,nounits"], capture_output=True, text=True,
                                       timeout=10)
                    mem, util = [p.strip() for p in r.stdout.strip().splitlines()[0].split(",")]
                    now = time.time()
                    out.write("%.1f %s %s\n" % (now, mem, util))
                    out.flush()
                    with self.lock:
                        self.samples.append((now, int(float(mem))))
                except Exception as e:  # noqa: BLE001 - monitoring must never kill the runner
                    out.write("# monitor error: %s\n" % e)
                    out.flush()
                time.sleep(1)

    def peak(self, t0, t1):
        with self.lock:
            vals = [m for t, m in self.samples if t0 <= t <= t1]
        return max(vals) if vals else None


# ---------------------------------------------------------------- ComfyUI process + HTTP
class Comfy:
    def __init__(self, manifest):
        self.url = os.environ.get("FK_COMFY_URL")
        self.proc = None
        self.manifest = manifest
        if not self.url:
            launch = manifest.get("launch", [])
            port = launch[launch.index("--port") + 1] if "--port" in launch else "8188"
            self.url = "http://127.0.0.1:%s" % port

    def launch(self):
        if os.environ.get("FK_COMFY_URL"):
            return  # tests: an already running (mock) ComfyUI is used; nothing is launched
        logf = open(os.path.join(ROOT, "logs", "comfy.log"), "ab")
        self.proc = subprocess.Popen([sys.executable, "-u", "main.py"] + list(self.manifest.get("launch", [])),
                                     cwd=COMFY_DIR, stdout=logf, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, start_new_session=True)

    def dead(self):
        return self.proc is not None and self.proc.poll() is not None

    def kill(self):
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except OSError:
                self.proc.kill()

    def http(self, method, path, body=None, timeout=10):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"raw": raw.decode("utf-8", "replace")[:1000]}

    def best_effort(self, method, path, body):
        try:
            self.http(method, path, body, timeout=10)
        except Exception as e:  # noqa: BLE001 - interrupt/free are courtesy calls
            log("%s %s failed: %s" % (method, path, e))


# ---------------------------------------------------------------- helpers
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def abort_requested():
    return os.path.exists(os.path.join(ROOT, "abort"))


def is_oom(blob):
    text = json.dumps(blob).lower() if not isinstance(blob, str) else blob.lower()
    return any(m in text for m in OOM_MARKERS)


def set_output_prefix(workflow, job, prefix):
    at = job.get("outputPrefixAt")
    if at:
        workflow[at[0]]["inputs"][at[1]] = prefix
        return
    hit = False
    for node in workflow.values():
        if isinstance(node, dict) and "filename_prefix" in node.get("inputs", {}):
            node["inputs"]["filename_prefix"] = prefix
            hit = True
    if not hit:
        raise ValueError("workflow has no filename_prefix input (no SaveVideo node?)")


def find_video_output(history_entry):
    """A10: outputs[*].images[*] with metadata.kind == 'video'; fallback: any listed file ending .mp4."""
    outputs = history_entry.get("outputs") or {}
    entries = []
    for node_out in outputs.values():
        for items in node_out.values():
            if isinstance(items, list):
                entries += [i for i in items if isinstance(i, dict) and "filename" in i]
    for e in entries:
        if (e.get("metadata") or {}).get("kind") == "video":
            return e
    for e in entries:
        if str(e["filename"]).lower().endswith(".mp4"):
            return e
    return None


def resolve_output_file(entry):
    sub = entry.get("subfolder") or ""
    name = entry["filename"]
    for part in (sub + "/" + name).replace("\\", "/").split("/"):
        if part == "..":
            raise ValueError("output path escapes the output dir: %r/%r" % (sub, name))
    base = OUTPUT_DIR if entry.get("type", "output") == "output" else os.path.join(os.path.dirname(OUTPUT_DIR), entry["type"])
    return os.path.join(base, sub.lstrip("/"), name)


def history_error_text(entry):
    st = entry.get("status") or {}
    return json.dumps(st.get("messages", st))[:2000]


# ---------------------------------------------------------------- the runner
class Runner:
    def __init__(self):
        with open(os.path.join(ROOT, "jobs.json")) as f:
            self.jobs_doc = json.load(f)
        if self.jobs_doc.get("protocol") != PROTOCOL:
            raise ValueError("unsupported protocol: %r" % self.jobs_doc.get("protocol"))
        self.manifest = self.jobs_doc["manifest"]
        self.limits = self.jobs_doc.get("limits", {})
        self.status = Status(self.jobs_doc)
        self.comfy = Comfy(self.manifest)
        self.monitor = Monitor()
        self.released = False

    # --- watchdog: the VM must not outlive a vanished host (PLAN §5.5, M0 F5/A8) ---
    def self_release(self, reason):
        marker = os.environ.get("FK_SELF_RELEASE_MARKER")
        if marker:  # tests: write a marker instead of releasing a VM
            with open(marker, "w") as f:
                json.dump({"reason": reason, "at": time.time()}, f)
            return
        try:
            from google.colab import runtime  # M0 F5: unassign() releases the VM
            runtime.unassign()
        except Exception as e:  # noqa: BLE001
            # Open risk: unassign() was verified from the kernel (colab exec), not from this detached
            # process. If it fails here the host-side guard/reap layers are the remaining protection.
            log("self_release failed (%s): %s" % (type(e).__name__, e))

    def watchdog(self):
        ttl = float(self.limits.get("idleTtlSec", 600))
        hard = self.limits.get("hardDeadlineEpoch")
        hb_path = os.path.join(ROOT, "host.heartbeat")
        while True:
            time.sleep(WATCHDOG_TICK)
            now = time.time()
            try:
                ref = os.path.getmtime(hb_path)
            except OSError:
                ref = START  # missing heartbeat counts from runner start
            age = now - ref
            phase = self.status.phase
            reason = None
            if hard and now > float(hard):
                reason = "hard-deadline"
            elif phase in TERMINAL and age > ttl:
                reason = "idle-ttl"
            elif age > 2 * ttl:
                reason = "heartbeat-missing"
            if reason:
                self.fire_watchdog(reason)

    def fire_watchdog(self, reason):
        self.released = True
        log("watchdog fired: " + reason)
        with self.status.lock:
            if self.status.phase not in TERMINAL:
                self.status.fail_rest(0, "aborted", "watchdog: " + reason)
                self.status.doc["phase"] = "aborted"
                self.status.doc["error"] = "watchdog: " + reason
            self.status.doc["watchdog"] = {"reason": reason, "at": time.time()}  # terminal phases stay as they were
            self.status.save()
        self.comfy.kill()
        # M3 review: `runtime.unassign()` was verified only from kernel code, not from this detached process.
        # So ALSO leave a request file: the next fk_poll.py (a real kernel cell) sees it and unassigns.
        try:
            tmp = os.path.join(ROOT, "release.request.tmp")
            with open(tmp, "w") as f:
                json.dump({"reason": reason, "at": time.time()}, f)
            os.replace(tmp, os.path.join(ROOT, "release.request"))
        except OSError as e:
            log("could not write release.request: %s" % e)
        self.self_release(reason)
        os._exit(0)

    def status_writer(self):
        while True:
            time.sleep(STATUS_EVERY)
            self.status.save()

    # --- stages ---
    def stage_setup(self):
        res = fk_setup.run_setup(ROOT, self.manifest, self.jobs_doc.get("manifestSha256", ""), self.limits,
                                 COMFY_DIR, should_abort=abort_requested)
        with self.status.lock:
            self.status.doc["setup"] = res["setup"]
            self.status.doc["env"] = res["env"]
            self.status.save()

    def stage_comfy_start(self):
        self.status.update(phase="comfy-start")
        self.comfy.launch()
        deadline = time.time() + float(self.limits.get("comfyStartTimeoutSec", 300))
        while True:
            if abort_requested():
                raise Aborted()
            if self.comfy.dead():
                raise StageError("comfy-start", "ComfyUI exited during startup; see logs/comfy.log")
            try:
                code, _ = self.comfy.http("GET", "/system_stats", timeout=5)
                if code == 200:
                    break
            except (urllib.error.URLError, OSError, ValueError):
                pass
            if time.time() > deadline:
                raise StageError("comfy-start", "ComfyUI did not answer /system_stats in time")
            time.sleep(min(1.0, POLL_SEC))
        missing = []
        for cls in self.jobs_doc.get("requiredClasses", self.manifest.get("requiredClasses", [])):
            code, body = self.comfy.http("GET", "/object_info/" + urllib.parse.quote(cls, safe=""))
            if code != 200 or not isinstance(body, dict) or cls not in body:
                missing.append(cls)
        if missing:
            raise StageError("comfy-start", "ComfyUI is missing node classes: " + ", ".join(missing))
        os.makedirs(INPUT_DIR, exist_ok=True)
        inputs_dir = os.path.join(ROOT, "inputs")
        if os.path.isdir(inputs_dir):
            for name in sorted(os.listdir(inputs_dir)):
                shutil.copyfile(os.path.join(inputs_dir, name), os.path.join(INPUT_DIR, name))

    def wait_history(self, prompt_id, timeout_sec):
        """Returns ('done', entry) | ('timeout', None) | ('aborted', None) | ('comfy-dead', msg)."""
        t_end = time.time() + timeout_sec
        down_since = None
        while True:
            if abort_requested():
                return "aborted", None
            if self.comfy.dead():
                return "comfy-dead", "ComfyUI process exited"
            try:
                code, body = self.comfy.http("GET", "/history/" + prompt_id)
                down_since = None
                if code == 200 and isinstance(body, dict) and prompt_id in body:
                    return "done", body[prompt_id]
            except (urllib.error.URLError, OSError, ValueError) as e:
                down_since = down_since or time.time()
                if time.time() - down_since > COMFY_DEAD_SEC:
                    return "comfy-dead", "ComfyUI unreachable for %.0fs: %s" % (COMFY_DEAD_SEC, e)
            if time.time() > t_end:
                return "timeout", None
            time.sleep(POLL_SEC)

    def run_job(self, i, job):
        """Returns None to continue, or ('failed'|'aborted', message) to stop the batch."""
        key = job["key"]
        t0 = time.time()
        self.status.job(i, state="running", submittedAt=t0)
        wf = copy.deepcopy(job["workflow"])
        try:
            set_output_prefix(wf, job, "fk/" + key)
            code, body = self.comfy.http("POST", "/prompt", {"prompt": wf, "client_id": str(uuid.uuid4())})
        except (urllib.error.URLError, OSError) as e:  # ComfyUI unreachable at submit: it is dead
            self.job_failed(i, t0, "comfy", "POST /prompt failed: %s" % e)
            return ("failed", "ComfyUI unreachable at submit: %s" % e)
        except (ValueError, KeyError) as e:  # bad workflow: this job fails, the batch continues
            return self.job_failed(i, t0, "comfy", "cannot submit: %s" % e)
        if code != 200 or not isinstance(body, dict) or "prompt_id" not in body:
            kind = "oom" if is_oom(body) else "comfy"
            return self.job_failed(i, t0, kind, "POST /prompt -> %s: %s" % (code, json.dumps(body)[:1500]))
        pid = body["prompt_id"]
        self.status.job(i, promptId=pid)

        state, entry = self.wait_history(pid, float(self.limits.get("jobTimeoutSec", 900)))
        if state == "aborted":
            self.comfy.best_effort("POST", "/interrupt", {})
            self.job_failed(i, t0, "aborted", "abort requested")
            return ("aborted", "abort requested")
        if state == "comfy-dead":
            self.job_failed(i, t0, "comfy", entry)
            return ("failed", entry)
        if state == "timeout":
            self.comfy.best_effort("POST", "/interrupt", {})
            return self.job_failed(i, t0, "timeout", "job exceeded %ss" % self.limits.get("jobTimeoutSec", 900))

        status_str = (entry.get("status") or {}).get("status_str")
        if status_str != "success":
            blob = entry.get("status") or entry
            if is_oom(blob):
                self.comfy.best_effort("POST", "/free", {"unload_models": True, "free_memory": True})
                return self.job_failed(i, t0, "oom", history_error_text(entry))
            return self.job_failed(i, t0, "comfy", history_error_text(entry))

        found = find_video_output(entry)
        if found is None:
            return self.job_failed(i, t0, "output-missing", "history has no video output: " +
                                   json.dumps(entry.get("outputs"))[:800])
        try:
            src = resolve_output_file(found)
        except ValueError as e:
            return self.job_failed(i, t0, "output-missing", str(e))
        if not os.path.isfile(src) or os.path.getsize(src) == 0:
            return self.job_failed(i, t0, "output-missing", "output file not found or empty: " + src)
        os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
        dst = os.path.join(ROOT, "out", key + ".mp4")
        part = dst + ".part"
        shutil.copyfile(src, part)  # copy+replace+unlink = a move that also works across devices
        os.replace(part, dst)
        os.remove(src)
        t1 = time.time()
        self.status.job(i, state="done", finishedAt=t1, wallSec=round(t1 - t0, 2),
                        peakVramMiB=self.monitor.peak(t0, t1),
                        output={"path": dst, "bytes": os.path.getsize(dst), "sha256": sha256_file(dst)})
        return None

    def job_failed(self, i, t0, kind, message):
        t1 = time.time()
        self.status.job(i, state="failed", finishedAt=t1, wallSec=round(t1 - t0, 2),
                        peakVramMiB=self.monitor.peak(t0, t1),
                        error={"kind": kind, "message": fk_setup.redact(message)[:2000]})
        return None

    def stage_generate(self):
        self.status.update(phase="generating")
        for i, job in enumerate(self.jobs_doc["jobs"]):
            if abort_requested():
                raise Aborted()
            stop = self.run_job(i, job)
            if stop is None:
                continue
            kind, msg = stop
            if kind == "aborted":
                raise Aborted()
            self.status.fail_rest(i + 1, "comfy", "ComfyUI died: " + msg)
            raise StageError("generating", msg)

    def main(self):
        os.makedirs(os.path.join(ROOT, "logs"), exist_ok=True)
        os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
        with open(os.path.join(ROOT, "runner.pid"), "w") as f:
            f.write(str(os.getpid()))
        self.status.save()
        self.monitor.start()
        threading.Thread(target=self.watchdog, daemon=True).start()
        threading.Thread(target=self.status_writer, daemon=True).start()
        stage = "setup"
        try:
            self.stage_setup()
            stage = "comfy-start"
            self.stage_comfy_start()
            stage = "generating"
            self.stage_generate()
            self.status.update(phase="done")
        except (Aborted, fk_setup.SetupAborted):
            self.comfy.best_effort("POST", "/interrupt", {})
            self.status.fail_rest(0, "aborted", "abort requested")
            self.status.update(phase="aborted", error="abort requested")
        except StageError as e:
            self.status.fail_rest(0, e.kind, e.message)
            self.status.update(phase="failed", error=fk_setup.redact(e.message)[:2000])
        except Exception as e:  # noqa: BLE001 - any unexpected error must surface as phase failed
            msg = "%s in %s: %s" % (type(e).__name__, stage, e)
            self.status.fail_rest(0, stage if stage != "generating" else "comfy", msg)
            self.status.update(phase="failed", error=fk_setup.redact(msg)[:2000])
        log("phase=%s; idling until the watchdog releases the VM" % self.status.phase)
        while True:  # keep the runner (and its watchdog) alive: the host downloads, then stops the VM
            time.sleep(1)


class Aborted(Exception):
    pass


class StageError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = "setup" if kind == "setup" else kind
        self.message = message


def _on_term(signum, _frame):
    log("signal %d: exiting" % signum)
    os._exit(0)


if __name__ == "__main__":
    runner = Runner()
    signal.signal(signal.SIGTERM, lambda s, f: (runner.comfy.kill(), _on_term(s, f)))
    try:
        runner.main()
    finally:
        runner.comfy.kill()

#!/usr/bin/env python3
"""盒子侧执行器：从 Worker 拉任务 -> 执行 -> 回写状态。

设计要点：
  - 执行器随时可能被回收，所以每轮都是「拉一条、做完、回写」，不在内存里攒状态
  - Worker 侧用租约兜底：盒子做到一半被挂起，租约过期后任务会重新可领
  - 产物落本地磁盘，重启后仍在（instabox 的持久盘挂载在 /data）

环境变量：
  WORKER_URL   Worker 地址，如 https://edge-agent-bridge.<account>.workers.dev
  AGENT_TOKEN  与 Worker 侧 WX_TOKEN 相同的共享 token
  DATA_DIR     持久盘目录，默认 /data
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

WORKER = os.environ.get("WORKER_URL", "").rstrip("/")
TOKEN = os.environ.get("AGENT_TOKEN", "")
DATA = os.environ.get("DATA_DIR", "/data")
POLL = 5

if not WORKER or not TOKEN:
    sys.exit("缺少 WORKER_URL / AGENT_TOKEN")

UA = "Mozilla/5.0 (X11; Linux x86_64) box-agent/1"


def call(path, method="GET", body=None):
    h = {
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
        "User-Agent": UA,
    }
    req = urllib.request.Request(WORKER + path, headers=h, method=method)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except Exception as e:
        return None, {"error": str(e)}


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(os.path.join(DATA, "workspace", "agent.log"), "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def run_job(job):
    """执行任务。任务描述是 shell 命令，产物写 <DATA>/workspace/out/<job_id>/"""
    jid = job["id"]
    outdir = os.path.join(DATA, "workspace", "out", jid)
    os.makedirs(outdir, exist_ok=True)
    log("RUN %s: %s" % (jid, job.get("task", "")[:120]))
    t0 = time.time()
    try:
        p = subprocess.run(
            job["task"],
            shell=True,
            cwd=outdir,
            capture_output=True,
            text=True,
            timeout=job.get("timeout", 600),
        )
        rc, out, err = p.returncode, p.stdout[-4000:], p.stderr[-2000:]
    except subprocess.TimeoutExpired:
        rc, out, err = 124, "", "timeout"
    except Exception as e:
        rc, out, err = 1, "", str(e)
    return {
        "state": "done" if rc == 0 else "failed",
        "rc": rc,
        "stdout": out,
        "stderr": err,
        "seconds": round(time.time() - t0, 1),
        "outdir": outdir,
    }


def main():
    log("agent start")
    call("/agent/hello", "POST", {"pid": os.getpid(), "host": os.uname().nodename})
    while True:
        try:
            _, d = call("/agent/next", "POST", {})
            job = (d or {}).get("job")
            if not job:
                time.sleep(POLL)
                continue
            res = run_job(job)
            call("/agent/result", "POST", {"id": job["id"], **res})
            log("RESULT %s %s rc=%s %ss" % (job["id"], res["state"], res["rc"], res["seconds"]))
        except KeyboardInterrupt:
            break
        except Exception as e:
            log("LOOP ERR %s" % e)
            time.sleep(POLL)


if __name__ == "__main__":
    main()

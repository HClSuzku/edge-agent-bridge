#!/usr/bin/env python3
"""微信中继的盒子端：只做「认领 -> 交给 runtime -> 回执」，从不自己去拉 iLink。

为什么不在盒子上拉取：
  iLink 的 getupdates 是单消费者语义——游标前进后消息就没了，谁先拉谁拿走。
  如果盒子和 Worker 都拉，两边会互相偷消息、游标互相覆盖，表现为「偶尔丢消息、
  偶尔重复回复、延迟飘忽」。所以拉取权只给 Worker 里的 Durable Object，
  盒子只从 DO 的队列里认领。

环境变量：
  WORKER_URL    Worker 地址
  RELAY_TOKEN   与 Worker 共享的 token
  RUNTIME_CMD   处理一条消息的命令，stdin 收到消息 JSON，stdout 作为回复文本
  CLAIM_EVERY   认领间隔秒数，默认 3
  HB_EVERY      心跳间隔秒数，默认 20
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

WORKER = os.environ.get("WORKER_URL", "").rstrip("/")
TOKEN = os.environ.get("RELAY_TOKEN", "")
RUNTIME_CMD = os.environ.get("RUNTIME_CMD", "")
SEND_CMD = os.environ.get("SEND_CMD", "")
CLAIM_EVERY = float(os.environ.get("CLAIM_EVERY", "3"))
HB_EVERY = float(os.environ.get("HB_EVERY", "20"))
CLAIM_TIMEOUT = float(os.environ.get("CLAIM_TIMEOUT", "10"))

# 消费者身份：进程启动时生成一次。Worker 用它判断「同一个人重试」并直接重发内容，
# 不必等租约过期。进程重启即换新 id（旧租约自然作废），但绝不要每次请求都换。
CLIENT_ID = os.environ.get("CLIENT_ID", "").strip() or "box-%d-%d" % (
    os.getpid(),
    int(time.time()),
)

if not WORKER or not TOKEN:
    sys.exit("缺少 WORKER_URL / RELAY_TOKEN")

UA = "Mozilla/5.0 (X11; Linux x86_64) box-relay/1"


def call(path, method="POST", body=None, timeout=30):
    h = {
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
        "User-Agent": UA,
    }
    req = urllib.request.Request(WORKER + path, headers=h, method=method)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except Exception as e:
        return None, {"error": str(e)}


def log(msg):
    print("%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg), flush=True)


def handle(msg):
    """把一条微信消息交给 runtime，拿到回复文本。

    RUNTIME_CMD 可以是 `hermes run --stdin`、也可以是 openclaw / pi / 自己的
    Python 包装脚本——中继层不关心下游是什么 agent，只要求「读 stdin 写 stdout」。
    """
    if not RUNTIME_CMD:
        return None
    try:
        p = subprocess.run(
            RUNTIME_CMD,
            shell=True,
            input=json.dumps(msg, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=240,
        )
        if p.returncode != 0:
            log("RUNTIME ERR rc=%s %s" % (p.returncode, p.stderr[-300:]))
            return None
        return p.stdout.strip()
    except Exception as e:
        log("RUNTIME EXC %s" % e)
        return None


def send_reply(msg, text):
    """把回复文本发回给用户。

    两条路，按你的 runtime 选一条：

    1. runtime 自己会发（多数 agent CLI 都自带平台发送），这里什么都不用做——
       把 SEND_CMD 留空即可。
    2. 需要中继层代发：设 SEND_CMD，例如
         SEND_CMD='python3 /opt/ilink-send.py'
       命令从 stdin 收到 {"msg": <原消息>, "text": <回复文本>}，返回码非 0 视为失败。
    """
    if not SEND_CMD:
        return  # runtime 自己发过了
    try:
        p = subprocess.run(
            SEND_CMD,
            shell=True,
            input=json.dumps({"msg": msg, "text": text}, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=60,
        )
        if p.returncode != 0:
            log("SEND ERR rc=%s %s" % (p.returncode, p.stderr[-300:]))
            raise RuntimeError("send failed")
    except Exception as e:
        log("SEND EXC %s" % e)
        raise


def main():
    log("relay start")
    last_hb = 0.0
    while True:
        now = time.time()
        if now - last_hb >= HB_EVERY:
            call("/wx/hb", "POST", {"at": int(now * 1000)})
            last_hb = now

        _, d = call(
            "/wx/claim",
            "POST",
            {"limit": 5, "client_id": CLIENT_ID},
            timeout=CLAIM_TIMEOUT,
        )
        msgs = (d or {}).get("msgs") or []
        if not msgs:
            time.sleep(CLAIM_EVERY)
            continue

        ok_ids, failed_ids = [], []
        for m in msgs:
            mid = m.get("message_id")
            try:
                reply = handle(m)
                if reply:
                    send_reply(m, reply)
                ok_ids.append(mid)
            except Exception as e:
                log("HANDLE ERR %s %s" % (mid, e))
                failed_ids.append(mid)
        # 失败的回队列，Worker 侧会累加 attempts，超过 3 次进 parked
        call("/wx/ack", "POST", {"ids": ok_ids, "failedIds": failed_ids})


if __name__ == "__main__":
    main()

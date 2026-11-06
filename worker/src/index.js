// ccbox — Cloudflare Worker 前端 + Durable Object 队列
// 盒子 = 可丢执行器；Worker 只做鉴权/唤醒/入队/查询。

// 盒子身份一律来自配置：vars.BOX_MACHINE_ID / vars.BOX_BASE（见 wrangler.toml.example）

// 微信接力参数
const WX = {
  hbEveryMs: 20000,     // 盒子心跳间隔
  staleAfterMs: 90000,  // 超过这么久没心跳，视为盒子已挂起 → DO 接手
  alarmEveryMs: 40000,  // DO 巡检间隔（alarm 自续期）
  wxAlarmEveryMs: 10000, // 微信拉取轮询间隔（WxRelay 专用）
  leaseMs: 60000,       // 认领租约：只作兜底（owner 变了才用到），正常靠 client_id 幂等重取
  maxAttempts: 3,       // 重试超过 3 次 → parked，不再重投
  maxAgeMs: 600000,     // 滞留超过 10 分钟 → parked，避免被 200 条上限挤掉
  doneTtlMs: 86400000,  // 已完成记录保留 24 小时，用于去重
  ilink: "https://ilinkai.weixin.qq.com",
  appId: "bot",
  clientVersion: 131336, // 2.1.8
};

const json = (o, s = 200) =>
  new Response(JSON.stringify(o, null, 2), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function ibx(env, path, method = "GET", body) {
  const r = await fetch("https://api.instabox.sh/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.INSTABOX_KEY,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

async function machineState(env) {
  const d = await ibx(env, `/machines/${env.BOX_MACHINE_ID}`);
  const m = d.machine || d;
  return {
    state: m.state,
    ready: (m.runtime || {}).ready === true,
    runStartedAt: m.runStartedAt || null,
    maxRunMinutes: m.maxRunMinutes || null,
    autoSuspendAfterSeconds: m.autoSuspendAfterSeconds || null,
  };
}

async function wake(env) {
  const s = await machineState(env);
  if (s.state === "running" && s.ready) return { woke: false, ...s };
  const t0 = Date.now();
  await ibx(env, `/machines/${env.BOX_MACHINE_ID}/start`, "POST", {});
  for (let i = 0; i < 40; i++) {
    const m = await machineState(env);
    if (m.state === "running" && m.ready) return { woke: true, ms: Date.now() - t0, ...m };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { woke: true, ms: Date.now() - t0, state: "timeout" };
}

// ---------- iLink（微信）直连 ----------
// 盒子醒着时由盒子自己轮询，这里只在盒子失联后接管。
function wxHeaders(env) {
  const uin = btoa(String(Math.floor(Math.random() * 4294967296)));
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: "Bearer " + (env.WX_TOKEN || ""),
    "X-WECHAT-UIN": uin,
    "iLink-App-Id": WX.appId,
    "iLink-App-ClientVersion": String(WX.clientVersion),
  };
}

async function wxPost(env, endpoint, payload, timeoutMs = 15000) {
  const body = JSON.stringify({
    ...payload,
    base_info: { channel_version: "weixin-ilink-py/0.2.0" },
  });
  const r = await fetch((env.WX_ILINK_BASE || WX.ilink) + "/" + endpoint, {
    method: "POST",
    headers: wxHeaders(env),
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

async function wxPoll(env, cursor, timeoutMs = 35000) {
  try {
    const r = await wxPost(env, "ilink/bot/getupdates",
      { get_updates_buf: cursor || "" }, timeoutMs);
    // 游标失效（ret<0）时 iLink 直接返回空，若沿用坏游标会永久卡死；
    // 用空游标重拉一次自愈（未投递消息按账号维护，空游标能取到）。
    if ((r.ret !== undefined && r.ret < 0) || (!r.msgs && !r.get_updates_buf)) {
      const r2 = await wxPost(env, "ilink/bot/getupdates",
        { get_updates_buf: "" }, timeoutMs);
      r2._reseted = true;
      return r2;
    }
    return r;
  } catch (e) {
    return { ret: 0, msgs: [], get_updates_buf: cursor };
  }
}

async function wxSend(env, to, text, contextToken) {
  const msg = {
    from_user_id: "",
    to_user_id: to,
    client_id: "ccbox-" + crypto.randomUUID(),
    message_type: 2,
    message_state: 2,
    context_token: contextToken || "",
    item_list: [{ type: 1, text_item: { text } }],
  };
  return wxPost(env, "ilink/bot/sendmessage", { msg }, 15000);
}

function wxText(msg) {
  const items = msg.item_list || [];
  const parts = [];
  for (const it of items) {
    if (it.type === 1 && it.text_item && it.text_item.text) parts.push(it.text_item.text);
  }
  return parts.join("\n").trim();
}

// ---------- Durable Object：强一致的任务队列 ----------
export class JobQueue {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(req) {
    const u = new URL(req.url);
    const p = u.pathname;
    const st = this.state.storage;

    // ---------- 微信接力 ----------
    if (p === "/wx/hb") {
      const b = await req.json().catch(() => ({}));
      const now = Date.now();
      await st.put("wx:hb", b.at || now);
      if (typeof b.cursor === "string") await st.put("wx:cursor", b.cursor);
      const cur = await st.getAlarm();
      if (!cur) await st.setAlarm(now + WX.alarmEveryMs);
      return json({ ok: true, alive: (b.alive !== false) });
    }

    if (p === "/wx/state") {
      const cursor = (await st.get("wx:cursor")) || "";
      const pending = (await st.get("wx:pending")) || [];
      const hb = (await st.get("wx:hb")) || 0;
      return json({ cursor, pending, hb, staleMs: Date.now() - hb });
    }

    if (p === "/wx/ack") {
      const b = await req.json().catch(() => ({}));
      const ids = new Set(b.ids || []);
      const pending = ((await st.get("wx:pending")) || []).filter((m) => !ids.has(m.message_id));
      await st.put("wx:pending", pending);
      return json({ ok: true, left: pending.length });
    }

    if (p === "/wx/cursor") {
      const b = await req.json().catch(() => ({}));
      if (b.cursor) await st.put("wx:cursor", b.cursor);
      return json({ ok: true });
    }

    if (p === "/enqueue") {
      const b = await req.json().catch(() => ({}));
      const id = "job_" + crypto.randomUUID().slice(0, 8);
      const job = { id, task: b.task || "", timeout: b.timeout || 600,
                    createdAt: Date.now(), state: "queued" };
      await st.put("job:" + id, job);
      await st.put("idx:" + String(job.createdAt).padStart(16, "0") + ":" + id, id);
      return json({ id, state: "queued" }, 202);
    }

    // 原子领取：DO 单线程串行，不存在并发抢同一条
    if (p === "/next") {
      const idx = await st.list({ prefix: "idx:", limit: 50 });
      for (const [k, id] of idx) {
        const job = await st.get("job:" + id);
        if (!job || job.state !== "queued") { await st.delete(k); continue; }
        job.state = "running";
        job.claimedAt = Date.now();
        await st.put("job:" + id, job);
        await st.delete(k);
        return json({ job });
      }
      return json({ job: null });
    }

    if (p === "/result") {
      const b = await req.json().catch(() => ({}));
      if (!b.id) return json({ error: "id required" }, 400);
      const job = (await st.get("job:" + b.id)) || { id: b.id };
      const merged = { ...job, ...b, state: b.state || "done", finishedAt: Date.now() };
      delete merged.task;
      await st.put("job:" + b.id, merged);
      await this.env.KV.put("box:lastResult", JSON.stringify(merged));
      return json({ ok: true });
    }

    if (p.startsWith("/get/")) {
      const id = p.slice(5);
      const job = await st.get("job:" + id);
      if (!job) return json({ error: "not found" }, 404);
      return json(job);
    }

    if (p === "/list") {
      const all = await st.list({ prefix: "job:", limit: 100 });
      const out = [];
      for (const [k, v] of all) out.push({ id: v.id, state: v.state, createdAt: v.createdAt });
      return json({ jobs: out.sort((a, b) => b.createdAt - a.createdAt), v: "m2" });
    }

    return json({ error: "no route", v: "m2", path: p, keys: [...(await st.list({ prefix: "wx:", limit: 5 }))].map(x => x[0]) }, 404);
  }

  // 巡检已停用：微信拉取由 WxRelay 独占游标，这里再拉会拿旧游标抢消息。
  // 保留空实现，让历史遗留下来的那个闹钟响一次后自然断链，不再自续期。
  async alarm() {}
}

async function auth(req, env) {
  if (!env.API_TOKEN) return true;
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return t === env.API_TOKEN;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/") return json({ ok: true, svc: "ccbox",
      endpoints: ["/health", "/status", "/wake", "/jobs", "/jobs/{id}", "/box/*"] });

    if (!(await auth(req, env))) return json({ error: "unauthorized" }, 401);

    const doName = url.searchParams.get("do") || "main";
    const q = env.QUEUE.get(env.QUEUE.idFromName(doName));
    const qf = (path, init) => q.fetch("https://q" + path, init);

    if (p === "/health") return json({ ok: true, ts: new Date().toISOString() });

    if (p === "/status") {
      const s = await machineState(env);
      const last = await env.KV.get("box:lastResult");
      return json({ box: s, lastResult: last ? JSON.parse(last) : null });
    }

    if (p === "/wake") {
      const r = await wake(env);
      await env.KV.put("box:lastWake", JSON.stringify({ at: Date.now(), ...r }));
      return json(r);
    }

    if (p === "/jobs" && req.method === "POST") {
      const body = await req.text();
      const r = await qf("/enqueue", { method: "POST", body });
      const j = await r.json();
      const w = await wake(env);
      return json({ ...j, wake: w }, 202);
    }

    if (p === "/jobs" && req.method === "GET") return qf("/list");

    if (p.startsWith("/jobs/") && req.method === "GET")
      return qf("/get/" + p.split("/")[2]);

    if (p === "/agent/hello" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      await env.KV.put("agent:hello", JSON.stringify({ ...b, at: Date.now() }));
      return json({ ok: true });
    }

    // 微信接力：盒子醒着直连 iLink；失联后由 WxRelay 接手
    const wxq = (path, init) => env.WXQ.get(env.WXQ.idFromName("wx")).fetch("https://q" + path, init);
    if (p === "/wx/hb" && req.method === "POST")
      return wxq("/hb", { method: "POST", body: await req.text() });
    if (p === "/wx/state" && req.method === "GET") return wxq("/state");
    if (p === "/wx/claim" && req.method === "POST")
      return wxq("/claim", { method: "POST", body: await req.text() });
    if (p === "/wx/tick") return wxq("/tick");
    if (p === "/wx/ack" && req.method === "POST")
      return wxq("/ack", { method: "POST", body: await req.text() });
    if (p === "/agent/next" && req.method === "POST") return qf("/next", { method: "POST" });
    if (p === "/agent/result" && req.method === "POST")
      return qf("/result", { method: "POST", body: await req.text() });

    if (p.startsWith("/box/")) {
      const s = await machineState(env);
      if (s.state !== "running" || !s.ready) await wake(env);
      const init = { method: req.method, headers: new Headers(req.headers) };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
      return fetch(env.BOX_BASE + p.slice(4) + url.search, init);
    }

    return json({ error: "not found", path: p }, 404);
  },

  // Cron 巡检：交给 WxRelay 判断盒子是否失联
  async scheduled(event, env, ctx) {
    try {
      await env.WXQ.get(env.WXQ.idFromName("wx")).fetch("https://q/tick");
    } catch (e) {
      console.log("tick failed", String(e));
    }
  },
};


// ---- 微信待办：queued/claimed/done 三态 + 租约 + 重试计数 ----
function normalizePending(list) {
  const now = Date.now();
  return (list || []).map((m) => ({
    ...m,
    _st: m._st || "queued",
    _att: m._att || 0,
    _born: m._born || now,
    _lease: m._lease || 0,
    _owner: m._owner || "",
  }));
}

// 过期租约退回队列（记一次失败）；重试超限或滞留过久转 parked
function sweepPending(list, now) {
  const keep = [];
  const parked = [];
  for (const m of list) {
    if (m._st === "claimed" && m._lease && m._lease < now) {
      m._st = "queued";
      m._att += 1;
      m._lease = 0;
    }
    if (m._st === "queued" && (m._att >= WX.maxAttempts || now - m._born > WX.maxAgeMs)) {
      parked.push({ message_id: m.message_id, att: m._att, ageMs: now - m._born, at: now });
      continue;
    }
    keep.push(m);
  }
  return { keep, parked };
}

// done 记录过期清理：超过 24h 的删除，最多保留 500 条
function pruneDone(done, now) {
  const out = {};
  for (const [k, v] of Object.entries(done || {})) if (now - v < WX.doneTtlMs) out[k] = v;
  const keys = Object.keys(out);
  if (keys.length > 500) {
    keys.sort((a, b) => out[a] - out[b]);
    for (const k of keys.slice(0, keys.length - 500)) delete out[k];
  }
  return out;
}

export class WxRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.hb = 0;
    this.cursor = "";
    this.state.blockConcurrencyWhile(async () => {
      this.hb = (await this.state.storage.get("hb")) || 0;
      this.cursor = (await this.state.storage.get("cursor")) || "";
    });
  }

  async fetch(req) {
    const p = new URL(req.url).pathname;
    const st = this.state.storage;

    if (p === "/hb") {
      const b = await req.json().catch(() => ({}));
      this.hb = b.at || Date.now();
      await st.put("hb", this.hb);
      if (typeof b.cursor === "string" && b.cursor && b.cursor !== this.cursor) {
        this.cursor = b.cursor;
        await st.put("cursor", b.cursor);
      }
      // 心跳即续命：确保巡检闹钟一直在跑（不依赖外部 cron）
      if ((await st.getAlarm()) === null) await st.setAlarm(Date.now() + WX.wxAlarmEveryMs);
      return json({ ok: true });
    }

    if (p === "/state") {
      const pending = (await st.get("pending")) || [];
      const done = (await st.get("done")) || {};
      return json({
        cursor: this.cursor,
        pending,
        done,
        hb: this.hb,
        staleMs: Date.now() - this.hb,
        asleep: Date.now() - this.hb > WX.staleAfterMs,
      });
    }

    // 盒子认领：标 claimed + 租约 + 归属。租约期内只有同一个 client_id 能拿回内容，
    // 这样「响应在网络里丢了」不会把消息锁到租约到期，重试即秒回；换进程才等租约。
    if (p === "/claim") {
      const b = await req.json().catch(() => ({}));
      const lim = Math.max(1, Math.min(50, b.limit || 10));
      const owner = String(b.client_id || "").slice(0, 64);
      const now = Date.now();
      const done = pruneDone((await st.get("done")) || {}, now);
      const list = normalizePending(await st.get("pending"));
      const { keep, parked } = sweepPending(list, now);
      if (parked.length) await st.put("parked", ((await st.get("parked")) || []).concat(parked).slice(-100));
      const out = [];
      let redelivered = 0;
      for (const m of keep) {
        if (out.length >= lim) break;
        if (done[m.message_id]) continue;
        const mine = owner && m._owner === owner;
        // 租给别人且租约未到 → 跳过；自己的租约（重试）→ 直接再给一遍
        if (m._st === "claimed" && !mine && m._lease > now) continue;
        if (mine) redelivered += 1;
        m._st = "claimed";
        m._lease = now + WX.leaseMs;
        m._owner = owner;
        out.push(m);
      }
      await st.put("pending", keep);
      return json({ msgs: out, claimed: out.length, redelivered,
        left: keep.filter((m) => m._st === "queued").length });
    }

    if (p === "/ack") {
      const b = await req.json().catch(() => ({}));
      const ids = new Set(b.ids || []);
      const failedIds = new Set(b.failedIds || []);
      const now = Date.now();
      const pending = (await st.get("pending")) || [];
      // 三态：done → 保留 24h 用于去重；failedIds → 释放租约回队列并记一次失败
      const done = (await st.get("done")) || {};
      const left = [];
      for (const m of pending) {
        const id = m.message_id;
        const isFail = failedIds.has(id) || (b.failed && ids.has(id));
        if (!ids.has(id) && !isFail) { left.push(m); continue; }
        if (isFail) {
          m._st = "queued"; m._lease = 0; m._att = (m._att || 0) + 1; left.push(m);
        } else {
          done[id] = now;
        }
      }
      await st.put("pending", left);
      await st.put("done", pruneDone(done, now));
      return json({ ok: true, left: left.length, done: Object.keys(done).length });
    }

    // 入站唯一消费者：DO 一直拉 iLink，盒子只从这里的队列认领。
    // （iLink 的 getupdates 是单消费者语义，谁先拉谁拿走、不可重放，
    //   所以「盒子自己拉 + DO 兜底拉」必然丢消息，只能由 DO 独占游标。）
    // 抽成方法而非自调用 fetch：DO 里 this.fetch 重入会跟自身请求排队（实测 /state 60ms 而 /claim 挂 30s+）
    if (p === "/tick") return this.tick();

    return json({ ok: true, cls: "WxRelay", v: "r6", path: p });
  }

  // 拉一次 iLink 并入队；盒子睡着就顺手唤醒。由 alarm 直接调用（不走 this.fetch 重入）。
  async tick() {
    const st = this.state.storage;
    if (!this.env.WX_TOKEN) return json({ ok: true, skipped: "no-token" });

    let resp;
    try {
      resp = await wxPoll(this.env, this.cursor, 9000);
    } catch (e) {
      await st.put("lastErr", String(e));
      return json({ ok: false, err: String(e) });
    }
    const msgs = resp.msgs || [];
    if (resp.get_updates_buf && resp.get_updates_buf !== this.cursor) {
      this.cursor = resp.get_updates_buf;
      await st.put("cursor", this.cursor);
    }
    if (!msgs.length) return json({ ok: true, caught: 0 });

    const pending = (await st.get("pending")) || [];
    const done = (await st.get("done")) || {};
    const ids = new Set(pending.map((m) => m.message_id));
    const now = Date.now();
    let added = 0;
    for (const m of msgs) {
      if (!m.message_id || ids.has(m.message_id) || done[m.message_id]) continue;
      pending.push({ ...m, _st: "queued", _att: 0, _born: now, _lease: 0, _owner: "" });
      ids.add(m.message_id);
      added += 1;
    }
    const { keep, parked } = sweepPending(pending, now);
    if (parked.length) await st.put("parked", ((await st.get("parked")) || []).concat(parked).slice(-100));
    await st.put("pending", keep.slice(-200));
    await st.put("lastCatch", { at: now, count: added });

    // 盒子醒着就不必再叫（唤醒接口本身也要一次 API 调用）
    if (now - this.hb > WX.staleAfterMs) {
      try { await wake(this.env); } catch (e) { await st.put("wakeErr", String(e)); }
    }
    return json({ ok: true, caught: msgs.length });
  }

  // 巡检闹钟：清租约/重投，并无条件拉一次 iLink（DO 是入站唯一消费者）；每次自己排下一次
  async alarm() {
    const st = this.state.storage;
    try {
      const now = Date.now();
      const list = normalizePending(await st.get("pending"));
      const { keep, parked } = sweepPending(list, now);
      await st.put("pending", keep);
      if (parked.length)
        await st.put("parked", ((await st.get("parked")) || []).concat(parked).slice(-100));
      await st.put("done", pruneDone((await st.get("done")) || {}, now));
      if (this.env.WX_TOKEN) {
        await this.tick();
      }
    } catch (e) {
      await st.put("lastErr", String(e));
    } finally {
      await st.setAlarm(Date.now() + WX.wxAlarmEveryMs);
    }
  }
}


# edge-agent-bridge

> 用 Cloudflare Durable Object 做「唯一入站消费者 + 唤醒器」，把一台随时可以休眠的
> 廉价云沙箱，变成微信里 7×24 在线的 agent 主机。

你在微信里发一句话，几秒后 agent 回你。中间这台机器大部分时间是睡着的——
睡觉不烧算力，也只有睡着的时候你才真的省钱；醒着的时候它按秒计费。

这套东西解决的是一个具体的矛盾：**入站消息是随时来的，但执行机很贵**。
硬扛的办法是常年开机；取巧的办法是让一个便宜、永不休眠的边缘节点替你盯着消息，
真有事才把机器叫起来。Cloudflare 的 Durable Object 正好是这个「边缘节点」：
它有全局单实例、能自己定时醒来（alarm）、能存状态，而且免费额度对单人使用绰绰有余。

---

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 组件边界、状态机、时序、幂等设计 |
| [docs/deploy.md](docs/deploy.md) | 从零部署：Cloudflare 侧 + 盒子侧 + 验收 |
| [docs/pitfalls.md](docs/pitfalls.md) | 13 条踩坑记录，按「会让人误判」排序 |
| [docs/cost.md](docs/cost.md) | 免费额度实测用量与三个可调旋钮 |
| [docs/extending.md](docs/extending.md) | 换入口（飞书/TG）、换执行器、多 agent |

---

## 它长什么样

```
   微信用户
      │  发消息
      ▼
  iLink（微信 bot 网关）
      │  getupdates：单消费者语义，谁先拉谁拿走
      ▼
┌─────────────────────────────┐
│  Cloudflare Worker          │
│  └── Durable Object「WxRelay」│   永远醒着，唯一拉取者
│        · 10s 一轮、每轮拉 9s  │   拉到消息 → 落 pending 队列
│        · pending / done / parked
│        · 心跳判活：90s 没心跳 = 盒子睡着了
│        · 有消息且盒子睡着 → 调 instabox 唤醒
└──────────────┬──────────────┘
               │  盒子每 3 秒认领一次（毫秒级返回）
               ▼
┌─────────────────────────────┐
│  instabox 沙箱（可挂起/可丢弃）│
│  · weixin_relay.py 认领消息    │
│  · 交给 runtime（Hermes / …）  │
│  · 回复走 iLink 会话           │
└─────────────────────────────┘
```

关键在两条线：

- **入站线**：拉取权只在一个地方（DO）。盒子从不自己拉 iLink。
- **执行线**：机器可以被随时挂起，醒了接着干；消息在 DO 里排队，不会因为机器睡着而丢。

---

## 三条设计铁律

这三条不是风格偏好，是被线上事故逼出来的。违反任何一条，症状都是「偶尔丢消息、
偶尔重复回复、延迟忽快忽慢」——而且很难复现。

### 1. 入站只能有一个消费者

iLink 的 `getupdates` 用的是游标语义：你拿游标去拉，返回新消息和下一个游标；
游标一旦前进，原来的消息就取不回来了。所以两个消费者（比如「盒子自己拉」+
「Worker 兜底拉」）会互相偷消息：A 拉走了 B 该处理的，B 用旧游标又拉一遍，
表现就是丢消息 + 重复回复 + 游标来回跳。

**正确做法：游标只归 DO 所有，盒子只从 DO 的队列里认领。**

### 2. 执行器必须可丢弃

盒子随时会因为额度、宿主机维护或你手动挂起而消失。所以：

- 认领消息必须幂等：盒子带固定 `client_id`，服务端记归属，同 owner 重试直接重发内容
- 租约（默认 60 秒）只做兜底，仅在「盒子进程换了」时才会用到——正常故障恢复是秒级，不是等租约
- 处理失败累计 3 次就进 `parked`，不再重投，避免毒消息卡死队列
- 消息滞留超过 10 分钟也进 `parked`，避免被 200 条上限挤掉

### 3. 唤醒权在 DO，不在机器

机器睡着时没有能力叫醒自己。所以「判断该不该醒」必须由永远醒着的那一侧做。
DO 每轮拉完消息后看盒子心跳：超过 90 秒没更新，就调 instabox 的 start 接口把机器拉起来。

---

## 快速开始

```bash
git clone https://github.com/<you>/edge-agent-bridge
cd edge-agent-bridge/worker
npm i -g wrangler

# 1. 建 KV（把返回的 id 填进 wrangler.toml）
wrangler kv namespace create KV

# 2. 改 wrangler.toml 里的 account_id / KV id / BOX_MACHINE_ID / BOX_BASE

# 3. 写密钥（只进 Cloudflare，不进仓库）
wrangler secret put API_TOKEN         # 盒子调 Worker 的 Bearer，自己生成一串
wrangler secret put INSTABOX_KEY      # instabox API key（用于唤醒）
wrangler secret put WX_TOKEN          # iLink 机器人 token（用于拉取/发送）

# 4. 部署
wrangler deploy
```

盒子侧：

```bash
# 在 instabox 机器上
export WORKER_URL=https://<your-worker>.<account>.workers.dev
export RELAY_TOKEN=<与 WX_TOKEN 相同>
export RUNTIME_CMD='python3 /data/runtime/ask.py'
nohup python3 box/weixin_relay.py > /data/relay.log 2>&1 &
```

冒烟测试（不涉及微信，纯链路）：

```bash
UA='Mozilla/5.0 (X11; Linux x86_64) box-relay/1'   # 必须带，否则被 Cloudflare 拦成 403
curl -s -A "$UA" "$WORKER_URL/health"
curl -s -A "$UA" -X POST -H "Authorization: Bearer $RELAY_TOKEN" \
     -d '{"limit":5,"client_id":"smoke"}' "$WORKER_URL/wx/claim"
curl -s -A "$UA" -H "Authorization: Bearer $RELAY_TOKEN" "$WORKER_URL/status"
```

逐步骤的部署细节见 [docs/deploy.md](docs/deploy.md)，参数与状态机见
[docs/architecture.md](docs/architecture.md)。

---

## 实测数据

一台 128MB 的 DO + 一台 2C4G 的 instabox 沙箱，参数取「10 秒一轮、每轮拉 9 秒」：

| 指标 | 实测 |
|---|---|
| DO 单轮拉取耗时 | 9.07 s（由 `wxPoll(env, cursor, 9000)` 决定） |
| 盒子认领 `/wx/claim` | ~60 ms，且**不被**正在进行的 9 秒拉取阻塞 |
| 消息落地到盒子认领 | 最坏约 1 秒盲区 + 3 秒认领间隔 ≈ 4 秒，通常 1–2 秒 |
| 机器挂起 → 恢复运行 | 1 秒内（持久盘与进程状态保留，不用重装） |
| 日请求量 | 约 8600 次（月均约 26 万，免费额度 100 万/月） |

成本账见 [docs/cost.md](docs/cost.md)：这套参数下 DO 一天约消耗 9720 GB-s，
折合月均约 29 万 GB-s，占免费额度 40 万 GB-s 的 73%。

---

## 踩过的坑

[docs/pitfalls.md](docs/pitfalls.md) 是这个仓库最有价值的部分，包含：

- 为什么「缩短单次拉取时间」在 1 秒以下无效（实测 10 秒/9 秒的差别）
- 老架构里那个 40 秒兜底巡检为什么必须停掉（它会拿过期游标抢消息）
- 机器刚挂起时不能立刻测唤醒（90 秒判活窗口的坑）
- Cloudflare 不许 Worker 代理长任务，长活必须回盒子干
- `pkill -f` 会连自己一起杀（远程 shell 断连的经典事故）
- 以及另外 8 条

---

## 能扩展到哪

当前实现只接微信，但中继层和 agent runtime 是解耦的：

- **换接入端**：飞书 / Telegram / 企微 —— 只要实现「收消息 → 入 pending」这一层，
  下游认领协议完全不用改，见 [docs/extending.md](docs/extending.md)
- **换 agent**：Hermes、openclaw、pi、deepseek-harness —— 盒子端只要满足
  「读 stdin 消息 JSON、写 stdout 回复文本」这一个契约

---

## 边界与免责

- 微信 bot 接入依赖 iLink 的私有协议，接口随时可能变；本项目记录的是当下可用的做法
- 请遵守微信平台规则，不要用它做群发、营销或任何骚扰行为
- 仓库内所有示例均为占位符，部署时请自行生成密钥，**不要提交任何真实 token**

## License

MIT

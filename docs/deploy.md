# 部署

分两半：Cloudflare 侧（Worker + DO + KV），盒子侧（adapter + systemd）。全程只需要一个能跑 `npx wrangler` 的终端和一个 instabox 机器 id。

## 0. 准备

- Cloudflare 账户（免费版即可，配额见 [cost.md](cost.md)）
- Node 18+，用于 `npx wrangler`
- 一个 instabox 机器（下面所有 `m_xxx` 都换成你的）
- 微信 iLink 机器人通道的 token（腾讯官方通道，扫码获得，非灰产）

## 1. Cloudflare 侧

```bash
cd worker
npx wrangler login
npx wrangler whoami            # 记下 account_id
```

建 KV（输出里的 id 填进 `wrangler.toml`）：

```bash
npx wrangler kv namespace create KV
```

Durable Object 不需要手动创建，`migrations` 会在首次 deploy 时建。把 `wrangler.toml` 里的三处占位符换掉：

- `account_id`
- `kv_namespaces.id`
- `vars.BOX_MACHINE_ID` / `vars.BOX_BASE`

`BOX_BASE` 是盒子暴露的 HTTP 端口地址（instabox 形如 `https://8080-<machine>.instabox.tech`），用于把 `/box/*` 请求转发给盒子自己。

## 2. 密钥

密钥一律走 `wrangler secret`，不要写进 `wrangler.toml`：

```bash
npx wrangler secret put API_TOKEN        # 任意长随机串，客户端调用 Worker 时的 Bearer
npx wrangler secret put INSTABOX_KEY     # instabox 的 API key，用于唤醒
npx wrangler secret put WX_TOKEN         # iLink 的机器人 token
npx wrangler secret put WX_ILINK_BASE    # 可选，默认 https://ilinkai.weixin.qq.com
```

生成随机 token：`openssl rand -hex 32`。

## 3. 部署

```bash
npx wrangler deploy
```

部署成功会打印形如 `https://<name>.<subdomain>.workers.dev` 的地址和版本号（`Current Version ID`）。记下版本号，排障时有用。

自检：

```bash
UA='Mozilla/5.0 (X11; Linux x86_64) ccbox-agent/1'
curl -s -A "$UA" https://<your-worker>.workers.dev/health
curl -s -A "$UA" -H "Authorization: Bearer $API_TOKEN" https://<your-worker>.workers.dev/status
```

`/status` 会返回盒子状态和微信队列概况。**必须带 UA**——Cloudflare 默认拦无 UA 的脚本请求（见 pitfalls）。

## 4. 盒子侧

把 `box/weixin_relay.py` 和它的配置放到盒子上（示例路径 `/opt/weixin-relay/adapter.py`），配置读环境变量：

```bash
WEIXIN_RELAY_URL=https://<your-worker>.workers.dev
WEIXIN_RELAY_TOKEN=<与 API_TOKEN 同一个值>
WEIXIN_RELAY_CLAIM_LIMIT=20
WEIXIN_RELAY_CLAIM_TIMEOUT=10
```

adapter 的职责只有三件：定时认领、把消息交给 runtime、回执。它不拉 iLink、不碰游标。

systemd 用户服务（`~/.config/systemd/user/wx-relay.service`）：

```ini
[Unit]
Description=WeChat relay adapter
After=network-online.target

[Service]
EnvironmentFile=%h/.config/weixin-relay.env
ExecStart=%h/.venv/bin/python %h/weixin-relay/adapter.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now wx-relay
systemctl --user status wx-relay --no-pager
```

## 5. 端到端验证

1. 看心跳：`/wx/state` 的 `lastHeartbeat` 应该在 20 秒内更新
2. 发一条微信消息，盒子醒着时应 1～4 秒回复
3. 挂起机器（`POST /v1/machines/<id>/suspend`），等 100 秒以上再发消息，观察唤醒 + 回复
4. 排障时实时看日志：`npx wrangler tail`

## 常见部署错误

| 现象 | 原因 |
| --- | --- |
| `curl` 返回 403 / error 1010 | 没带 UA，被 Cloudflare 拦 |
| DO 报 `Cannot read properties of undefined (reading 'get')` | KV binding 名和代码里的 `env.KV` 不一致 |
| 部署后 `/wx/tick` 405 | wrangler.toml 里漏了 `WXQ` 的 DO binding 或 migrations |
| 盒子一直认领不到 | `WEIXIN_RELAY_TOKEN` 与 Worker 的 `API_TOKEN` 不一致 |

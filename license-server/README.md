# 钻酱SU 卡密验证服务端

零依赖 Node.js 服务，一条命令起服务，自带管理后台。

## 一、部署（Linux 服务器 / 宝塔）

```bash
# 1. 上传本目录到服务器
mkdir -p /opt/zjsu-license && cd /opt/zjsu-license
# 把 server.js / admin.html / package.json 放进来

# 2. 直接运行（先测试）
ADMIN_PASSWORD='你的后台密码' PORT=8080 node server.js
```

生产建议用 systemd：

```bash
cp deploy/zjsu-license.service /etc/systemd/system/
sed -i 's/CHANGE_ME/你的后台密码/' /etc/systemd/system/zjsu-license.service
systemctl daemon-reload && systemctl enable --now zjsu-license
systemctl status zjsu-license
```

Nginx 反代 + HTTPS（客户端只认 https 域名）：

```nginx
server {
    listen 443 ssl http2;
    server_name license.example.com;
    ssl_certificate     /etc/letsencrypt/live/license.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/license.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

宝塔：新建 Node 项目 → 启动文件 `server.js` → 端口 8080 → 环境变量填 `ADMIN_PASSWORD`。

## 二、管理后台

浏览器打开 `https://你的域名/admin`，密码就是 `ADMIN_PASSWORD`。

能做的事：

| 功能 | 说明 |
|---|---|
| 发卡 | 自定义卡密或随机生成；可选时长（1天~永久）、绑定设备、备注；支持批量（最多200） |
| 删卡 | 单张删除，立即失效 |
| 加时/减时 | 一键 +1天 / +30天 / -1天（也可调接口自定义秒数） |
| 绑设备 / 解绑 | 设备号就是 App 里显示的设备标识；绑定后换机无法激活 |
| 停用/启用 | 暂停一张卡，不删除 |
| 重置 | 清空激活状态与绑定，可重新激活 |

## 三、接口（App 用）

```
POST /api/activate   { "card": "ZJ-XXXX-XXXX-XXXX", "device": "设备标识" }
  -> { ok, token, expiresAt(ms, 0=永久), remainingSec, plan }
POST /api/verify     { "card": "...", "device": "...", "token": "..." }
  -> { ok, expiresAt, remainingSec }
```

- 首次激活自动绑定设备；之后换设备返回 403「卡密已绑定其他设备」。
- token 是 HMAC 签名，客户端只做透传，服务端每次重算，伪造无效。
- 所有失败都返回 `{ ok:false, error:"中文原因" }`，App 直接展示。

## 四、App 端对接

在仓库 Settings → Secrets and variables → **Variables** 里加一条：

```
LICENSE_SERVER = https://你的域名
```

然后重跑构建（Actions → Build Manager → Run workflow），App 就会强制卡密验证。

本地想先测：构建时加 `-PLICENSE_SERVER=http://内网IP:8080` 即可。

## 五、数据与备份

- 所有卡密存在 `data/cards.json`（含 HMAC 密钥），**务必备份**；删了这个文件等于全部卡密失效且令牌全废。
- 建议每天 `cp data/cards.json data/cards-$(date +%F).json` 或用宝塔计划任务打包。
- 迁移服务器：连 `data/` 目录一起搬，客户端令牌仍然有效。

## 六、安全建议

1. 修改默认端口、务必用 HTTPS（明文 HTTP 会被抓包重放）。
2. `ADMIN_PASSWORD` 用 16 位以上随机串。
3. 后台路径可改成自己的（把 `server.js` 里 `/admin` 换成别的）。
4. 需要更严格的防爆破，可以在 Nginx 层对 `/api/activate` 加 `limit_req`。

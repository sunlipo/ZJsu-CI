#!/usr/bin/env node
/**
 * 钻酱SU 卡密验证服务端（零依赖，Node.js >= 18）
 *
 * 功能：
 *  - 卡密激活 / 校验（绑定设备、到期时间、HMAC 防伪令牌）
 *  - 管理后台：发卡、删卡、改时长、绑设备、停用、自定义卡密
 *  - 后台登录用 ADMIN_PASSWORD，数据落盘到 data/cards.json
 *
 * 环境变量：
 *  PORT            监听端口，默认 8080
 *  ADMIN_PASSWORD  后台登录密码（必须修改）
 *  DATA_DIR        数据目录，默认 ./data
 *  TRUST_PROXY     设为 1 时读取 X-Forwarded-For
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const DB_FILE = path.join(DATA_DIR, "cards.json");
const ADMIN_TOKEN_TTL = 12 * 3600 * 1000;

if (!ADMIN_PASSWORD) {
  console.error("[FATAL] 请先设置 ADMIN_PASSWORD 环境变量，例如：ADMIN_PASSWORD=你的密码 node server.js");
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------ 存储 ------------------------------ */

let db = { secret: "", cards: {}, audit: [] };

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      if (!db.secret) db.secret = randomHex(32);
      if (!db.cards) db.cards = {};
      if (!db.audit) db.audit = [];
    } catch (e) {
      console.error("[FATAL] 数据文件损坏:", e.message);
      process.exit(1);
    }
  } else {
    db.secret = randomHex(32);
    db.cards = {};
    db.audit = [];
    saveDb();
  }
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
}

function randomHex(n) {
  return crypto.randomBytes(n).toString("hex");
}

function audit(action, detail) {
  db.audit.unshift({ at: Date.now(), action, detail });
  db.audit = db.audit.slice(0, 500);
  saveDb();
}

/* ------------------------------ 工具 ------------------------------ */

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", db.secret).update(s).digest("hex");

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-admin-token",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

/* 简单限流：同一 IP 每分钟最多 30 次公开请求 */
const rate = new Map();
function limited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = rate.get(ip) || { n: 0, ts: now };
  if (now - rec.ts > 60_000) {
    rec.n = 0;
    rec.ts = now;
  }
  rec.n++;
  rate.set(ip, rec);
  return rec.n > 30;
}

/* --------------------------- 卡密核心逻辑 --------------------------- */

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  return `ZJ-${seg()}-${seg()}-${seg()}`;
}

function sanitizeCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function cardStatus(card) {
  if (card.disabled) return "disabled";
  if (!card.activatedAt) return "issued";
  if (card.expiresAt && card.expiresAt <= Date.now()) return "expired";
  return "active";
}

function publicCard(card) {
  return {
    code: card.code,
    note: card.note || "",
    durationSec: card.durationSec || 0,
    issuedAt: card.issuedAt,
    activatedAt: card.activatedAt || null,
    expiresAt: card.expiresAt || null,
    device: card.device || null,
    disabled: !!card.disabled,
    status: cardStatus(card),
    lastSeenAt: card.lastSeenAt || null,
  };
}

function remainingSec(card) {
  if (!card.expiresAt) return null;
  return Math.max(0, Math.floor((card.expiresAt - Date.now()) / 1000));
}

function issueToken(card) {
  return hmac(`card|${card.code}|${card.device || ""}|${card.expiresAt || 0}`);
}

/* ------------------------------ 路由 ------------------------------ */

const ADMIN_HTML = path.join(__dirname, "admin.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") return json(res, 204, {});

  /* 静态后台页面 */
  if (req.method === "GET" && (p === "/" || p === "/admin" || p === "/admin.html")) {
    const html = fs.readFileSync(ADMIN_HTML);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  }

  if (p.startsWith("/api/") || p.startsWith("/admin/api/")) {
    if (limited(req)) return json(res, 429, { ok: false, error: "请求过于频繁，稍后再试" });
  }

  /* ---------------- 客户端：激活 ---------------- */
  if (req.method === "POST" && p === "/api/activate") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: "参数错误" });
    }
    const code = sanitizeCode(body.card);
    const device = String(body.device || "").trim();
    if (!code || !device) return json(res, 400, { ok: false, error: "缺少卡密或设备标识" });

    const card = db.cards[code];
    if (!card) return json(res, 404, { ok: false, error: "卡密不存在" });
    if (card.disabled) return json(res, 403, { ok: false, error: "卡密已停用" });
    if (card.expiresAt && card.expiresAt <= Date.now())
      return json(res, 403, { ok: false, error: "卡密已过期" });

    if (card.device && card.device !== device) {
      return json(res, 403, { ok: false, error: "卡密已绑定其他设备" });
    }
    if (!card.device) {
      card.device = device;
      card.boundAt = Date.now();
    }
    if (!card.activatedAt) card.activatedAt = Date.now();
    if (card.durationSec > 0 && !card.expiresAt) {
      card.expiresAt = card.activatedAt + card.durationSec * 1000;
    }
    card.lastSeenAt = Date.now();
    saveDb();
    audit("activate", `${code} @${device}`);

    return json(res, 200, {
      ok: true,
      plan: card.note || "",
      expiresAt: card.expiresAt || 0,
      remainingSec: remainingSec(card),
      token: issueToken(card),
      serverTime: Date.now(),
    });
  }

  /* ---------------- 客户端：校验 ---------------- */
  if (req.method === "POST" && p === "/api/verify") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: "参数错误" });
    }
    const code = sanitizeCode(body.card);
    const device = String(body.device || "").trim();
    const token = String(body.token || "");
    const card = db.cards[code];
    if (!card) return json(res, 404, { ok: false, error: "卡密不存在" });
    if (card.disabled) return json(res, 403, { ok: false, error: "卡密已停用" });
    if (card.device !== device) return json(res, 403, { ok: false, error: "设备不匹配" });
    if (token !== issueToken(card)) return json(res, 403, { ok: false, error: "令牌无效" });
    if (card.expiresAt && card.expiresAt <= Date.now())
      return json(res, 403, { ok: false, error: "卡密已过期" });

    card.lastSeenAt = Date.now();
    saveDb();
    return json(res, 200, {
      ok: true,
      expiresAt: card.expiresAt || 0,
      remainingSec: remainingSec(card),
      serverTime: Date.now(),
    });
  }

  /* ---------------- 后台登录 ---------------- */
  if (req.method === "POST" && p === "/admin/api/login") {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { ok: false, error: "参数错误" });
    }
    if (String(body.password || "") !== ADMIN_PASSWORD) {
      audit("login-failed", clientIp(req));
      return json(res, 401, { ok: false, error: "密码错误" });
    }
    const exp = Date.now() + ADMIN_TOKEN_TTL;
    const token = `${exp}.${hmac(`admin|${exp}`)}`;
    audit("login", clientIp(req));
    return json(res, 200, { ok: true, token, expiresAt: exp });
  }

  /* ---------------- 后台接口 ---------------- */
  if (p.startsWith("/admin/api/")) {
    const tokenHeader = String(req.headers["x-admin-token"] || "");
    const [expStr, sig] = tokenHeader.split(".");
    const exp = Number(expStr || 0);
    if (!exp || exp < Date.now() || sig !== hmac(`admin|${exp}`)) {
      return json(res, 401, { ok: false, error: "登录已失效" });
    }

    if (req.method === "GET" && p === "/admin/api/cards") {
      const list = Object.values(db.cards).map(publicCard);
      list.sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
      return json(res, 200, { ok: true, cards: list, now: Date.now() });
    }

    if (req.method === "POST" && p === "/admin/api/cards") {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return json(res, 400, { ok: false, error: "参数错误" });
      }
      const count = Math.min(Math.max(Number(body.count || 1), 1), 200);
      const durationSec = Math.max(0, Math.floor(Number(body.durationSec || 0)));
      const note = String(body.note || "").slice(0, 60);
      const device = String(body.device || "").trim() || null;
      const createdAt = Date.now();
      const made = [];
      for (let i = 0; i < count; i++) {
        let code = sanitizeCode(body.code);
        if (code && count > 1) code = `${code}-${i + 1}`;
        if (!code) {
          do {
            code = newCode();
          } while (db.cards[code]);
        }
        if (db.cards[code]) return json(res, 409, { ok: false, error: `卡密已存在：${code}` });
        db.cards[code] = {
          code,
          note,
          durationSec,
          issuedAt: createdAt,
          activatedAt: null,
          expiresAt: null,
          device,
          boundAt: device ? createdAt : null,
          disabled: false,
          lastSeenAt: null,
        };
        made.push(code);
      }
      saveDb();
      audit("issue", `${count} 张 ${note || ""}`);
      return json(res, 200, { ok: true, cards: made });
    }

    const m = p.match(/^\/admin\/api\/cards\/([^/]+)(?:\/([a-z]+))?$/);
    if (m) {
      const code = sanitizeCode(decodeURIComponent(m[1]));
      const action = m[2] || "";
      const card = db.cards[code];

      if (req.method === "DELETE" && !action) {
        if (!card) return json(res, 404, { ok: false, error: "卡密不存在" });
        delete db.cards[code];
        saveDb();
        audit("delete", code);
        return json(res, 200, { ok: true });
      }

      if (!card) return json(res, 404, { ok: false, error: "卡密不存在" });

      if (req.method === "POST" && action === "addtime") {
        const body = await readBody(req).catch(() => ({}));
        const seconds = Math.trunc(Number(body.seconds || 0));
        if (!seconds) return json(res, 400, { ok: false, error: "缺少秒数" });
        if (card.expiresAt) {
          card.expiresAt = Math.max(Date.now(), card.expiresAt + seconds * 1000);
        } else if (card.activatedAt && card.durationSec > 0) {
          card.expiresAt = card.activatedAt + card.durationSec * 1000 + seconds * 1000;
        } else if (!card.activatedAt) {
          card.durationSec = Math.max(0, (card.durationSec || 0) + seconds);
          if (card.durationSec === 0) card.expiresAt = null;
        } else {
          card.expiresAt = Date.now() + seconds * 1000;
        }
        saveDb();
        audit("addtime", `${code} ${seconds}s`);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }

      if (req.method === "POST" && action === "bind") {
        const body = await readBody(req).catch(() => ({}));
        const device = String(body.device || "").trim() || null;
        card.device = device;
        card.boundAt = device ? Date.now() : null;
        saveDb();
        audit("bind", `${code} ${device || "(解绑)"}`);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }

      if (req.method === "POST" && action === "toggle") {
        const body = await readBody(req).catch(() => ({}));
        card.disabled = !!body.disabled;
        saveDb();
        audit("toggle", `${code} ${card.disabled ? "停用" : "启用"}`);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }

      if (req.method === "POST" && action === "reset") {
        card.activatedAt = null;
        card.expiresAt = null;
        card.device = null;
        card.boundAt = null;
        saveDb();
        audit("reset", code);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }

      if (req.method === "GET" && !action) {
        return json(res, 200, { ok: true, card: publicCard(card) });
      }
    }

    return json(res, 404, { ok: false, error: "未知接口" });
  }

  json(res, 404, { ok: false, error: "not found" });
});

loadDb();
server.listen(PORT, () => {
  console.log(`[钻酱SU 卡密服务] 已启动 http://0.0.0.0:${PORT}`);
  console.log(`[钻酱SU 卡密服务] 管理后台 http://<你的域名>:${PORT}/admin`);
  console.log(`[钻酱SU 卡密服务] 数据文件 ${DB_FILE}`);
});

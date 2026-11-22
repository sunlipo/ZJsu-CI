#!/usr/bin/env node
/**
 * 钻酱-泪痕SU安全网络控制台 —— 卡密服务端 v3
 *
 * 角色只有两级：
 *   owner 总管理员 —— 全部权限：发卡、直接删卡、审核、增删账号、改名改密、设置有效期、看每个管理员的数据
 *   admin 管理员   —— 只保留截图里的功能：概览（自己的数据）、生成卡密、卡密管理、申请删卡、公告
 *
 * 客户端接口 /api/activate、/api/verify 与 v1/v2 完全一致，手机端不用改。
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const DB_FILE = path.join(DATA_DIR, "cards.json");
const OWNER_USER = process.env.OWNER_USER || "钻酱";
const OWNER_PASS = process.env.OWNER_PASS || "";
const TOKEN_TTL = 12 * 3600 * 1000;

const RANK = { admin: 1, owner: 2 };
const ROLE_NAME = { admin: "管理员", owner: "总管理员" };
const DAY = 86400;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------ 存储 ------------------------------ */

let db = { secret: "", cards: {}, accounts: {}, requests: [], audit: [] };

const randomHex = (n) => crypto.randomBytes(n).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", db.secret).update(s).digest("hex");

function loadDb() {
  db = fs.existsSync(DB_FILE)
    ? JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
    : { secret: "", cards: {}, accounts: {}, requests: [], audit: [] };
  db.secret = db.secret || randomHex(32);
  db.cards = db.cards || {};
  db.accounts = db.accounts || {};
  db.requests = db.requests || [];
  db.audit = db.audit || [];

  /* v2 -> v3 迁移：去掉超级管理员，补齐账号有效期 */
  for (const acc of Object.values(db.accounts)) {
    if (acc.role === "super") acc.role = "admin";
    if (acc.expiresAt === undefined) acc.expiresAt = 0;
    if (acc.deleted === undefined) acc.deleted = false;
  }
  for (const card of Object.values(db.cards)) {
    if (card.deleted === undefined) card.deleted = false;
  }

  if (!Object.keys(db.accounts).length) {
    if (!OWNER_PASS) {
      console.error("[FATAL] 首次启动需要 OWNER_PASS 环境变量来创建总管理员");
      process.exit(1);
    }
    const acc = makeAccount(OWNER_USER, OWNER_PASS, "owner", null, 0);
    db.accounts[acc.id] = acc;
    console.log(`[初始化] 总管理员 ${OWNER_USER} / ID ${acc.id}`);
  }
  saveDb(true);
}

let saveTimer = null;
function saveDb(immediate = false) {
  const write = () => {
    saveTimer = null;
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  };
  if (immediate) return write();
  if (saveTimer) return;
  saveTimer = setTimeout(write, 60);
}

function makeAccount(username, password, role, createdBy, days) {
  const salt = randomHex(8);
  return {
    id: String(crypto.randomInt(10000, 99999)),
    username: String(username).slice(0, 24),
    salt,
    pass: sha256(salt + password),
    role,
    disabled: false,
    createdAt: Date.now(),
    createdBy: createdBy || null,
    expiresAt: days > 0 ? Date.now() + days * DAY * 1000 : 0,
  };
}

const verifyPassword = (acc, password) => !!acc && sha256(acc.salt + String(password)) === acc.pass;
const accountExpired = (acc) => !!acc.expiresAt && acc.expiresAt <= Date.now();

function audit(action, by, detail) {
  db.audit.unshift({ at: Date.now(), action, by: by || "-", detail: detail || "" });
  db.audit = db.audit.slice(0, 800);
  saveDb();
}

/* ------------------------------ 卡密 ------------------------------ */

const newCode = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array.from({ length: 4 }, () => a[crypto.randomInt(a.length)]).join("");
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
};
const sanitizeCode = (raw) => String(raw || "").trim().toUpperCase().replace(/\s+/g, "");

function cardStatus(card) {
  if (card.deleted) return "deleted";
  if (card.disabled) return "disabled";
  if (!card.activatedAt) return "issued";
  if (card.expiresAt && card.expiresAt <= Date.now()) return "expired";
  return "active";
}

const publicCard = (c) => ({
  code: c.code,
  note: c.note || "",
  durationSec: c.durationSec || 0,
  issuedAt: c.issuedAt,
  activatedAt: c.activatedAt || null,
  expiresAt: c.expiresAt || null,
  device: c.device || null,
  disabled: !!c.disabled,
  status: cardStatus(c),
  lastSeenAt: c.lastSeenAt || null,
  issuedBy: c.issuedBy || "",
  deleted: !!c.deleted,
});

const remainingSec = (c) => (c.expiresAt ? Math.max(0, Math.floor((c.expiresAt - Date.now()) / 1000)) : null);
const issueToken = (c) => hmac(`card|${c.code}|${c.device || ""}|${c.expiresAt || 0}`);

/* ------------------------------ 会话 ------------------------------ */

const makeToken = (acc) => {
  const exp = Date.now() + TOKEN_TTL;
  return `${acc.id}.${exp}.${hmac(`acc|${acc.id}|${exp}`)}`;
};

function currentAccount(req) {
  const raw = String(req.headers.authorization || req.headers["x-admin-token"] || "");
  const [id, expStr, sig] = raw.replace(/^Bearer\s+/i, "").split(".");
  const exp = Number(expStr || 0);
  if (!id || !exp || exp < Date.now() || sig !== hmac(`acc|${id}|${exp}`)) return null;
  const acc = db.accounts[id];
  if (!acc || acc.disabled || accountExpired(acc)) return null;
  return acc;
}

/* ------------------------------ HTTP ------------------------------ */

function json(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-admin-token",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

const clientIp = (req) =>
  (TRUST_PROXY && req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : "") ||
  req.socket.remoteAddress ||
  "";

const rate = new Map();
function limited(req, max = 120) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = rate.get(ip) || { n: 0, ts: now };
  if (now - rec.ts > 60_000) {
    rec.n = 0;
    rec.ts = now;
  }
  rec.n++;
  rate.set(ip, rec);
  return rec.n > max;
}

/* 每个管理员的数据：建卡数 / 未激活 / 已激活 / 后台剩余 */
function accountStat(username) {
  const cards = Object.values(db.cards).filter((c) => (c.issuedBy || "") === username && !c.deleted);
  let active = 0,
    issued = 0,
    expired = 0,
    disabled = 0;
  for (const c of cards) {
    const st = cardStatus(c);
    if (st === "active") active++;
    else if (st === "issued") issued++;
    else if (st === "expired") expired++;
    else disabled++;
  }
  return { cards: cards.length, active, issued, expired, disabled };
}

const accountView = (acc) => {
  const stat = accountStat(acc.username);
  return {
    id: acc.id,
    username: acc.username,
    role: acc.role,
    roleName: ROLE_NAME[acc.role],
    disabled: !!acc.disabled,
    createdAt: acc.createdAt,
    createdBy: acc.createdBy || null,
    deleted: !!acc.deleted,
    expiresAt: acc.expiresAt || 0,
    remainSec: acc.expiresAt ? Math.max(0, Math.floor((acc.expiresAt - Date.now()) / 1000)) : null,
    ...stat,
  };
};

/* ------------------------------ 路由 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") return json(res, 204, {});

  if (req.method === "GET" && (p === "/" || p === "/admin" || p === "/admin.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(fs.readFileSync(path.join(__dirname, "admin.html")));
  }
  if (req.method === "GET" && p === "/avatar.jpg") {
    const file = path.join(__dirname, "avatar.jpg");
    if (!fs.existsSync(file)) return json(res, 404, { ok: false });
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=86400" });
    return res.end(fs.readFileSync(file));
  }

  if ((p.startsWith("/api/") || p.startsWith("/admin/api/")) && limited(req))
    return json(res, 429, { ok: false, error: "请求过于频繁" });

  /* ============ App：激活 ============ */
  if (req.method === "POST" && p === "/api/activate") {
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { ok: false, error: "参数错误" });
    const code = sanitizeCode(body.card);
    const device = String(body.device || "").trim();
    if (!code || !device) return json(res, 400, { ok: false, error: "缺少卡密或设备标识" });
    const card = db.cards[code];
    if (!card || card.deleted) return json(res, 404, { ok: false, error: "卡密不存在" });
    if (card.disabled) return json(res, 403, { ok: false, error: "卡密已停用" });
    if (card.expiresAt && card.expiresAt <= Date.now()) return json(res, 403, { ok: false, error: "卡密已过期" });
    if (card.device && card.device !== device) return json(res, 403, { ok: false, error: "卡密已绑定其他设备" });
    if (!card.device) {
      card.device = device;
      card.boundAt = Date.now();
    }
    if (!card.activatedAt) card.activatedAt = Date.now();
    if (card.durationSec > 0 && !card.expiresAt) card.expiresAt = card.activatedAt + card.durationSec * 1000;
    card.lastSeenAt = Date.now();
    saveDb();
    return json(res, 200, {
      ok: true,
      plan: card.note || "",
      expiresAt: card.expiresAt || 0,
      remainingSec: remainingSec(card),
      token: issueToken(card),
      serverTime: Date.now(),
    });
  }

  /* ============ App：校验 ============ */
  if (req.method === "POST" && p === "/api/verify") {
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { ok: false, error: "参数错误" });
    const code = sanitizeCode(body.card);
    const device = String(body.device || "").trim();
    const card = db.cards[code];
    if (!card || card.deleted) return json(res, 404, { ok: false, error: "卡密不存在" });
    if (card.disabled) return json(res, 403, { ok: false, error: "卡密已停用" });
    if (card.device !== device) return json(res, 403, { ok: false, error: "设备不匹配" });
    if (String(body.token || "") !== issueToken(card)) return json(res, 403, { ok: false, error: "令牌无效" });
    if (card.expiresAt && card.expiresAt <= Date.now()) return json(res, 403, { ok: false, error: "卡密已过期" });
    card.lastSeenAt = Date.now();
    saveDb();
    return json(res, 200, {
      ok: true,
      expiresAt: card.expiresAt || 0,
      remainingSec: remainingSec(card),
      serverTime: Date.now(),
    });
  }

  /* ============ 后台登录 ============ */
  if (req.method === "POST" && p === "/admin/api/login") {
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { ok: false, error: "参数错误" });
    const name = String(body.username || "").trim();
    const acc = Object.values(db.accounts).find((a) => a.username === name && !a.deleted);
    if (!acc || acc.disabled || !verifyPassword(acc, body.password))
      return json(res, 401, { ok: false, error: "账号或密码错误" });
    if (accountExpired(acc)) return json(res, 403, { ok: false, error: "账号已过期，请联系总管理员续期" });
    audit("login", acc.username, clientIp(req));
    return json(res, 200, {
      ok: true,
      token: makeToken(acc),
      me: accountView(acc),
    });
  }

  /* ============ 需要登录 ============ */
  if (p.startsWith("/admin/api/")) {
    const me = currentAccount(req);
    if (!me) return json(res, 401, { ok: false, error: "登录已失效" });
    const isOwner = me.role === "owner";

    if (req.method === "GET" && p === "/admin/api/me") return json(res, 200, { ok: true, me: accountView(me) });

    if (req.method === "POST" && p === "/admin/api/password") {
      const body = await readBody(req).catch(() => ({}));
      if (!verifyPassword(me, body.old)) return json(res, 403, { ok: false, error: "原密码不对" });
      const np = String(body.new || "");
      if (np.length < 6) return json(res, 400, { ok: false, error: "新密码至少 6 位" });
      me.salt = randomHex(8);
      me.pass = sha256(me.salt + np);
      saveDb();
      audit("password", me.username, "self");
      return json(res, 200, { ok: true });
    }

    /* ---------- 概览 ---------- */
    if (req.method === "GET" && p === "/admin/api/overview") {
      const all = Object.values(db.cards);
      const stat = { total: 0, active: 0, issued: 0, expired: 0, disabled: 0, deleted: 0 };
      for (const c of all) {
        const st = cardStatus(c);
        if (st === "deleted") stat.deleted++;
        else if (isOwner || (c.issuedBy || "") === me.username) {
          stat.total++;
          stat[st] = (stat[st] || 0) + 1;
        }
      }
      const mine = (isOwner ? all : all.filter((c) => (c.issuedBy || "") === me.username)).filter((c) => !c.deleted);
      const recent = mine
        .slice()
        .sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0))
        .slice(0, 8)
        .map(publicCard);
      const payload = {
        ok: true,
        stat,
        recent,
        me: accountView(me),
        pending: isOwner ? db.requests.filter((r) => r.status === "pending").length : 0,
      };
      if (isOwner) {
        payload.admins = Object.values(db.accounts)
          .map(accountView)
          .sort((a, b) => RANK[b.role] - RANK[a.role] || (a.createdAt || 0) - (b.createdAt || 0));
        payload.ranking = payload.admins
          .map((a) => ({
            username: a.username,
            role: a.role,
            cards: a.cards,
            issued: a.issued,
            active: a.active,
            remainSec: a.remainSec,
          }))
          .sort((a, b) => b.cards - a.cards)
          .slice(0, 10);
      }
      return json(res, 200, payload);
    }

    /* ---------- 卡密 ---------- */
    if (req.method === "GET" && p === "/admin/api/cards") {
      const trash = url.searchParams.get("trash") === "1";
      const cards = (isOwner
        ? Object.values(db.cards)
        : Object.values(db.cards).filter((c) => (c.issuedBy || "") === me.username)
      ).filter((c) => (trash ? c.deleted : !c.deleted));
      const list = cards.map(publicCard).sort((a, b) => (b.issuedAt || 0) - (a.issuedAt || 0));
      return json(res, 200, { ok: true, cards: list, now: Date.now(), role: me.role, trash });
    }

    if (req.method === "POST" && p === "/admin/api/cards") {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "参数错误" });
      const count = Math.min(Math.max(Number(body.count || 1), 1), 200);
      const durationSec = Math.max(0, Math.floor(Number(body.durationSec || 0)));
      const note = String(body.note || "").slice(0, 60);
      const now = Date.now();
      const made = [];
      for (let i = 0; i < count; i++) {
        let code = sanitizeCode(body.code);
        if (code && count > 1) code = `${code}-${String(i + 1).padStart(2, "0")}`;
        if (code && db.cards[code]) return json(res, 409, { ok: false, error: `卡密已存在：${code}` });
        if (!code) {
          do {
            code = newCode();
          } while (db.cards[code]);
        }
        db.cards[code] = {
          code,
          note,
          durationSec,
          issuedAt: now,
          activatedAt: null,
          expiresAt: null,
          device: null,
          boundAt: null,
          disabled: false,
          lastSeenAt: null,
          issuedBy: me.username,
        };
        made.push(code);
      }
      saveDb();
      audit("issue", me.username, `${count} 张 ${note}`);
      return json(res, 200, { ok: true, cards: made });
    }

    const cm = p.match(/^\/admin\/api\/cards\/([^/]+)(?:\/([a-z]+))?$/);
    if (cm) {
      const code = sanitizeCode(decodeURIComponent(cm[1]));
      const action = cm[2] || "";
      const card = db.cards[code];
      const mineCard = card && (card.issuedBy || "") === me.username;

      if (req.method === "DELETE" && !action) {
        if (!isOwner) {
          if (!card || (card.issuedBy || "") !== me.username)
            return json(res, 403, { ok: false, error: "只能删除自己创建的卡密" });
          if (db.requests.some((r) => r.code === code && r.status === "pending"))
            return json(res, 409, { ok: false, error: "该卡已有待审核的申请" });
          db.requests.unshift({
            id: randomHex(6),
            type: "delete",
            code,
            note: card.note || "",
            by: me.username,
            at: Date.now(),
            status: "pending",
            decidedBy: null,
            decidedAt: null,
          });
          saveDb();
          audit("delete-request", me.username, code);
          return json(res, 202, { ok: false, pending: true, error: "已提交删除申请，等待总管理员审核" });
        }
        if (!card) return json(res, 404, { ok: false, error: "卡密不存在" });
        card.deleted = true;
        card.deletedAt = Date.now();
        card.deletedBy = me.username;
        saveDb();
        audit("delete", me.username, code);
        return json(res, 200, { ok: true });
      }

      if (!card) return json(res, 404, { ok: false, error: "卡密不存在" });
      if (!isOwner && !mineCard) return json(res, 403, { ok: false, error: "只能操作自己生成的卡密" });

      if (req.method === "POST" && action === "addtime") {
        const body = await readBody(req).catch(() => ({}));
        const seconds = Math.trunc(Number(body.seconds || 0));
        if (!seconds) return json(res, 400, { ok: false, error: "缺少秒数" });
        if (!isOwner) {
          if (db.requests.some((r) => r.code === code && r.status === "pending" && r.type === "addtime"))
            return json(res, 409, { ok: false, error: "该卡已有待审核的加时申请" });
          db.requests.unshift({
            id: randomHex(6),
            type: "addtime",
            code,
            note: card.note || "",
            extra: { seconds },
            by: me.username,
            at: Date.now(),
            status: "pending",
            decidedBy: null,
            decidedAt: null,
          });
          saveDb();
          audit("addtime-request", me.username, `${code} ${seconds}s`);
          return json(res, 202, {
            ok: false,
            pending: true,
            error: `已提交加时申请（${Math.round(seconds / 86400)} 天），等待总管理员审核`,
          });
        }
        if (card.expiresAt) card.expiresAt = Math.max(Date.now(), card.expiresAt + seconds * 1000);
        else if (!card.activatedAt) card.durationSec = Math.max(0, (card.durationSec || 0) + seconds);
        else card.expiresAt = Date.now() + seconds * 1000;
        saveDb();
        audit("addtime", me.username, `${code} ${seconds}s`);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }
      /* 管理员对卡密的解绑 / 停用 / 恢复 / 重置 都要总管理员审核 */
      const adminNeedsApproval = (type, extra) => {
        if (db.requests.some((r) => r.code === code && r.status === "pending" && r.type === type))
          return json(res, 409, { ok: false, error: "该卡已有同类待审核申请" });
        db.requests.unshift({
          id: randomHex(6),
          type,
          code,
          note: card.note || "",
          extra: extra || null,
          by: me.username,
          at: Date.now(),
          status: "pending",
          decidedBy: null,
          decidedAt: null,
        });
        saveDb();
        audit(`${type}-request`, me.username, code);
        return json(res, 202, {
          ok: false,
          pending: true,
          error: `已提交${type === "unbind" ? "解绑" : type === "disable" ? "停用" : type === "enable" ? "恢复" : "重置"}申请，等待总管理员审核`,
        });
      };

      if (req.method === "POST" && action === "bind") {
        const body = await readBody(req).catch(() => ({}));
        const device = String(body.device || "").trim() || null;
        if (!isOwner) {
          if (device) return json(res, 403, { ok: false, error: "管理员不能直接绑定设备" });
          return adminNeedsApproval("unbind");
        }
        card.device = device;
        card.boundAt = device ? Date.now() : null;
        saveDb();
        audit("bind", me.username, `${code} ${device || "解绑"}`);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }
      if (req.method === "POST" && action === "toggle") {
        const body = await readBody(req).catch(() => ({}));
        const want = !!body.disabled;
        if (!isOwner) return adminNeedsApproval(want ? "disable" : "enable");
        card.disabled = want;
        saveDb();
        audit("toggle", me.username, `${code} ${card.disabled ? "停用" : "启用"}`);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }
      if (req.method === "POST" && action === "purge") {
        if (!isOwner) return json(res, 403, { ok: false, error: "只有总管理员可彻底删除卡密" });
        if (!card.deleted) return json(res, 400, { ok: false, error: "只有已删除的卡密才能彻底删除" });
        delete db.cards[code];
        db.requests = db.requests.filter((r) => r.code !== code);
        saveDb();
        audit("purge", me.username, code);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && action === "restore") {
        if (!isOwner) return json(res, 403, { ok: false, error: "只有总管理员可恢复卡密" });
        card.deleted = false;
        card.deletedAt = null;
        card.deletedBy = null;
        saveDb();
        audit("restore", me.username, code);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }
      if (req.method === "POST" && action === "expiry") {
        if (!isOwner) return json(res, 403, { ok: false, error: "只有总管理员可改有效期" });
        const body = await readBody(req).catch(() => ({}));
        const days = Math.trunc(Number(body.days || 0));
        if (days === 0) card.expiresAt = null;
        else card.expiresAt = Date.now() + days * DAY * 1000;
        saveDb();
        audit("card-expiry", me.username, `${code} ${days}天`);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }
      if (req.method === "POST" && action === "reset") {
        if (!isOwner) return adminNeedsApproval("reset");
        card.activatedAt = null;
        card.expiresAt = null;
        card.device = null;
        card.boundAt = null;
        saveDb();
        audit("reset", me.username, code);
        return json(res, 200, { ok: true, card: publicCard(card) });
      }
    }

    /* ---------- 审核（仅总管理员） ---------- */
    if (req.method === "GET" && p === "/admin/api/pool") {
      const all = db.requests
        .filter((r) => isOwner || r.by === me.username)
        .slice()
        .sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.at - a.at)
        .slice(0, 100)
        .map((r) => ({
          id: r.id,
          type: r.type,
          code: r.code,
          note: r.note || "",
          by: r.by,
          at: r.at,
          status: r.status,
          decidedBy: r.decidedBy || null,
          decidedAt: r.decidedAt || null,
        }));
      const pending = all.filter((r) => r.status === "pending").length;
      return json(res, 200, { ok: true, pool: all, pending, canApprove: isOwner });
    }

    if (p.startsWith("/admin/api/requests")) {
      if (!isOwner) return json(res, 403, { ok: false, error: "只有总管理员可审核" });
      if (req.method === "GET" && p === "/admin/api/requests")
        return json(res, 200, { ok: true, requests: db.requests.filter((r) => r.status === "pending") });
      const rm = p.match(/^\/admin\/api\/requests\/([^/]+)\/(approve|reject)$/);
      if (rm && req.method === "POST") {
        const item = db.requests.find((r) => r.id === rm[1] && r.status === "pending");
        if (!item) return json(res, 404, { ok: false, error: "申请不存在或已处理" });
        if (item.by === me.username) return json(res, 403, { ok: false, error: "不能审核自己的申请" });
        if (rm[2] === "approve") {
          const target = db.cards[item.code];
          if (item.type === "delete" && target) {
            target.deleted = true;
            target.deletedAt = Date.now();
            target.deletedBy = item.by;
          } else if (item.type === "addtime" && target) {
            const seconds = Math.trunc(Number(item.extra?.seconds || 0));
            if (target.expiresAt) target.expiresAt = Math.max(Date.now(), target.expiresAt + seconds * 1000);
            else if (!target.activatedAt) target.durationSec = Math.max(0, (target.durationSec || 0) + seconds);
            else target.expiresAt = Date.now() + seconds * 1000;
          } else if (target) {
            if (item.type === "unbind") {
              target.device = null;
              target.boundAt = null;
            } else if (item.type === "disable") target.disabled = true;
            else if (item.type === "enable") target.disabled = false;
            else if (item.type === "reset") {
              target.activatedAt = null;
              target.expiresAt = null;
              target.device = null;
              target.boundAt = null;
            }
          }
          item.status = "approved";
        } else item.status = "rejected";
        item.decidedBy = me.username;
        item.decidedAt = Date.now();
        saveDb();
        audit(`request-${rm[2]}`, me.username, item.code || "");
        return json(res, 200, { ok: true });
      }
    }

    /* ---------- 账号（总管理员全权；本人可改自己的名字/密码） ---------- */
    if (p.startsWith("/admin/api/accounts")) {
      if (!isOwner) {
        const probe = p.match(/^\/admin\/api\/accounts\/([^/]+)\/([a-z]+)$/);
        const proxyTarget = probe ? db.accounts[decodeURIComponent(probe[1])] : null;
        const selfEdit = proxyTarget && proxyTarget.id === me.id && ["rename", "password"].includes(probe[2]);
        if (!selfEdit) return json(res, 403, { ok: false, error: "只有总管理员可管理账号" });
      }

      if (req.method === "GET" && p === "/admin/api/accounts") {
        const showDeleted = url.searchParams.get("deleted") === "1";
        const list = Object.values(db.accounts)
          .filter((a) => (showDeleted ? a.deleted : !a.deleted))
          .map(accountView);
        return json(res, 200, { ok: true, accounts: list });
      }

      if (req.method === "POST" && p === "/admin/api/accounts") {
        const body = await readBody(req).catch(() => null);
        if (!body) return json(res, 400, { ok: false, error: "参数错误" });
        const username = String(body.username || "").trim();
        const password = String(body.password || "");
        const role = String(body.role || "admin");
        const days = Math.max(0, Number(body.days || 0));
        if (username.length < 2) return json(res, 400, { ok: false, error: "用户名太短" });
        if (password.length < 6) return json(res, 400, { ok: false, error: "密码至少 6 位" });
        if (!RANK[role]) return json(res, 400, { ok: false, error: "角色不对" });
        if (Object.values(db.accounts).some((a) => a.username === username))
          return json(res, 409, { ok: false, error: "用户名已存在" });
        const acc = makeAccount(username, password, role, me.username, days);
        db.accounts[acc.id] = acc;
        saveDb();
        audit("account-create", me.username, `${username}/${role}/${days}天`);
        return json(res, 200, { ok: true, account: accountView(acc) });
      }

      const am = p.match(/^\/admin\/api\/accounts\/([^/]+)(?:\/([a-z]+))?$/);
      if (am) {
        const target = db.accounts[decodeURIComponent(am[1])];
        const action = am[2] || "";
        if (!target) return json(res, 404, { ok: false, error: "账号不存在" });
        const selfEdit = target.id === me.id && (action === "rename" || action === "password");
        if (!isOwner && !selfEdit)
          return json(res, 403, { ok: false, error: "只能修改自己的名称和密码" });
        if (target.id === me.id && !selfEdit) return json(res, 403, { ok: false, error: "不能操作自己的账号" });
        /* 初始总管理员（createdBy 为空）不可降级、不可被改名改密 */
        const primaryOwner = target.role === "owner" && !target.createdBy;
        if (isOwner && target.role === "owner" && !selfEdit && action !== "role")
          return json(res, 403, { ok: false, error: "总管理员只能降级为管理员，不能改名/改密/删除" });
        if (primaryOwner && !selfEdit)
          return json(res, 403, { ok: false, error: "初始总管理员不可修改或降级" });

        if (req.method === "DELETE" && !action) {
          if (!isOwner) return json(res, 403, { ok: false, error: "只有总管理员可删除账号" });
          if (target.role === "owner") return json(res, 403, { ok: false, error: "总管理员账号不能删除" });
          target.deleted = true;
          target.deletedAt = Date.now();
          target.deletedBy = me.username;
          saveDb();
          audit("account-delete", me.username, target.username);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && action === "purge") {
          if (!isOwner) return json(res, 403, { ok: false, error: "只有总管理员可彻底删除账号" });
          if (!target.deleted) return json(res, 400, { ok: false, error: "只有已删除的账号才能彻底删除" });
          if (target.role === "owner") return json(res, 403, { ok: false, error: "总管理员账号不可彻底删除" });
          const name = target.username;
          delete db.accounts[target.id];
          db.requests = db.requests.filter((r) => r.by !== name);
          for (const c of Object.values(db.cards)) if ((c.issuedBy || "") === name) c.issuedBy = me.username;
          saveDb();
          audit("account-purge", me.username, name);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && action === "restore") {
          if (!isOwner) return json(res, 403, { ok: false, error: "只有总管理员可恢复账号" });
          target.deleted = false;
          target.deletedAt = null;
          target.deletedBy = null;
          saveDb();
          audit("account-restore", me.username, target.username);
          return json(res, 200, { ok: true, account: accountView(target) });
        }

        if (req.method === "POST") {
          const body = await readBody(req).catch(() => ({}));
          if (action === "role") {
            if (!RANK[body.role]) return json(res, 400, { ok: false, error: "角色不对" });
            if (body.role === "admin") {
              const owners = Object.values(db.accounts).filter((a) => a.role === "owner" && !a.disabled);
              if (target.role === "owner" && owners.length <= 1)
                return json(res, 403, { ok: false, error: "至少要保留一个总管理员" });
            }
            target.role = body.role;
            saveDb();
            audit("account-role", me.username, `${target.username}->${body.role}`);
            return json(res, 200, { ok: true, account: accountView(target) });
          }
          if (action === "rename") {
            const name = String(body.username || "").trim();
            if (name.length < 2) return json(res, 400, { ok: false, error: "用户名太短" });
            if (Object.values(db.accounts).some((a) => a.username === name && a.id !== target.id))
              return json(res, 409, { ok: false, error: "用户名已存在" });
            const old = target.username;
            target.username = name;
            /* 卡密里记录的签发人同步改名，统计不丢 */
            for (const c of Object.values(db.cards)) if ((c.issuedBy || "") === old) c.issuedBy = name;
            saveDb();
            audit("account-rename", me.username, `${old}->${name}`);
            return json(res, 200, { ok: true, account: accountView(target) });
          }
          if (action === "password") {
            const np = String(body.password || "");
            if (np.length < 6) return json(res, 400, { ok: false, error: "密码至少 6 位" });
            target.salt = randomHex(8);
            target.pass = sha256(target.salt + np);
            saveDb();
            audit("account-password", me.username, target.username);
            return json(res, 200, { ok: true });
          }
          if (action === "expiry") {
            const days = Math.max(0, Number(body.days || 0));
            target.expiresAt = days > 0 ? Date.now() + days * DAY * 1000 : 0;
            saveDb();
            audit("account-expiry", me.username, `${target.username} ${days}天`);
            return json(res, 200, { ok: true, account: accountView(target) });
          }
          if (action === "disable") {
            target.disabled = !target.disabled;
            saveDb();
            audit("account-disable", me.username, `${target.username} ${target.disabled}`);
            return json(res, 200, { ok: true, account: accountView(target) });
          }
        }
      }
    }

    if (req.method === "GET" && p === "/admin/api/audit") {
      if (!isOwner) return json(res, 403, { ok: false, error: "仅总管理员可看" });
      return json(res, 200, { ok: true, audit: db.audit.slice(0, 200) });
    }

    return json(res, 404, { ok: false, error: "未知接口" });
  }

  json(res, 404, { ok: false, error: "not found" });
});

loadDb();
server.listen(PORT, () => {
  console.log(`[钻酱-泪痕SU控制台] http://0.0.0.0:${PORT}  后台 /admin`);
  console.log(`[钻酱-泪痕SU控制台] 数据 ${DB_FILE}`);
});

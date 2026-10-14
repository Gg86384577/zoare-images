// ZOARÉ 線上訂購網站：客人在 LINE 裡點個人連結 → 瀏覽商品、加入購物車、送出訂單
// 價格一律由伺服器依目錄與會員等級重新計算，客人改網頁也改不了價格。

export const SHOP_BASE = "https://shiny-mud-319f.ojason90816-a70.workers.dev";
const TIER_NAME = { vip: "VIP 會員", member: "一般會員", none: "非會員" };

// ---------- 個人連結簽章（用 LINE Channel Secret 簽，別人猜不到） ----------
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sign(env, uid) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINE_CHANNEL_SECRET + ":shop"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(uid));
  return b64url(sig).slice(0, 22);
}
export async function shopLink(env, uid) {
  return `${SHOP_BASE}/shop?t=${uid}.${await sign(env, uid)}`;
}
async function verifyToken(env, t) {
  const [uid, sig] = String(t || "").split(".");
  if (!uid || !sig || !/^U[0-9a-f]{32}$/.test(uid)) return null;
  return (await sign(env, uid)) === sig ? uid : null;
}
export async function getTier(env, uid) {
  return (env.SESSIONS && (await env.SESSIONS.get("tier:" + uid))) || "none";
}

// ---------- 目錄（精簡版給網頁） ----------
const keyOf = (it) => (it.b || "") + "|" + (it.code || it.jan || it.n);
function packN(it) {
  const m = (it.pack || "").match(/(?:整盒|整箱)\s*(\d+)\s*個/);
  return m ? Number(m[1]) : 0;
}
let SLIM = null, SLIM_SRC = null;
function slim(items, isExpired) {
  if (SLIM && SLIM_SRC === items) return SLIM;
  const out = [];
  for (const it of items) {
    if (!it.g || isExpired(it)) continue;
    if (it.st && /缺貨|停售/.test(it.st)) continue;
    out.push({ k: keyOf(it), n: it.n, b: it.b || "其他", s: it.s || "", g: it.g, v: it.v || it.g, img: it.img || "",
      moq: Number(it.moq) || 0, box: packN(it), pk: it.pack || "", st: it.st || "", sh: it.ship || "", dl: it.dl || "", jan: it.jan || it.code || "", ad: it.ad || "" });
  }
  SLIM = out; SLIM_SRC = items;
  return out;
}

// ---------- 訂購規則（只提醒，不擋） ----------
export function ruleNotes(lines, tier) {
  const notes = [];
  const total = lines.reduce((a, l) => a + l.q, 0);
  for (const l of lines) {
    if (l.box && l.q % l.box) notes.push(`${l.n}：盲盒／整箱商品請以 ${l.box} 的倍數訂購`);
    else if (tier === "none" && l.q < 21) notes.push(`${l.n}：非會員單款需 21 件起`);
    else if (tier !== "none" && l.q < 3) notes.push(`${l.n}：會員每款 3 件起`);
    if (l.moq > 1 && l.q < l.moq && !l.box) notes.push(`${l.n}：貿易商最低訂購量 ${l.moq}`);
  }
  if (tier !== "none" && total < 21) notes.push(`會員混批合計需 21 件起（目前 ${total} 件）`);
  return notes;
}

// ---------- 商品動態 ----------
const dlTime = (dl) => { const m = (dl || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], (m[4] ? +m[4] : 23) - 8, m[5] ? +m[5] : 59) : 0; };
export async function buildNews(env, items) {
  const now = Date.now();
  const ann = JSON.parse((await env.SESSIONS.get("news")) || "[]");
  const deadlines = items.filter((x) => x.dl && dlTime(x.dl) > now && dlTime(x.dl) - now < 21 * 86400e3).sort((a, b) => dlTime(a.dl) - dlTime(b.dl));
  const dlGroups = [];
  for (const x of deadlines) {
    const key = x.b + "|" + x.dl;
    let g = dlGroups.find((g) => g.key === key);
    if (!g) dlGroups.push((g = { key, b: x.b, dl: x.dl, at: dlTime(x.dl), items: [] }));
    g.items.push(x);
  }
  const cutoff = new Date(now - 30 * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10);
  const fresh = items.filter((x) => x.ad && x.ad >= cutoff);
  const newGroups = [];
  for (const x of fresh) {
    const key = x.ad + "|" + x.b;
    let g = newGroups.find((g) => g.key === key);
    if (!g) newGroups.push((g = { key, b: x.b, ad: x.ad, items: [] }));
    g.items.push(x);
  }
  newGroups.sort((a, b) => (a.ad < b.ad ? 1 : -1));
  const restock = items.filter((x) => /再販/.test(x.st) || /再販/.test(x.sh));
  return { ann, dlGroups, newGroups, restockCount: restock.length };
}
export async function newsText(env, items, link) {
  const n = await buildNews(env, items);
  const parts = [];
  if (n.ann.length) parts.push("📢 最新公告\n" + n.ann.slice(0, 3).map((a) => `・${a.d}　${a.t}`).join("\n"));
  if (n.dlGroups.length) parts.push("⏰ 即將截單\n" + n.dlGroups.slice(0, 5).map((g) => `・${g.b}（${g.items.length} 款）截單 ${g.dl.split("（")[0]}`).join("\n"));
  if (n.newGroups.length) parts.push("🆕 最新上架\n" + n.newGroups.slice(0, 6).map((g) => `・${g.ad.slice(5).replace("-", "/")}　${g.b}　${g.items.length} 款`).join("\n"));
  if (n.restockCount) parts.push(`🔁 再販商品 ${n.restockCount} 款`);
  if (!parts.length) parts.push("目前沒有新的商品動態喔～");
  return parts.join("\n\n") + `\n\n👉 看完整動態與商品：\n${link}&v=news`;
}

export async function newsReply(env, deps, link) {
  return newsText(env, slim(await deps.loadCatalog(env), deps.isExpired), link);
}
// ---------- 主處理 ----------
export async function handleShop(request, env, ctx, deps) {
  const url = new URL(request.url);
  const p = url.pathname;
  if (p === "/shop" || p === "/shop/") {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (p === "/shop/catalog") {
    const items = slim(await deps.loadCatalog(env), deps.isExpired);
    return new Response(JSON.stringify(items), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  if (p === "/shop/news") {
    const n = await buildNews(env, slim(await deps.loadCatalog(env), deps.isExpired));
    const pick = (arr) => arr.slice(0, 8).map((x) => x.k);
    return Response.json({ ann: n.ann.slice(0, 5), restockCount: n.restockCount,
      dl: n.dlGroups.slice(0, 10).map((g) => ({ b: g.b, dl: g.dl, n: g.items.length, ks: pick(g.items) })),
      fresh: n.newGroups.slice(0, 12).map((g) => ({ b: g.b, ad: g.ad, n: g.items.length, ks: pick(g.items) })) });
  }
  if (p === "/shop/me") {
    const uid = await verifyToken(env, url.searchParams.get("t"));
    if (!uid) return Response.json({ ok: false, error: "連結無效，請回到 LINE 重新點訂購連結" }, { status: 401 });
    const tier = await getTier(env, uid);
    return Response.json({ ok: true, name: await deps.displayName(env, uid), tier, tierName: TIER_NAME[tier] });
  }
  if (p === "/shop/orders") {
    const uid = await verifyToken(env, url.searchParams.get("t"));
    if (!uid) return Response.json({ ok: false, error: "連結無效" }, { status: 401 });
    const list = await myOrders(env, uid, 20);
    return Response.json({ ok: true, orders: list.map((o) => ({ id: o.id, at: o.at, status: o.status, paid5: o.paid5 || "", track: o.track || "",
      total: o.total, qty: o.qty, tier: TIER_NAME[o.tier], lines: o.lines.map((l) => ({ n: l.n, q: l.q, price: l.price, sub: l.sub })), form: o.form })),
      bank: (await env.SESSIONS.get("bank")) || "" });
  }
  if (p === "/shop/order" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: "資料格式錯誤" }, { status: 400 }); }
    const uid = await verifyToken(env, body.t);
    if (!uid) return Response.json({ ok: false, error: "連結無效，請回到 LINE 重新點訂購連結" }, { status: 401 });
    const tier = await getTier(env, uid);
    const map = new Map(slim(await deps.loadCatalog(env), deps.isExpired).map((x) => [x.k, x]));
    const lines = [];
    for (const r of (body.items || []).slice(0, 300)) {
      const it = map.get(r.k);
      const q = Math.floor(Number(r.q));
      if (!it || !(q > 0) || q > 100000) continue;
      const price = tier === "vip" ? it.v : it.g;
      lines.push({ k: it.k, n: it.n, b: it.b, jan: it.jan, q, price, sub: price * q, box: it.box, moq: it.moq });
    }
    if (!lines.length) return Response.json({ ok: false, error: "購物車是空的，或商品已下架" }, { status: 400 });
    const f = body.form || {};
    const clean = (s, n = 100) => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
    const form = { name: clean(f.name, 40), phone: clean(f.phone, 20), ship: clean(f.ship, 20), addr: clean(f.addr, 150), note: clean(f.note, 300) };
    if (!form.name || !form.phone || !form.ship || !form.addr) return Response.json({ ok: false, error: "請填寫收件人、電話、寄送方式與門市／地址" }, { status: 400 });
    const total = lines.reduce((a, l) => a + l.sub, 0);
    const qty = lines.reduce((a, l) => a + l.q, 0);
    const d = new Date(Date.now() + 8 * 3600e3);
    const id = "ZO" + d.toISOString().slice(2, 10).replace(/-/g, "") + Math.random().toString(36).slice(2, 6).toUpperCase();
    const notes = ruleNotes(lines, tier);
    const lineName = await deps.displayName(env, uid);
    const order = { id, uid, lineName, tier, lines, total, qty, form, notes, status: "待付款", at: d.toISOString().slice(0, 16).replace("T", " ") };
    const bank = (await env.SESSIONS.get("bank")) || "";
    await env.SESSIONS.put("o:" + id, JSON.stringify(order), { expirationTtl: 180 * 86400 });
    await env.SESSIONS.put("ol:" + uid, id, { expirationTtl: 30 * 86400 });
    const mine = JSON.parse((await env.SESSIONS.get("ou:" + uid)) || "[]");
    mine.unshift(id); await env.SESSIONS.put("ou:" + uid, JSON.stringify(mine.slice(0, 50)));
    // 訂單索引（老闆查「訂單」用）
    const idx = JSON.parse((await env.SESSIONS.get("orders")) || "[]");
    idx.unshift(id); await env.SESSIONS.put("orders", JSON.stringify(idx.slice(0, 200)));
    ctx.waitUntil(notifyOrder(env, deps, order, bank));
    return Response.json({ ok: true, id, total, qty, notes, bank, tierName: TIER_NAME[tier] });
  }
  return new Response("Not found", { status: 404 });
}

async function myOrders(env, uid, n = 5) {
  const ids = JSON.parse((await env.SESSIONS.get("ou:" + uid)) || "[]").slice(0, n);
  const out = [];
  for (const id of ids) { const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null"); if (o) out.push(o); }
  return out;
}
// 客人在 LINE 查訂單
export async function customerOrders(env, uid, link) {
  const list = await myOrders(env, uid, 5);
  const lemai = "\n\n在樂賣商城下的訂單，請到樂賣查詢：https://www.lemaiapp.com/m/zoare";
  if (!list.length) return `目前沒有線上訂購網站的訂單紀錄喔${lemai}\n\n🛒 線上訂購：${link}`;
  const rows = list.map((o) => `📦 ${o.id}（${o.at.slice(0, 10)}）\n${o.qty} 件　NT$${o.total.toLocaleString()}　狀態：${o.status}${o.track ? "\n物流單號：" + o.track : ""}`);
  return `您最近的訂單：\n\n${rows.join("\n\n")}\n\n要看完整明細，請點：\n${link}&v=orders\n（或傳訂單編號給我）${lemai}`;
}
export async function customerOrderDetail(env, uid, id) {
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o || o.uid !== uid) return null;
  return `訂單 ${o.id}（${o.at}）\n狀態：${o.status}${o.paid5 ? "　後五碼 " + o.paid5 : ""}${o.track ? "\n物流單號：" + o.track : ""}\n\n${orderText(o, false)}\n\n收件人：${o.form.name}\n寄送：${o.form.ship}　${o.form.addr}`;
}
function orderText(o, withRules = true) {
  const items = o.lines.map((l) => `・${l.n} ×${l.q}　NT$${l.sub.toLocaleString()}`).join("\n");
  return `訂單編號：${o.id}\n${items}\n\n共 ${o.qty} 件　合計 NT$${o.total.toLocaleString()}（${TIER_NAME[o.tier]}價）\n運費：${o.tier === "vip" ? "VIP 免運" : "由客服確認後通知"}` +
    (withRules && o.notes.length ? `\n\n⚠️ 訂購規則提醒：\n${o.notes.slice(0, 8).map((n) => "・" + n).join("\n")}` : "");
}
async function notifyOrder(env, deps, o, bank) {
  try {
    const owner = await env.SESSIONS.get("owner");
    if (owner) {
      await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text:
        `🛒 新訂單！\n客人：${o.lineName}（${TIER_NAME[o.tier]}）\n${orderText(o)}\n\n收件人：${o.form.name}\n電話：${o.form.phone}\n寄送：${o.form.ship}　${o.form.addr}` +
        (o.form.note ? `\n備註：${o.form.note}` : "") }] });
    }
    await deps.lineApi(env, "/v2/bot/message/push", { to: o.uid, messages: [{ type: "text", text:
      `謝謝您的訂購🙏 我們已收到訂單囉\n\n${orderText(o, false)}\n\n` +
      (bank ? `💳 匯款資料：\n${bank}\n\n匯款後請直接在這裡回覆「後五碼 12345」，我們確認後就會幫您安排～` : "我們確認庫存後會再傳匯款資料給您～") }] });
  } catch (e) { console.log("order notify failed", e); }
}

// 客人回報匯款後五碼
export async function handlePayment(env, deps, uid, text) {
  const m = text.match(/^(?:後五碼|末五碼|帳號後五碼)?\s*[:：]?\s*(\d{5})$/);
  if (!m) return null;
  const id = await env.SESSIONS.get("ol:" + uid);
  if (!id) return null;
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o || o.status !== "待付款") return null;
  o.status = "已回報匯款"; o.paid5 = m[1];
  await env.SESSIONS.put("o:" + id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
  const owner = await env.SESSIONS.get("owner");
  if (owner) await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text",
    text: `💰 客人回報匯款\n客人：${o.lineName}\n訂單：${o.id}　NT$${o.total.toLocaleString()}\n後五碼：${m[1]}` }] });
  return `收到👌 訂單 ${o.id} 匯款後五碼 ${m[1]}\n我們對帳後會再通知您喔～`;
}

// 老闆指令：訂單列表／單筆查詢／匯款資料
export async function shopOwnerCommand(env, text, deps = {}) {
  const t = text.trim();
  const bm = t.match(/^匯款資料[\s:：]*([\s\S]*)$/);
  if (bm) {
    if (!bm[1].trim()) {
      const cur = await env.SESSIONS.get("bank");
      return cur ? `目前的匯款資料：\n${cur}\n\n要修改請傳「匯款資料」加上新內容` : "還沒設定匯款資料喔\n請傳：\n匯款資料\n銀行：○○銀行（代碼 ○○○）\n帳號：○○○○\n戶名：○○○";
    }
    await env.SESSIONS.put("bank", bm[1].trim().slice(0, 500));
    return `好👌 匯款資料已更新，客人下單後會看到：\n${bm[1].trim()}`;
  }
  const an = t.match(/^公告[\s:：]*([\s\S]*)$/);
  if (an) {
    const list = JSON.parse((await env.SESSIONS.get("news")) || "[]");
    if (!an[1].trim()) return list.length ? "目前的公告：\n" + list.map((a, i) => `${i + 1}. ${a.d} ${a.t}`).join("\n") + "\n\n傳「刪除公告 1」可以刪掉第 1 則" : "目前沒有公告\n傳「公告 內容」就可以新增，客人點「商品動態」會看到";
    const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 10).replace("-", "/");
    list.unshift({ d, t: an[1].trim().slice(0, 300) });
    await env.SESSIONS.put("news", JSON.stringify(list.slice(0, 10)));
    return `好👌 已新增公告，客人點「商品動態」就會看到：\n${d} ${an[1].trim()}`;
  }
  const dn = t.match(/^刪除公告\s*(\d+)$/);
  if (dn) {
    const list = JSON.parse((await env.SESSIONS.get("news")) || "[]");
    const i = Number(dn[1]) - 1;
    if (!list[i]) return "找不到這則公告，傳「公告」可以看編號";
    const [x] = list.splice(i, 1); await env.SESSIONS.put("news", JSON.stringify(list));
    return `好👌 已刪除公告：${x.t}`;
  }
  if (/^(訂單|訂單列表|最新訂單)$/.test(t)) {
    const idx = JSON.parse((await env.SESSIONS.get("orders")) || "[]").slice(0, 10);
    if (!idx.length) return "目前還沒有線上訂單喔";
    const rows = [];
    for (const id of idx) {
      const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
      if (o) rows.push(`${o.id}｜${o.lineName}｜NT$${o.total.toLocaleString()}｜${o.status}${o.paid5 ? "（" + o.paid5 + "）" : ""}`);
    }
    return "最近 10 筆訂單：\n" + rows.join("\n") + "\n\n傳訂單編號可以看明細，傳「ZO… 已付款」「ZO… 已出貨 物流單號」可以改狀態並通知客人";
  }
  const om = t.match(/^(ZO\w{10})(?:\s*(已付款|已出貨|取消)(?:\s+(.+))?)?$/i);
  if (om) {
    const id = om[1].toUpperCase();
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (!o) return `找不到訂單 ${id}`;
    if (om[2]) {
      o.status = om[2] === "取消" ? "已取消" : om[2];
      if (om[3]) o.track = om[3].trim().slice(0, 60);
      await env.SESSIONS.put("o:" + id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
      const msg = { 已付款: `💰 已收到您的款項囉 謝謝🙏\n訂單 ${id} 我們會盡快安排出貨～`,
        已出貨: `🚚 您的訂單 ${id} 已出貨囉！${o.track ? "\n物流單號：" + o.track : ""}\n收到貨有任何問題都可以跟我們說～`,
        已取消: `您的訂單 ${id} 已取消，有問題可以直接跟我們說喔～` }[o.status];
      let sent = false;
      if (msg && deps.lineApi) { const r = await deps.lineApi(env, "/v2/bot/message/push", { to: o.uid, messages: [{ type: "text", text: msg }] }); sent = r.ok; }
      return `好👌 ${id} 已改成「${o.status}」${o.track ? "（物流單號 " + o.track + "）" : ""}${sent ? "\n已通知客人" : ""}`;
    }
    return `客人：${o.lineName}（${o.at}）\n狀態：${o.status}${o.paid5 ? "　後五碼 " + o.paid5 : ""}\n${orderText(o)}\n\n收件人：${o.form.name}　${o.form.phone}\n寄送：${o.form.ship}　${o.form.addr}${o.form.note ? "\n備註：" + o.form.note : ""}`;
  }
  return null;
}

// ---------- 網頁 ----------
const PAGE = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ZOARÉ 批發訂購</title>
<style>
:root{--bg:#eceef0;--card:#fff;--ink:#161616;--sub:#6b6f75;--line:#dcdfe3;--red:#9e1b1b;--silver:#c9ccd0}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;background:var(--bg);color:var(--ink);padding-bottom:90px}
header{position:sticky;top:0;z-index:5;background:#161616;color:#fff;padding:12px 16px 10px}
.brand{display:flex;align-items:center;justify-content:space-between}
.logo{font-family:Georgia,"Times New Roman",serif;letter-spacing:5px;font-size:22px;color:#d5d8dc}
.who{font-size:12px;color:#b8bbc0;text-align:right;line-height:1.4}.who b{color:#fff}
.tier{display:inline-block;background:#3a3c40;color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;margin-left:4px}.tier.vip{background:var(--red)}
.search{margin-top:10px;display:flex;gap:8px}
.search input{flex:1;border:0;border-radius:10px;padding:10px 12px;font-size:16px;background:#2a2c30;color:#fff}
.search input::placeholder{color:#8d9096}
.chips{display:flex;gap:6px;overflow-x:auto;padding:10px 16px;background:#fff;border-bottom:1px solid var(--line);scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:none;border:1px solid var(--line);background:#fff;border-radius:16px;padding:6px 12px;font-size:13px;color:#333}
.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.chip.news{background:var(--red);color:#fff;border-color:var(--red)}
.nsec{margin-top:14px}.nsec h3{font-size:15px;margin-bottom:6px}
.ann{background:#fff;border-radius:12px;padding:10px 12px;margin-top:6px;font-size:13.5px;line-height:1.6}.ann small{color:var(--sub);margin-right:6px}
.ng{background:#fff;border-radius:12px;padding:10px 12px;margin-top:8px}
.ng .t{display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:700}.ng .t small{font-weight:400;color:var(--sub);font-size:12px}
.ng .th{display:flex;gap:6px;overflow-x:auto;margin-top:8px;scrollbar-width:none}.ng .th img{width:64px;height:64px;object-fit:contain;background:#f6f6f7;border-radius:8px;flex:none}
.ng button{margin-top:8px;border:0;background:var(--ink);color:#fff;border-radius:10px;padding:8px 12px;font-size:13px;width:100%}
.cd{color:var(--red);font-weight:700}
.info{font-size:12px;color:var(--sub);padding:10px 16px 0}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:10px 12px}
@media(min-width:640px){.grid{grid-template-columns:repeat(3,1fr)}}@media(min-width:960px){.grid{grid-template-columns:repeat(4,1fr)}}
.card{background:var(--card);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.ph{aspect-ratio:1;background:#f6f6f7;display:flex;align-items:center;justify-content:center}
.ph img{width:100%;height:100%;object-fit:contain}
.bd{padding:8px 10px 10px;display:flex;flex-direction:column;gap:3px;flex:1}
.bn{font-size:11px;color:var(--sub)}
.nm{font-size:13px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tag{font-size:11px;color:var(--red)}
.pr{margin-top:auto;display:flex;align-items:baseline;gap:6px;padding-top:4px}
.pr b{font-size:17px}.pr s{font-size:12px;color:#999}
.qty{display:flex;align-items:center;justify-content:space-between;margin-top:6px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.qty button{width:38px;height:34px;border:0;background:#f2f3f4;font-size:18px;color:var(--ink)}
.qty input{width:100%;text-align:center;border:0;font-size:15px;height:34px;background:#fff;color:var(--ink)}
.add{margin-top:6px;border:0;border-radius:10px;background:var(--ink);color:#fff;height:36px;font-size:14px}
.more{display:block;margin:6px auto 20px;border:1px solid var(--line);background:#fff;border-radius:20px;padding:10px 24px;font-size:14px}
.bar{position:fixed;left:0;right:0;bottom:0;z-index:6;background:#161616;color:#fff;display:flex;align-items:center;gap:12px;padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
.bar .sum{flex:1;font-size:13px;color:#cfd2d6}.bar .sum b{font-size:18px;color:#fff}
.bar button{border:0;border-radius:12px;background:#fff;color:var(--ink);font-weight:700;padding:11px 16px;font-size:15px}
.bar .ghost{background:#2a2c30;color:#fff;font-weight:500;padding:11px 12px;font-size:13px}
.ord{background:#fff;border-radius:12px;padding:12px;margin-top:10px;font-size:13.5px;line-height:1.6}
.ord .hd{display:flex;justify-content:space-between;align-items:center;font-weight:700}
.st{border-radius:10px;padding:1px 9px;font-size:12px;background:#eceef0;font-weight:600}
.st.s1{background:#fff1d6;color:#8a5a00}.st.s2{background:#e3effc;color:#1d4f8f}.st.s3{background:#e2f4e6;color:#1f6b33}.st.s4{background:#eee;color:#888}
.ord details{margin-top:6px}.ord summary{color:var(--sub);font-size:12.5px}
.ord ul{list-style:none;margin-top:6px;border-top:1px dashed var(--line);padding-top:6px}.ord li{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}
.sheet{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.45);display:none}
.sheet.on{display:block}
.panel{position:absolute;left:0;right:0;bottom:0;max-height:92vh;overflow:auto;background:var(--bg);border-radius:18px 18px 0 0;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}
.panel h2{font-size:18px;display:flex;justify-content:space-between;align-items:center}
.x{border:0;background:none;font-size:26px;color:var(--sub)}
.row{display:flex;gap:10px;background:#fff;border-radius:12px;padding:10px;margin-top:8px;align-items:center}
.row img{width:56px;height:56px;object-fit:contain;background:#f6f6f7;border-radius:8px;flex:none}
.row .t{flex:1;font-size:13px;line-height:1.35}.row .t small{color:var(--sub)}
.row .qty{width:116px;margin:0;flex:none}
.warn{background:#fff4f2;border:1px solid #f1c9c3;color:#8c2a1f;border-radius:12px;padding:10px 12px;margin-top:10px;font-size:12.5px;line-height:1.6}
.tot{background:#fff;border-radius:12px;padding:12px;margin-top:10px;font-size:14px;line-height:1.8}
.tot b{font-size:20px}
form{margin-top:12px;display:grid;gap:8px}
label{font-size:12.5px;color:var(--sub)}
input.f,select.f,textarea.f{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:16px;background:#fff;color:var(--ink);font-family:inherit}
.go{border:0;border-radius:12px;background:var(--ink);color:#fff;font-weight:700;height:48px;font-size:16px;margin-top:6px}
.go:disabled{opacity:.5}
.done{text-align:center;padding:10px 4px}.done h3{font-size:20px;margin:8px 0}.done pre{white-space:pre-wrap;text-align:left;background:#fff;border-radius:12px;padding:12px;font-family:inherit;font-size:14px;line-height:1.7;margin-top:10px}
.err{padding:40px 20px;text-align:center;color:var(--sub);line-height:1.8}
.empty{padding:30px;text-align:center;color:var(--sub);grid-column:1/-1}
</style></head><body>
<header><div class="brand"><div class="logo">ZOARÉ</div><div class="who" id="who">載入中…</div></div>
<div class="search"><input id="q" type="search" placeholder="搜尋商品名稱、角色、JAN 碼" enterkeyhint="search"></div></header>
<div class="chips" id="chips"></div>
<div class="info" id="info"></div>
<div class="grid" id="grid"></div>
<button class="more" id="more" hidden>載入更多</button>
<div class="bar"><button id="openOrders" class="ghost">我的訂單</button><div class="sum" id="sum">購物車是空的</div><button id="openCart">查看購物車</button></div>
<div class="sheet" id="sheet"><div class="panel" id="panel"></div></div>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let ME=null,ALL=[],VIEW=[],shown=0,brand="全部",cart={};
try{cart=JSON.parse(localStorage.getItem("zo_cart")||"{}")}catch(e){}
const save=()=>{try{localStorage.setItem("zo_cart",JSON.stringify(cart))}catch(e){}};
const price=x=>ME&&ME.tier==="vip"?x.v:x.g;
const fmt=n=>"NT$"+n.toLocaleString();
async function init(){
  if(!T){$("#grid").innerHTML='<div class="err">請從 ZOARÉ 的 LINE 官方帳號點「訂購連結」進來喔<br>（在 LINE 傳「訂購」就會收到專屬連結）</div>';$("#who").textContent="";return}
  try{
    const [me,cat]=await Promise.all([fetch("/shop/me?t="+encodeURIComponent(T)).then(r=>r.json()),fetch("/shop/catalog").then(r=>r.json())]);
    if(!me.ok){$("#grid").innerHTML='<div class="err">'+esc(me.error)+'</div>';$("#who").textContent="";return}
    ME=me;ALL=cat;
  }catch(e){$("#grid").innerHTML='<div class="err">載入失敗，請稍後再試</div>';return}
  $("#who").innerHTML='<b>'+esc(ME.name)+'</b><span class="tier '+(ME.tier==="vip"?"vip":"")+'">'+esc(ME.tierName)+'</span><br>'+(ME.tier==="vip"?"已套用 VIP 價":"VIP 會員每件再便宜 NT$30");
  const counts={};ALL.forEach(x=>counts[x.b]=(counts[x.b]||0)+1);
  const brands=["全部"].concat(Object.keys(counts).sort((a,b)=>counts[b]-counts[a]));
  $("#chips").innerHTML='<button class="chip news" id="newsBtn">🆕 商品動態</button>'+brands.map(b=>'<button class="chip'+(b==="全部"?" on":"")+'" data-b="'+esc(b)+'">'+esc(b)+'</button>').join("");
  $("#newsBtn").onclick=openNews;
  $("#chips").onclick=e=>{const b=e.target.dataset.b;if(!b)return;brand=b;document.querySelectorAll(".chip").forEach(c=>c.classList.toggle("on",c.dataset.b===b));filter()};
  for(const k in cart) if(!ALL.find(x=>x.k===k)) delete cart[k];
  filter();bar();
  const Q0=new URLSearchParams(location.search).get("q");if(Q0){$("#q").value=Q0;filter()}
  const V=new URLSearchParams(location.search).get("v");if(V==="orders")openOrders();if(V==="news")openNews();
}
const norm=s=>String(s).toLowerCase().replace(/[\\s・·、，,。．.()（）「」\\-_/|｜]/g,"");
let tmr;$("#q").oninput=()=>{clearTimeout(tmr);tmr=setTimeout(filter,250)};
function filter(){
  const q=norm($("#q").value);const words=$("#q").value.trim().toLowerCase().split(/\\s+/).filter(Boolean).map(norm);
  VIEW=ALL.filter(x=>(brand==="全部"||x.b===brand)&&(!q||words.every(w=>(x._t||(x._t=norm(x.n+x.b+x.s+x.jan+x.st+x.sh+(x.box?"盲盒box整盒":"")))).includes(w))));
  shown=0;$("#grid").innerHTML="";page();
  $("#info").textContent="共 "+VIEW.length+" 款"+(brand!=="全部"?"｜"+brand:"");
}
function card(x){
  const p=price(x),q=cart[x.k]||0;
  const tags=[x.box?("整盒 "+x.box+" 個・只能整盒訂"):"",x.dl?"截單 "+x.dl.split("（")[0]:"",x.st&&/庫存較少|洽詢|請洽/.test(x.st)?x.st.replace(/^.*・/,""):""].filter(Boolean).join("｜");
  return '<div class="card" data-k="'+esc(x.k)+'"><div class="ph">'+(x.img?'<img loading="lazy" src="'+esc(x.img)+'" alt="">':'<span style="color:#aaa;font-size:12px">圖片準備中</span>')+'</div><div class="bd"><div class="bn">'+esc(x.b)+'</div><div class="nm">'+esc(x.n)+'</div>'+(tags?'<div class="tag">'+esc(tags)+'</div>':'')+
  '<div class="pr"><b>'+fmt(p)+'</b>'+(ME.tier==="vip"&&x.v<x.g?'<s>'+fmt(x.g)+'</s>':'')+(x.box?'<span style="font-size:11px;color:#888">／個</span>':'')+'</div>'+qtyBox(x,q)+'</div></div>';
}
function step(x){return x.box||(ME.tier==="none"?21:3)}
function qtyBox(x,q){return q?'<div class="qty"><button data-a="-">−</button><input inputmode="numeric" value="'+q+'"><button data-a="+">＋</button></div>':'<button class="add" data-a="add">加入（'+step(x)+' 件）</button>'}
function page(){
  const part=VIEW.slice(shown,shown+40);shown+=part.length;
  $("#grid").insertAdjacentHTML("beforeend",part.map(card).join("")||(shown?"":'<div class="empty">找不到商品，換個關鍵字試試～</div>'));
  $("#more").hidden=shown>=VIEW.length;
}
$("#more").onclick=page;
window.addEventListener("scroll",()=>{if(!$("#more").hidden&&innerHeight+scrollY>document.body.offsetHeight-600)page()});
const byK=k=>ALL.find(x=>x.k===k);
function setQ(k,q){q=Math.max(0,Math.floor(q)||0);if(q)cart[k]=q;else delete cart[k];save();bar();
  document.querySelectorAll('.card[data-k="'+CSS.escape(k)+'"]').forEach(el=>{const x=byK(k);el.querySelector(".qty,.add").outerHTML=qtyBox(x,q)})}
document.addEventListener("click",e=>{
  const a=e.target.dataset.a;if(!a)return;const c=e.target.closest("[data-k]");if(!c)return;const k=c.dataset.k,x=byK(k),q=cart[k]||0,s=x.box||1;
  if(a==="add")setQ(k,step(x));else if(a==="+")setQ(k,q+s);else if(a==="-")setQ(k,q-s);
  if(c.classList.contains("row"))renderCart();
});
document.addEventListener("change",e=>{if(e.target.matches(".qty input")){const c=e.target.closest("[data-k]");setQ(c.dataset.k,Number(e.target.value));if(c.classList.contains("row"))renderCart()}});
function lines(){return Object.keys(cart).map(k=>{const x=byK(k);return x&&{x,q:cart[k],sub:price(x)*cart[k]}}).filter(Boolean)}
function bar(){const L=lines(),n=L.reduce((a,l)=>a+l.q,0),t=L.reduce((a,l)=>a+l.sub,0);
  $("#sum").innerHTML=n?L.length+" 款 "+n+" 件　<b>"+fmt(t)+"</b>":"購物車是空的"}
function notes(L){const t=ME.tier,out=[],total=L.reduce((a,l)=>a+l.q,0);
  L.forEach(({x,q})=>{if(x.box&&q%x.box)out.push(x.n+"：整盒商品請以 "+x.box+" 的倍數訂購");else if(t==="none"&&q<21)out.push(x.n+"：非會員單款需 21 件起");else if(t!=="none"&&q<3)out.push(x.n+"：會員每款 3 件起");if(x.moq>1&&q<x.moq&&!x.box)out.push(x.n+"：貿易商最低訂購量 "+x.moq)});
  if(t!=="none"&&total<21)out.push("會員混批合計需 21 件起（目前 "+total+" 件）");return out}
$("#openCart").onclick=()=>{renderCart();$("#sheet").classList.add("on")};
$("#openOrders").onclick=openOrders;
function left(dl){const m=dl.match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:\\s+(\\d{1,2}):(\\d{2}))?/);if(!m)return"";const t=Date.UTC(+m[1],+m[2]-1,+m[3],(m[4]?+m[4]:23)-8,m[5]?+m[5]:59)-Date.now();if(t<0)return"已截單";const d=Math.floor(t/864e5),h=Math.floor(t%864e5/36e5);return d?"剩 "+d+" 天 "+h+" 小時":"剩 "+h+" 小時"}
async function openNews(){
  $("#panel").innerHTML='<h2>商品動態<button class="x" id="nx">×</button></h2><div class="empty">載入中…</div>';$("#sheet").classList.add("on");$("#nx").onclick=()=>$("#sheet").classList.remove("on");
  try{const r=await fetch("/shop/news").then(r=>r.json());
    const th=ks=>'<div class="th">'+ks.map(k=>byK(k)).filter(x=>x&&x.img).map(x=>'<img loading="lazy" src="'+esc(x.img)+'">').join("")+'</div>';
    let h='';
    if(r.ann.length)h+='<div class="nsec"><h3>📢 最新公告</h3>'+r.ann.map(a=>'<div class="ann"><small>'+esc(a.d)+'</small>'+esc(a.t)+'</div>').join("")+'</div>';
    if(r.dl.length)h+='<div class="nsec"><h3>⏰ 即將截單</h3>'+r.dl.map(g=>'<div class="ng"><div class="t"><span>'+esc(g.b)+'　'+g.n+' 款</span><small class="cd">'+esc(left(g.dl))+'</small></div><div style="font-size:12px;color:#6b6f75">截單 '+esc(g.dl.split("（")[0])+'</div>'+th(g.ks)+'<button data-go="'+esc(g.b)+'">去看看</button></div>').join("")+'</div>';
    if(r.fresh.length)h+='<div class="nsec"><h3>🆕 最新上架</h3>'+r.fresh.map(g=>'<div class="ng"><div class="t"><span>'+esc(g.b)+'</span><small>'+esc(g.ad.slice(5).replace("-","/"))+' 上架・'+g.n+' 款</small></div>'+th(g.ks)+'<button data-go="'+esc(g.b)+'">去看看</button></div>').join("")+'</div>';
    if(r.restockCount)h+='<div class="nsec"><h3>🔁 再販商品</h3><div class="ng"><div class="t"><span>再販預定 '+r.restockCount+' 款</span></div><button data-q="再販">去看看</button></div></div>';
    $("#panel").innerHTML='<h2>商品動態<button class="x" id="nx">×</button></h2>'+(h||'<div class="empty">目前沒有新的動態喔</div>');
    $("#nx").onclick=()=>$("#sheet").classList.remove("on");
    $("#panel").querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{brand=b.dataset.go;$("#q").value="";document.querySelectorAll(".chip[data-b]").forEach(c=>c.classList.toggle("on",c.dataset.b===brand));filter();$("#sheet").classList.remove("on");scrollTo(0,0)});
    $("#panel").querySelectorAll("[data-q]").forEach(b=>b.onclick=()=>{brand="全部";$("#q").value=b.dataset.q;document.querySelectorAll(".chip[data-b]").forEach(c=>c.classList.toggle("on",c.dataset.b==="全部"));filter();$("#sheet").classList.remove("on");scrollTo(0,0)});
  }catch(e){$("#panel").querySelector(".empty").textContent="載入失敗，請稍後再試"}
}
const STC={"待付款":"s1","已回報匯款":"s2","已付款":"s2","已出貨":"s3","已取消":"s4"};
async function openOrders(){
  $("#panel").innerHTML='<h2>我的訂單<button class="x" id="ox">×</button></h2><div class="empty">載入中…</div>';$("#sheet").classList.add("on");$("#ox").onclick=()=>$("#sheet").classList.remove("on");
  try{const r=await fetch("/shop/orders?t="+encodeURIComponent(T)).then(r=>r.json());if(!r.ok)throw 0;
    const body=r.orders.length?r.orders.map(o=>'<div class="ord"><div class="hd"><span>'+esc(o.id)+'</span><span class="st '+(STC[o.status]||"")+'">'+esc(o.status)+'</span></div>'+
      '<div style="color:#6b6f75;font-size:12.5px">'+esc(o.at)+'｜'+o.qty+' 件｜'+esc(o.tier)+'價</div><div>合計 <b>'+fmt(o.total)+'</b></div>'+
      (o.paid5?'<div style="font-size:12.5px">匯款後五碼：'+esc(o.paid5)+'</div>':'')+(o.track?'<div style="font-size:12.5px">🚚 物流單號：<b>'+esc(o.track)+'</b></div>':'')+
      (o.status==="待付款"&&r.bank?'<div class="warn" style="margin-top:8px">💳 匯款資料<br>'+esc(r.bank).replace(/\\n/g,"<br>")+'<br>匯款後請在 LINE 回覆「後五碼 12345」</div>':'')+
      '<details><summary>查看明細與收件資料</summary><ul>'+o.lines.map(l=>'<li><span>'+esc(l.n)+' ×'+l.q+'</span><span>'+fmt(l.sub)+'</span></li>').join("")+'</ul>'+
      '<div style="font-size:12.5px;margin-top:6px;color:#444">收件人：'+esc(o.form.name)+'　'+esc(o.form.phone)+'<br>寄送：'+esc(o.form.ship)+'　'+esc(o.form.addr)+(o.form.note?'<br>備註：'+esc(o.form.note):'')+'</div></details></div>').join("")
      :'<div class="empty">還沒有訂單喔</div>';
    $("#panel").innerHTML='<h2>我的訂單<button class="x" id="ox">×</button></h2>'+body+'<p style="font-size:12px;color:#6b6f75;margin-top:12px;text-align:center">有問題直接在 LINE 跟我們說喔</p>';
    $("#ox").onclick=()=>$("#sheet").classList.remove("on");
  }catch(e){$("#panel").innerHTML='<h2>我的訂單<button class="x" onclick="sheet.classList.remove(\\'on\\')">×</button></h2><div class="empty">載入失敗，請稍後再試</div>'}
}
$("#sheet").onclick=e=>{if(e.target.id==="sheet")$("#sheet").classList.remove("on")};
let form={};try{form=JSON.parse(localStorage.getItem("zo_form")||"{}")}catch(e){}
function renderCart(){
  const L=lines();
  if(!L.length){$("#panel").innerHTML='<h2>購物車<button class="x" onclick="sheet.classList.remove(\\'on\\')">×</button></h2><div class="empty">還沒有商品喔</div>';return}
  const N=notes(L),total=L.reduce((a,l)=>a+l.sub,0),n=L.reduce((a,l)=>a+l.q,0);
  $("#panel").innerHTML='<h2>購物車<button class="x" id="cx">×</button></h2>'+
  L.map(({x,q,sub})=>'<div class="row" data-k="'+esc(x.k)+'">'+(x.img?'<img src="'+esc(x.img)+'">':'')+'<div class="t">'+esc(x.n)+'<br><small>'+fmt(price(x))+' × '+q+' = '+fmt(sub)+'</small></div>'+qtyBox(x,q)+'</div>').join("")+
  (N.length?'<div class="warn"><b>訂購規則提醒</b>（可以照樣送出，客服會再跟你確認）<br>'+N.map(esc).join("<br>")+'</div>':'')+
  '<div class="tot">共 '+L.length+' 款 '+n+' 件<br>合計 <b>'+fmt(total)+'</b>（'+esc(ME.tierName)+'價）<br><small style="color:#6b6f75">運費：'+(ME.tier==="vip"?"VIP 免運":"由客服確認後通知")+'</small></div>'+
  '<form id="of"><label>收件人姓名</label><input class="f" name="name" required value="'+esc(form.name||"")+'">'+
  '<label>手機號碼</label><input class="f" name="phone" type="tel" required value="'+esc(form.phone||"")+'">'+
  '<label>寄送方式</label><select class="f" name="ship" required>'+["7-11 店到店","全家店到店","萊爾富店到店","宅配","其他"].map(s=>'<option'+(form.ship===s?" selected":"")+'>'+s+'</option>').join("")+'</select>'+
  '<label>門市名稱／收件地址</label><input class="f" name="addr" required value="'+esc(form.addr||"")+'">'+
  '<label>備註（選填）</label><textarea class="f" name="note" rows="2"></textarea>'+
  '<button class="go" id="go">送出訂單</button></form>';
  $("#cx").onclick=()=>$("#sheet").classList.remove("on");
  $("#of").onsubmit=submit;
}
async function submit(e){
  e.preventDefault();const fd=Object.fromEntries(new FormData(e.target));form=fd;try{localStorage.setItem("zo_form",JSON.stringify({name:fd.name,phone:fd.phone,ship:fd.ship,addr:fd.addr}))}catch(_){}
  const btn=$("#go");btn.disabled=true;btn.textContent="送出中…";
  try{
    const r=await fetch("/shop/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:T,items:lines().map(l=>({k:l.x.k,q:l.q})),form:fd})}).then(r=>r.json());
    if(!r.ok)throw new Error(r.error||"送出失敗");
    cart={};save();bar();document.querySelectorAll(".qty").forEach(el=>{const c=el.closest(".card");if(c)el.outerHTML=qtyBox(byK(c.dataset.k),0)});
    $("#panel").innerHTML='<div class="done"><div style="font-size:44px">✅</div><h3>訂單已送出</h3><div>訂單編號 <b>'+esc(r.id)+'</b><br>共 '+r.qty+' 件　合計 <b>'+fmt(r.total)+'</b></div>'+
    (r.bank?'<pre>💳 匯款資料\\n'+esc(r.bank)+'\\n\\n匯款後請回到 LINE 回覆「後五碼 12345」</pre>':'<pre>我們確認庫存後，會在 LINE 傳匯款資料給你喔～</pre>')+
    (r.notes.length?'<div class="warn">'+r.notes.map(esc).join("<br>")+'<br>客服會再跟你確認數量</div>':'')+
    '<p style="margin-top:12px;color:#6b6f75;font-size:13px">訂單明細也已經傳到你的 LINE 囉</p><button class="go" style="width:100%;margin-top:14px" onclick="sheet.classList.remove(\\'on\\')">繼續逛</button></div>';
  }catch(err){btn.disabled=false;btn.textContent="送出訂單";alert(err.message)}
}
init();
</script></body></html>`;

// ---------- LINE 商品目錄：先選系列 → 再選角色 → 傳商品圖片卡 ----------
const CATS = [
  { k: "吉伊卡哇", w: ["吉伊卡哇", "ちいかわ", "chiikawa"], subs: [
    ["吉伊", ["(吉伊)", "（吉伊）", "ちいかわ）", "ちいかわ)", "$ 吉伊卡哇", "$ 吉伊"]], ["小八", ["小八", "ハチワレ"]], ["烏薩奇", ["烏薩奇", "兔兔", "うさぎ"]],
    ["飛鼠小桃", ["飛鼠", "小桃", "モモンガ"]], ["栗子饅頭", ["栗子饅頭", "くりまんじゅう"]], ["海獺", ["海獺", "ラッコ"]]] },
  { k: "三麗鷗", w: ["三麗鷗", "サンリオ", "sanrio", "hello kitty", "凱蒂貓", "美樂蒂", "酷洛米", "大耳狗", "布丁狗", "帕恰狗", "酷企鵝", "雙子星", "人魚漢頓"], subs: [
    ["Hello Kitty", ["hello kitty", "凱蒂貓", "キティ", "kt"]], ["美樂蒂", ["美樂蒂", "マイメロ"]], ["酷洛米", ["酷洛米", "クロミ"]],
    ["大耳狗", ["大耳狗", "シナモ"]], ["布丁狗", ["布丁狗", "ポムポムプリン"]], ["帕恰狗", ["帕恰狗", "ポチャッコ"]],
    ["酷企鵝", ["酷企鵝", "ばつ丸"]], ["雙子星", ["雙子星", "キキララ", "リトルツインスターズ"]], ["人魚漢頓", ["人魚漢頓", "漢頓", "ハンギョドン"]]] },
  { k: "史努比", w: ["史努比", "スヌーピー", "peanuts", "snoopy"], subs: [["史努比", ["史努比", "スヌーピー", "snoopy"]], ["糊塗塔克", ["糊塗塔克", "糊塗塌客", "塔克", "ウッドストック", "woodstock"]]] },
  { k: "拉拉熊", w: ["拉拉熊", "懶懶熊", "リラックマ", "rilakkuma"] },
  { k: "角落生物", w: ["角落生物", "すみっコ"] },
  { k: "mofusand", w: ["mofusand"] },
  { k: "塔麻可吉", w: ["塔麻可吉", "たまごっち", "tamagotchi"] },
  { k: "嚕嚕米", w: ["嚕嚕米", "ムーミン", "moomin"] },
  { k: "寶可夢", w: ["寶可夢", "ポケモン", "皮卡丘", "pokemon"] },
  { k: "哆啦A夢", w: ["哆啦a夢", "ドラえもん"] },
  { k: "動漫角色", w: ["鬼滅", "咒術", "排球", "航海王", "七龍珠", "柯南", "鋼彈", "膽大黨", "火影"], subs: [
    ["鬼滅之刃", ["鬼滅"]], ["咒術回戰", ["咒術"]], ["排球少年", ["排球"]], ["航海王", ["航海王", "ワンピース"]],
    ["七龍珠", ["七龍珠", "ドラゴンボール"]], ["名偵探柯南", ["柯南", "コナン"]], ["鋼彈", ["鋼彈", "ガンダム"]], ["膽大黨", ["膽大黨", "ダンダダン"]]] },
  { k: "捏捏療癒小物", w: ["捏捏", "スクイーズ", "squeeze", "crux"] },
];
const qr = (labels) => ({ items: labels.slice(0, 13).map(([label, text]) => ({ type: "action", action: { type: "message", label: label.slice(0, 20), text } })) });
const hay = (it) => ((it.n || "") + " " + (it.ja || "") + " " + (it.b || "") + " " + (it.s || "")).toLowerCase();
function pickItems(items, words, isExpired, catWords) {
  const ws = words.map((w) => w.toLowerCase()), cs = (catWords || []).map((w) => w.toLowerCase());
  const hits = items.filter((it) => { if (!it.g || !it.img || isExpired(it) || /缺貨|停售/.test(it.st || "")) return false;
    const h = hay(it), nm = (it.n || "").toLowerCase(); return ws.some((w) => (w[0] === "$" ? nm.endsWith(w.slice(1)) : h.includes(w))) && (!cs.length || cs.some((w) => h.includes(w))); });
  hits.sort((a, b) => (b.ad || "").localeCompare(a.ad || "") || (/有貨|◎/.test(b.st || "") - /有貨|◎/.test(a.st || "")));
  const seen = new Set(), out = [];
  for (const it of hits) { if (seen.has(it.img)) continue; seen.add(it.img); out.push(it); }
  return { total: hits.length, list: out };
}
function bubble(it, tier, link) {
  const price = tier === "vip" ? `VIP NT$${it.v}` : `NT$${it.g}`;
  const sub = tier === "vip" ? `一般 NT$${it.g}` : `VIP 會員 NT$${it.v}`;
  const note = [packN(it) ? `整盒 ${packN(it)} 個・只能整盒訂` : "", it.dl ? `截單 ${it.dl.split("（")[0]}` : "", /庫存較少|洽詢/.test(it.st || "") ? (it.st || "").replace(/^.*・/, "") : ""].filter(Boolean).join("｜");
  const body = [
    { type: "text", text: (it.b || "").slice(0, 40), size: "xxs", color: "#888888" },
    { type: "text", text: it.n.slice(0, 80), size: "sm", weight: "bold", wrap: true, maxLines: 3 },
    { type: "text", text: price + (packN(it) ? " ／個" : ""), size: "lg", weight: "bold", color: "#9E1B1B", margin: "sm" },
    { type: "text", text: sub, size: "xxs", color: "#888888" },
  ];
  if (note) body.push({ type: "text", text: note.slice(0, 60), size: "xxs", color: "#9E1B1B", wrap: true });
  return { type: "bubble", size: "kilo",
    hero: { type: "image", url: it.th || it.img, size: "full", aspectRatio: "1:1", aspectMode: "fit", backgroundColor: "#F6F6F7" },
    body: { type: "box", layout: "vertical", spacing: "xs", contents: body },
    footer: { type: "box", layout: "vertical", contents: [{ type: "button", style: "primary", color: "#161616", height: "sm",
      action: { type: "uri", label: "我要訂購", uri: `${link}&q=${encodeURIComponent(it.jan || it.code || it.n.slice(0, 30))}` } }] } };
}
function moreBubble(title, total, link, q) {
  return { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", justifyContent: "center", spacing: "md", backgroundColor: "#161616", contents: [
    { type: "text", text: title, color: "#FFFFFF", weight: "bold", size: "lg", wrap: true, align: "center" },
    { type: "text", text: `共 ${total} 款`, color: "#C9CCD0", size: "sm", align: "center" },
    { type: "button", style: "secondary", color: "#FFFFFF", height: "sm", action: { type: "uri", label: "看全部商品", uri: `${link}&q=${encodeURIComponent(q)}` } }] } };
}
export async function catalogMenu(env, deps, uid, text) {
  const t = text.trim();
  if (!/^(商品目錄|目錄)(\s.*)?$/.test(t)) return null;
  const parts = t.split(/\s+/).slice(1);
  const link = await shopLink(env, uid);
  if (!parts.length) {
    return [{ type: "text", text: "請問想找哪個系列的商品呢？👇\n點下面的按鈕選擇，我會把商品圖片傳給您～\n\n想直接看全部商品：\n" + link,
      quickReply: qr(CATS.map((c) => [c.k, "目錄 " + c.k])) }];
  }
  const cat = CATS.find((c) => c.k === parts[0]);
  if (!cat) return [{ type: "text", text: "找不到這個系列耶😂 請點下面的按鈕選擇～", quickReply: qr(CATS.map((c) => [c.k, "目錄 " + c.k])) }];
  const subName = parts.slice(1).join(" ");
  if (cat.subs && !subName) {
    return [{ type: "text", text: `${cat.k}想看哪個角色呢？👇`, quickReply: qr([...cat.subs.map(([n]) => [n, `目錄 ${cat.k} ${n}`]), [`全部${cat.k}`.slice(0, 20), `目錄 ${cat.k} 全部`], ["← 其他系列", "商品目錄"]]) }];
  }
  const sub = cat.subs && subName !== "全部" ? cat.subs.find(([n]) => n === subName) : null;
  const words = sub ? sub[1] : cat.w;
  const title = sub ? `${cat.k}・${sub[0]}` : cat.k;
  const items = await deps.loadCatalog(env);
  const { total, list } = pickItems(items, words, deps.isExpired, sub ? cat.w : null);
  const tier = await getTier(env, uid);
  const back = cat.subs ? [...cat.subs.filter(([n]) => n !== subName).map(([n]) => [n, `目錄 ${cat.k} ${n}`]), ["← 其他系列", "商品目錄"]] : CATS.map((c) => [c.k, "目錄 " + c.k]);
  if (!list.length) return [{ type: "text", text: `${title}目前沒有可以訂購的商品喔😂\n可以看看其他系列～`, quickReply: qr(back) }];
  const bubbles = list.slice(0, 11).map((it) => bubble(it, tier, link));
  bubbles.push(moreBubble(title, total, link, sub ? sub[0] : cat.k));
  return [
    { type: "flex", altText: `${title}商品目錄（共 ${total} 款）`, contents: { type: "carousel", contents: bubbles } },
    { type: "text", text: `以上是${title}的熱門商品（共 ${total} 款）👆\n左右滑動看更多，點「我要訂購」可以直接下單喔～\n${tier === "vip" ? "已套用您的 VIP 價" : "VIP 會員每件再便宜 NT$30"}`, quickReply: qr(back) },
  ];
}

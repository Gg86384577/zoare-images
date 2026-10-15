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
  if (!env.SESSIONS) return "none";
  const t = (await env.SESSIONS.get("tier:" + uid)) || "none";
  if (t === "none") return t;
  const until = Number(await env.SESSIONS.get("tx:" + uid)) || 0;
  if (until && until < Date.now()) return "none"; // 到期就停止
  return t;
}
// ---------- 會員期限 ----------
// 期限算到到期日當天 23:59（台灣時間）；預設 1 個月
const TW = 8 * 3600e3;
export function fmtDay(ms) { const d = new Date(ms + TW); return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`; }
function addPeriod(fromMs, { months = 0, days = 0 }) {
  const d = new Date(fromMs + TW);
  const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last) + days);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59) - TW;
}
export async function memberInfo(env, uid) {
  const tier = await getTier(env, uid);
  const until = tier === "none" ? 0 : Number(await env.SESSIONS.get("tx:" + uid)) || 0;
  return { tier, until, days: until ? Math.max(0, Math.ceil((until - Date.now()) / 86400e3)) : null };
}
// 設定會員：period = {months, days} 或 {until: ms}；extend=true 時同等級還沒到期就從原到期日往後加
export async function setMembership(env, uid, tier, period = { months: 1 }, extend = true) {
  if (tier !== "vip" && tier !== "member") { await env.SESSIONS.delete("tier:" + uid); await env.SESSIONS.delete("tx:" + uid); return { tier: "none", until: 0 }; }
  const cur = await memberInfo(env, uid);
  let until;
  if (period.until) until = period.until;
  else {
    const base = extend && cur.tier === tier && cur.until > Date.now() ? cur.until : Date.now();
    until = addPeriod(base, period);
  }
  const ttl = Math.max(120, Math.ceil((until - Date.now()) / 1000) + 7 * 86400);
  await env.SESSIONS.put("tier:" + uid, tier, { expirationTtl: ttl });
  await env.SESSIONS.put("tx:" + uid, String(until), { expirationTtl: ttl });
  await env.SESSIONS.delete("txr:" + uid);
  return { tier, until };
}
export function parsePeriod(str) {
  const s = String(str || "");
  let m = s.match(/(\d+)\s*(?:個)?(?:多)?月/); if (m) return { months: +m[1] };
  m = s.match(/(\d+)\s*(?:天|日)/); if (m) return { days: +m[1] };
  m = s.match(/(\d+)\s*(?:週|周|星期)/); if (m) return { days: 7 * +m[1] };
  m = s.match(/(\d+)\s*年/); if (m) return { months: 12 * +m[1] };
  m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})/);
  if (m) { const y = m[1] ? +m[1] : new Date(Date.now() + TW).getUTCFullYear(); const mo = +(m[2] || m[4]), d = +(m[3] || m[5]);
    let until = Date.UTC(y, mo - 1, d, 23, 59, 59) - TW; if (!m[1] && until < Date.now()) until = Date.UTC(y + 1, mo - 1, d, 23, 59, 59) - TW; return { until }; }
  return null;
}

// ---------- 目錄（精簡版給網頁） ----------
const keyOf = (it) => (it.b || "") + "|" + (it.code || it.jan || it.n);
// 起批數：型錄的最低訂購量；沒寫的話用入數（例如「入数(インナー) 36 (2)」→ 36，取前面的數字）
function moqOf(it) {
  if (Number(it.moq)) return Number(it.moq);
  const m = /盲盒/.test(it.pack || "") ? null : (it.pack || "").match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
function packN(it) {
  const m = (it.pack || "").match(/(?:整盒|整箱)\s*(\d+)\s*個/);
  return m ? Number(m[1]) : 0;
}
let SLIM = null, SLIM_SRC = null;
const MEMBER_ITEMS = [
  { k: "MEMBER|VIP", n: "VIP 會員（月費）國際＋國內運費全免・VIP 專屬價", b: "ZOARÉ 會員方案", s: "", g: 1000, v: 1000, img: "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/member_vip.jpg", moq: 0, box: 0, pk: "", st: "", sh: "", dl: "", jan: "", ad: "", c: ["會員方案"], mem: "vip" },
  { k: "MEMBER|GEN", n: "一般會員（月費）只免國際運費", b: "ZOARÉ 會員方案", s: "", g: 100, v: 100, img: "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/member_gen.jpg", moq: 0, box: 0, pk: "", st: "", sh: "", dl: "", jan: "", ad: "", c: ["會員方案"], mem: "member" },
];
// 網站多加的分類（LINE 選單按鈕有上限，不放這些）
const WEB_CATS = [
  { k: "蠟筆小新", w: ["蠟筆小新", "小新", "クレヨンしんちゃん"] }, { k: "Pickles 小青蛙", w: ["pickle", "ピクルス"] },
  { k: "夢奇奇", w: ["夢奇奇", "モンチッチ", "monchhichi"] }, { k: "Smiski", w: ["smiski", "スミスキー"] },
  { k: "好奇猴喬治", w: ["喬治", "おさるのジョージ"] }, { k: "好餓的毛毛蟲", w: ["毛毛蟲", "はらぺこあおむし"] },
  { k: "彼得兔", w: ["彼得兔", "ピーターラビット"] }, { k: "什麼都是生物", w: ["什麼都是生物"] },
  { k: "迪士尼", w: ["迪士尼", "ディズニー", "disney", "史迪奇", "小熊維尼", "玩具總動員", "動物方城市"] },
  { k: "湯姆貓與傑利鼠", w: ["湯姆貓", "傑利鼠", "トムとジェリー", "とむとじぇりー", "tom and jerry"] },
  { k: "飛天小女警", w: ["飛天小女警", "パワーパフ", "パワパフ", "powerpuff"] },
  { k: "玩偶小狗斯斯", w: ["斯斯", "スンスン", "パペットスンスン"] },
  { k: "米飛兔", w: ["米飛兔", "米菲", "ミッフィー", "miffy"] },
  { k: "星之卡比", w: ["卡比", "カービィ", "kirby"] },
  { k: "麵包小偷", w: ["麵包小偷", "パンどろぼう"] },
  { k: "海綿寶寶", w: ["海綿寶寶", "スポンジ・ボブ", "スポンジボブ", "spongebob"] },
  { k: "粉紅兔兔", w: ["粉紅兔兔", "おぱんちゅうさぎ"] },
  { k: "彩虹熊", w: ["彩虹熊", "ケアベア", "care bears"] },
  { k: "艾斯特兔", w: ["艾斯特兔", "エスターバニー"] },
  { k: "憂傷熊", w: ["憂傷熊", "グルーミー"] },
  { k: "Suzy's Zoo", w: ["suzy's zoo", "スージー・ズー"] },
  { k: "Studio UG", w: ["studio ug", "スタジオｕｇ"] },
  { k: "小海豹", w: ["小海豹", "ゴマちゃん", "アシベ"] },
  { k: "企鵝家族", w: ["企鵝家族", "ピングー", "pingu"] },
  { k: "貓咪大戰爭", w: ["貓咪大戰爭", "にゃんこ大戦争"] },
  { k: "小矮人圖鑑", w: ["小矮人圖鑑", "こびとづかん"] },
  { k: "櫻桃小丸子", w: ["櫻桃小丸子", "小丸子", "まる子", "ちびまる子"] },
];
function catsOf(it) {
  const h = ((it.n || "") + " " + (it.ja || "") + " " + (it.b || "") + " " + (it.s || "")).toLowerCase();
  const out = CATS.concat(WEB_CATS).filter((c) => c.w.some((w) => h.includes(w.toLowerCase()))).map((c) => c.k);
  return out.length ? out : ["其他"];
}
// 結單日顯示：有日期 → 「結單 10/31 23:59」；文字規則（每週日…）照寫；都沒有 → 長期接單
export function dlLabel(it) {
  const d = it.dlx || it.dl || "";
  const m = d.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}:\d{2}))?/);
  if (m) {
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const ds = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    const tm = m[4] || "23:59";
    const tmr = new Date(Date.now() + 32 * 3600e3).toISOString().slice(0, 10);
    if (ds === today) return `今天 ${tm} 結單！要訂請把握`;
    if (ds === tmr) return `明天 ${tm} 結單`;
    return `結單日 ${+m[2]}/${+m[3]}${m[4] && m[4] !== "23:59" ? " " + m[4] : ""}`;
  }
  if (d) return "結單日 " + d.split("（")[0];
  return "結單日 長期接單";
}
function slim(items, isExpired) {
  if (SLIM && SLIM_SRC === items) return SLIM;
  const out = [];
  for (const it of items) {
    if (!it.g || isExpired(it)) continue;
    if (it.st && /缺貨|停售/.test(it.st)) continue;
    out.push({ k: keyOf(it), n: it.n, b: it.b || "其他", s: it.s || "", g: it.g, v: it.v || it.g, img: it.img || "",
      moq: moqOf(it), box: packN(it), pk: it.pack || "", st: it.st || "", sh: it.ship || "", dl: it.dlx || it.dl || "", jan: it.jan || it.code || "", ad: it.ad || "", c: catsOf(it) });
  }
  out.push(...MEMBER_ITEMS);
  SLIM = out; SLIM_SRC = items;
  return out;
}

// ---------- 訂購規則（只提醒，不擋） ----------
// 起批數：會員＝照每款商品的起批數（整盒商品＝整盒數量；型錄沒寫的預設 3 件）；
// 非會員＝單款 21 件起，商品起批數比 21 大就照商品（整盒商品湊成整盒倍數）
export function minQty(x, tier) {
  if (x.mem) return 1;
  const own = Number(x.box) || Number(x.moq) || 0;
  if (tier !== "none") return own || 3;
  const m = Math.max(21, own);
  return x.box ? Math.ceil(m / x.box) * x.box : m;
}
export function ruleNotes(lines, tier) {
  const notes = [];
  const total = lines.filter((l) => !l.mem).reduce((a, l) => a + l.q, 0);
  for (const l of lines) {
    if (l.mem) continue;
    const mq = minQty(l, tier);
    if (l.box && l.q % l.box) notes.push(`${l.n}：盲盒／整箱商品請以 ${l.box} 的倍數訂購`);
    else if (l.q < mq) notes.push(`${l.n}：${tier === "none" ? "非會員" : "會員"}這款 ${mq} 件起`);
  }
  if (tier !== "none" && total > 0 && total < 21) notes.push(`會員混批合計需 21 件起（目前 ${total} 件）`);
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
  if (n.dlGroups.length) parts.push("⏰ 即將結單\n" + n.dlGroups.slice(0, 5).map((g) => `・${g.b}（${g.items.length} 款）結單日 ${g.dl.split("（")[0]}`).join("\n"));
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
    const mi = await memberInfo(env, uid);
    return Response.json({ ok: true, name: await deps.displayName(env, uid), tier, tierName: TIER_NAME[tier], until: mi.until ? fmtDay(mi.until) : "", days: mi.days });
  }
  if (p === "/shop/orders") {
    const uid = await verifyToken(env, url.searchParams.get("t"));
    if (!uid) return Response.json({ ok: false, error: "連結無效" }, { status: 401 });
    const list = await myOrders(env, uid, 20);
    return Response.json({ ok: true, orders: list.map((o) => ({ id: o.id, at: o.at, status: o.status, paid5: o.paid5 || "", track: o.track || "", pay: o.form.pay || "轉帳",
      total: o.total, qty: o.qty, tier: TIER_NAME[o.tier], lines: o.lines.map((l) => ({ n: l.n, q: l.q, price: l.price, sub: l.sub })), form: o.form })),
      bank: (await env.SESSIONS.get("bank")) || "", linepay: (await env.SESSIONS.get("linepay")) || "" });
  }
  if (p === "/shop/order" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return Response.json({ ok: false, error: "資料格式錯誤" }, { status: 400 }); }
    const uid = await verifyToken(env, body.t);
    if (!uid) return Response.json({ ok: false, error: "連結無效，請回到 LINE 重新點訂購連結" }, { status: 401 });
    const prevTier = await getTier(env, uid);
    // 購物車有會員方案 → 下單當下自動升級（只升不降），這張訂單直接用新等級的價格
    const its = body.items || [];
    const wantMem = its.some((r) => r.k === "MEMBER|VIP" && r.q > 0) ? "vip" : its.some((r) => r.k === "MEMBER|GEN" && r.q > 0) ? "member" : "";
    const tier = wantMem === "vip" || (wantMem === "member" && prevTier === "none") ? wantMem : prevTier;
    const map = new Map(slim(await deps.loadCatalog(env), deps.isExpired).map((x) => [x.k, x]));
    const lines = [];
    for (const r of (body.items || []).slice(0, 300)) {
      const it = map.get(r.k);
      const q = Math.floor(Number(r.q));
      if (!it || !(q > 0) || q > 100000) continue;
      const price = tier === "vip" ? it.v : it.g;
      lines.push({ k: it.k, n: it.n, b: it.b, jan: it.jan, q, price, cost: it.mem ? 0 : it.g - 80, sub: price * q, box: it.box, moq: it.moq, mem: it.mem || "" });
    }
    if (!lines.length) return Response.json({ ok: false, error: "購物車是空的，或商品已下架" }, { status: 400 });
    const f = body.form || {};
    const clean = (s, n = 100) => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
    const form = { name: clean(f.name, 40), phone: clean(f.phone, 20), ship: clean(f.ship, 20), addr: clean(f.addr, 150), note: clean(f.note, 300), pay: f.pay === "LINE Pay" ? "LINE Pay" : "轉帳" };
    if (!form.name || !form.phone || !form.ship || !form.addr) return Response.json({ ok: false, error: "請填寫收件人、電話、寄送方式與門市／地址" }, { status: 400 });
    const total = lines.reduce((a, l) => a + l.sub, 0);
    const qty = lines.reduce((a, l) => a + l.q, 0);
    const d = new Date(Date.now() + 8 * 3600e3);
    const id = "ZO" + d.toISOString().slice(2, 10).replace(/-/g, "") + Math.random().toString(36).slice(2, 6).toUpperCase();
    const notes = ruleNotes(lines, tier);
    const lineName = await deps.displayName(env, uid);
    const order = { id, uid, lineName, tier, lines, total, qty, form, notes, status: "待付款", at: d.toISOString().slice(0, 16).replace("T", " ") };
    if (wantMem) {
      const pi = await memberInfo(env, uid);
      order.memGranted = wantMem; order.prevTier = prevTier; order.prevUntil = pi.until;
      if (wantMem === tier) { const r = await setMembership(env, uid, tier, { months: 1 }); order.memUntil = r.until; }
    }
    const bank = await payInfo(env, form.pay);
    await env.SESSIONS.put("o:" + id, JSON.stringify(order), { expirationTtl: 180 * 86400 });
    await env.SESSIONS.put("ol:" + uid, id, { expirationTtl: 30 * 86400 });
    const mine = JSON.parse((await env.SESSIONS.get("ou:" + uid)) || "[]");
    mine.unshift(id); await env.SESSIONS.put("ou:" + uid, JSON.stringify(mine.slice(0, 50)));
    // 訂單索引（老闆查「訂單」用）
    const idx = JSON.parse((await env.SESSIONS.get("orders")) || "[]");
    idx.unshift(id); await env.SESSIONS.put("orders", JSON.stringify(idx.slice(0, 200)));
    ctx.waitUntil(notifyOrder(env, deps, order, bank));
    return Response.json({ ok: true, id, total, qty, notes, bank, tierName: TIER_NAME[tier], upgraded: tier !== prevTier });
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
  const lemai = "";
  if (!list.length) return `目前沒有線上訂購網站的訂單紀錄喔${lemai}\n\n🛒 線上訂購：${link}`;
  const rows = list.map((o) => `📦 ${o.id}（${o.at.slice(0, 10)}）\n${o.qty} 件　NT$${o.total.toLocaleString()}　${o.form.pay || "轉帳"}　狀態：${o.status}${o.track ? "\n物流單號：" + o.track : ""}`);
  return `您最近的訂單：\n\n${rows.join("\n\n")}\n\n要看完整明細，請點：\n${link}&v=orders\n（或傳訂單編號給我）${lemai}`;
}
export async function customerOrderDetail(env, uid, id) {
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o || o.uid !== uid) return null;
  return `訂單 ${o.id}（${o.at}）\n狀態：${o.status}${o.paid5 ? "　後五碼 " + o.paid5 : ""}${o.track ? "\n物流單號：" + o.track : ""}\n\n${orderText(o, false)}\n\n收件人：${o.form.name}\n寄送：${o.form.ship}　${o.form.addr}`;
}
async function payInfo(env, pay) {
  return (await env.SESSIONS.get(pay === "LINE Pay" ? "linepay" : "bank")) || "";
}
const payHow = (pay) => pay === "LINE Pay" ? "付款後請回到 LINE 傳「付款截圖」給我們" : "轉帳後請回到 LINE 傳「後五碼」和「轉帳截圖」給我們";
function orderText(o, withRules = true) {
  const items = o.lines.map((l) => `・${l.n} ×${l.q}　NT$${l.sub.toLocaleString()}`).join("\n");
  return `訂單編號：${o.id}\n${items}\n\n共 ${o.qty} 件　合計 NT$${o.total.toLocaleString()}（${TIER_NAME[o.tier]}價）\n運費：${o.tier === "vip" ? "VIP 免運" : "由客服確認後通知"}` +
    `\n付款方式：${o.form.pay || "轉帳"}` +
    (withRules && o.notes.length ? `\n\n⚠️ 訂購規則提醒：\n${o.notes.slice(0, 8).map((n) => "・" + n).join("\n")}` : "");
}
async function notifyOrder(env, deps, o, bank) {
  try {
    const owner = await env.SESSIONS.get("owner");
    if (owner) {
      await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text:
        `🛒 新訂單！\n客人：${o.lineName}（${TIER_NAME[o.tier]}${o.memGranted && o.prevTier !== o.tier ? `，下單會員方案已自動從${TIER_NAME[o.prevTier]}升級` : ""}）\n${orderText(o)}\n\n收件人：${o.form.name}\n電話：${o.form.phone}\n寄送：${o.form.ship}　${o.form.addr}` +
        (o.form.note ? `\n備註：${o.form.note}` : "") }] });
    }
    await deps.lineApi(env, "/v2/bot/message/push", { to: o.uid, messages: [{ type: "text", text:
      `謝謝您的訂購🙏 我們已收到訂單囉\n\n${orderText(o, false)}\n\n` +
      (o.memGranted && o.prevTier !== o.tier ? `🎉 您已升級為${TIER_NAME[o.tier]}！這張訂單已套用會員價，之後下單也會自動用會員價（請在 3 天內完成付款，取消訂單會恢復原本等級）\n\n` : "") +
      (bank ? `💳 ${o.form.pay === "LINE Pay" ? "LINE Pay 付款資料" : "轉帳資料"}：\n${bank}\n\n${payHow(o.form.pay)}，系統會自動幫您對帳喔～` : "我們確認庫存後會再傳付款資料給您～") }] });
  } catch (e) { console.log("order notify failed", e); }
}

// 客人回報匯款後五碼
export async function handlePayment(env, deps, uid, text) {
  const m = text.match(/^(?:後五碼|末五碼|帳號後五碼)?\s*[:：]?\s*(\d{5})$/);
  if (!m) return null;
  const id = await env.SESSIONS.get("ol:" + uid);
  if (!id) return null;
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o || !["待付款", "已回報匯款", "待確認"].includes(o.status)) return null;
  if (o.status === "待付款") o.status = "已回報匯款";
  o.paid5 = m[1];
  await env.SESSIONS.put("o:" + id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
  return `收到後五碼 ${m[1]}👌（訂單 ${o.id}）\n${o.payShot ? "截圖也收到了，我們核對後會通知您～" : "請再傳「轉帳截圖」給我，系統核對金額和帳號後就完成囉～"}`;
}

// ---------- 付款截圖自動對帳 ----------
const digits = (s) => String(s || "").replace(/[^0-9]/g, "");
async function pendingOrder(env, uid) {
  const ids = JSON.parse((await env.SESSIONS.get("ou:" + uid)) || "[]").slice(0, 5);
  for (const id of ids) {
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (o && ["待付款", "已回報匯款", "待確認"].includes(o.status)) return o;
  }
  return null;
}
export async function verifyPaymentImage(env, deps, uid, img) {
  const o = await pendingOrder(env, uid);
  if (!o) return null;
  const out = await deps.claude(env,
    "你是付款截圖辨識助手。判斷圖片是不是銀行轉帳／ATM／網銀／LINE Pay 的付款成功截圖。只輸出 JSON：" +
    '{"is_payment":true/false,"method":"bank 或 linepay","amount":轉出金額數字(新台幣，沒有就0),"to_account":"轉入帳號（照圖片寫，含*號）","to_bank":"轉入銀行","to_name":"收款人名稱或 LINE Pay 對象","from_last5":"轉出帳號後五碼（看得到才填）","time":"交易時間","success":true/false}',
    [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text: "請辨識這張圖" }] }], 400);
  let r; try { r = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch (e) { return null; }
  if (!r.is_payment) return null;
  const bank = (await env.SESSIONS.get("bank")) || "", lp = (await env.SESSIONS.get("linepay")) || "";
  const amountOk = Number(r.amount) === o.total;
  let toOk = false, why = [];
  if (r.method === "linepay") {
    const nm = String(r.to_name || "").replace(/\s/g, "");
    // 收款人名字可以用 O／○／＊ 遮字，例如「張O森」可以對到「張晉森」
    const cands = lp.split("\n").filter((ln) => !/https?:|連結|ID/i.test(ln)).join("、").split(/[／、,，|｜]+/).map((x) => x.replace(/^.*[:：]/, "").replace(/\s/g, "")).filter((x) => x.length >= 2);
    toOk = !!nm && cands.some((c) => { const re = new RegExp("^" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*|[O○〇＊xX]/g, ".") + "$"); return re.test(nm) || nm.includes(c) || c.includes(nm); });
    if (!toOk) why.push(`收款對象「${r.to_name || "看不到"}」跟你的 LINE Pay 資料對不起來`);
  } else {
    const acct = (bank.match(/[0-9][0-9\-\s]{7,}[0-9]/g) || []).map(digits).sort((a, b) => b.length - a.length)[0] || "";
    const vis = digits(String(r.to_account || "").split(/[*＊xX•●]+/).pop());
    toOk = !!acct && vis.length >= 3 && acct.endsWith(vis);
    if (!toOk) why.push(`轉入帳號「${r.to_account || "看不到"}」跟你的帳號對不起來`);
  }
  if (r.success === false) why.push("截圖看起來不是交易成功畫面");
  if (!amountOk) why.push(`金額 NT$${Number(r.amount || 0).toLocaleString()} 跟訂單 NT$${o.total.toLocaleString()} 不一樣`);
  const ok = amountOk && toOk && r.success !== false;
  o.payShot = true;
  o.payInfo = { method: r.method === "linepay" ? "LINE Pay" : "轉帳", amount: Number(r.amount) || 0, to: r.to_account || r.to_name || "", from5: r.from_last5 || o.paid5 || "", time: r.time || "" };
  if (r.from_last5 && !o.paid5) o.paid5 = digits(r.from_last5).slice(-5);
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  if (ok) { o.status = "已付款"; o.paidAt = now; } else o.status = "待確認";
  await env.SESSIONS.put("o:" + o.id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
  // 有買會員方案 → 自動開通（35 天，下個月沒續繳就自動失效）
  let memMsg = "";
  if (ok) {
    const mem = o.lines.find((l) => l.mem === "vip") ? "vip" : o.lines.find((l) => l.mem === "member") ? "member" : "";
    if (mem) {
      const info = o.memUntil && (await getTier(env, uid)) === mem ? { until: o.memUntil } : await setMembership(env, uid, mem, { months: 1 });
      o.memUntil = info.until; await env.SESSIONS.put("o:" + o.id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
      memMsg = `\n🎉 ${TIER_NAME[mem]}已開通，有效到 ${fmtDay(info.until)}，訂購網站會自動套用會員價～`;
    }
  }
  const owner = await env.SESSIONS.get("owner");
  if (owner) await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: ok
    ? `✅ 自動對帳成功\n客人：${o.lineName}\n訂單：${o.id}　NT$${o.total.toLocaleString()}\n${o.payInfo.method}　${o.payInfo.to}${o.paid5 ? "\n後五碼：" + o.paid5 : ""}\n已自動改成「已付款」${memMsg ? "\n（會員已自動開通）" : ""}`
    : `⚠️ 付款截圖對不上，請人工確認\n客人：${o.lineName}\n訂單：${o.id}　NT$${o.total.toLocaleString()}\n${why.join("\n")}\n\n確認沒問題請傳「${o.id} 已付款」` }] });
  return ok
    ? `✅ 付款確認成功！謝謝您🙏\n訂單 ${o.id}　NT$${o.total.toLocaleString()}\n我們會盡快幫您安排出貨～${memMsg}`
    : `收到您的付款截圖了👌（訂單 ${o.id}）\n系統自動核對時有些地方對不上，已經請專人確認，確認後會馬上通知您～`;
}

// ---------- 收款統計 ----------
async function payStats(env) {
  const ids = JSON.parse((await env.SESSIONS.get("orders")) || "[]");
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), month = today.slice(0, 7);
  const S = () => ({ n: 0, amt: 0 });
  const st = { today: { 轉帳: S(), "LINE Pay": S() }, month: { 轉帳: S(), "LINE Pay": S() }, wait: S(), check: S(), ship: S() };
  for (const id of ids) {
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (!o) continue;
    const m = (o.payInfo && o.payInfo.method) || o.form.pay || "轉帳";
    if (o.status === "已付款" || o.status === "已出貨") {
      const d = o.paidAt || o.at;
      if (d.startsWith(month)) { st.month[m].n++; st.month[m].amt += o.total; }
      if (d.startsWith(today)) { st.today[m].n++; st.today[m].amt += o.total; }
      if (o.status === "已付款") { st.ship.n++; st.ship.amt += o.total; }
    } else if (o.status === "待付款" || o.status === "已回報匯款") { st.wait.n++; st.wait.amt += o.total; }
    else if (o.status === "待確認") { st.check.n++; st.check.amt += o.total; }
  }
  const f = (x) => `${x.n} 筆　NT$${x.amt.toLocaleString()}`;
  const sum = (o) => ({ n: o["轉帳"].n + o["LINE Pay"].n, amt: o["轉帳"].amt + o["LINE Pay"].amt });
  return `📊 收款統計\n\n【今天 ${today.slice(5).replace("-", "/")}】\n轉帳：${f(st.today["轉帳"])}\nLINE Pay：${f(st.today["LINE Pay"])}\n合計：${f(sum(st.today))}\n\n【本月 ${month.slice(5)} 月】\n轉帳：${f(st.month["轉帳"])}\nLINE Pay：${f(st.month["LINE Pay"])}\n合計：${f(sum(st.month))}\n\n⏳ 等待付款：${f(st.wait)}\n⚠️ 截圖待人工確認：${f(st.check)}\n📦 已付款待出貨：${f(st.ship)}`;
}

// 老闆指令：訂單列表／單筆查詢／匯款資料
export async function shopOwnerCommand(env, text, deps = {}) {
  const t = text.trim();
  const om2 = await ownerOrders(env, t, deps);
  if (om2) return om2;
  if (/^(收款統計|統計|營收|收款)$/.test(t)) return await payStats(env);
  const lpm = t.match(/^(?:LINE\s?Pay|linepay|LinePay)資料[\s:：]*([\s\S]*)$/i);
  if (lpm) {
    if (!lpm[1].trim()) { const cur = await env.SESSIONS.get("linepay"); return cur ? `目前的 LINE Pay 資料：\n${cur}` : "還沒設定 LINE Pay 資料喔\n請傳：\nLINE Pay資料\n收款人：○○○（要跟付款截圖上顯示的名字一樣）\nLINE ID 或收款連結：○○○"; }
    await env.SESSIONS.put("linepay", lpm[1].trim().slice(0, 500));
    return `好👌 LINE Pay 資料已更新，客人選 LINE Pay 時會看到：\n${lpm[1].trim()}\n\n⚠️ 自動對帳會比對截圖上的「收款人名稱」，請確認上面有寫收款人名字`;
  }
  const bm = t.match(/^(?:匯款資料|轉帳資料)[\s:：]*([\s\S]*)$/);
  if (bm) {
    if (!bm[1].trim()) {
      const cur = await env.SESSIONS.get("bank");
      return cur ? `目前的匯款資料：\n${cur}\n\n要修改請傳「匯款資料」加上新內容` : "還沒設定匯款資料喔\n請傳：\n匯款資料\n銀行：○○銀行（代碼 ○○○）\n帳號：○○○○\n戶名：○○○";
    }
    await env.SESSIONS.put("bank", bm[1].trim().slice(0, 500));
    return `好👌 轉帳資料已更新，客人選轉帳時會看到：\n${bm[1].trim()}\n\n⚠️ 自動對帳會比對截圖上的「轉入帳號」，請確認上面有完整帳號`;
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
      if (o) rows.push(`${o.id}｜${o.lineName}｜NT$${o.total.toLocaleString()}｜${o.form.pay || "轉帳"}｜${o.status}${o.paid5 ? "（" + o.paid5 + "）" : ""}`);
    }
    return "最近 10 筆訂單：\n" + rows.join("\n") + "\n\n傳訂單編號可以看明細，傳「ZO… 已付款」「ZO… 已出貨 物流單號」可以改狀態並通知客人";
  }
  const om = t.match(/^(ZO\w{10})(?:\s*(已付款|已出貨|取消)(?:\s+(.+))?)?$/i);
  if (om) {
    const id = om[1].toUpperCase();
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (!o) return `找不到訂單 ${id}`;
    if (om[2]) {
      o.statusBefore = o.status;
      o.status = om[2] === "取消" ? "已取消" : om[2];
      if (o.status === "已取消") await revertMem(env, o);
      if (om[3]) o.track = om[3].trim().slice(0, 60);
      if (o.status === "已付款") {
        o.paidAt = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
        o.payInfo = Object.assign({ method: o.form.pay || "轉帳", amount: o.total }, o.payInfo || {});
        const mem = o.lines.find((l) => l.mem === "vip") ? "vip" : o.lines.find((l) => l.mem === "member") ? "member" : "";
        if (mem && !(o.memUntil && (await getTier(env, o.uid)) === mem)) { const r = await setMembership(env, o.uid, mem, { months: 1 }); o.memUntil = r.until; }
      }
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
[hidden]{display:none!important}
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
.pays{display:flex;gap:8px}.pay{flex:1}.pay input{display:none}.pay span{display:block;text-align:center;border:1.5px solid var(--line);border-radius:10px;padding:11px;background:#fff;font-size:15px;color:var(--ink)}
.pay input:checked+span{border-color:var(--ink);background:var(--ink);color:#fff}
.go{border:0;border-radius:12px;background:var(--ink);color:#fff;font-weight:700;height:48px;font-size:16px;margin-top:6px}
.go:disabled{opacity:.5}
.lpbtn{display:block;margin:10px 0;background:#06c755;color:#fff;text-decoration:none;font-weight:700;border-radius:12px;padding:12px;text-align:center;font-size:16px}
.lpqr{display:block;width:180px;margin:6px auto;border-radius:8px}
.done pre:empty{display:none}
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
const TN={vip:"VIP 會員",member:"一般會員",none:"非會員"};
function TIER(){if(!ME)return"none";if(cart["MEMBER|VIP"]||ME.tier==="vip")return"vip";if(cart["MEMBER|GEN"]||ME.tier==="member")return"member";return"none"}
const price=x=>TIER()==="vip"?x.v:x.g;
const fmt=n=>"NT$"+n.toLocaleString();
const QR="https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/linepay_qr.png";
function payHTML(t,isLP){let h=esc(t).replace(/(https?:\\/\\/[^\\s<]+)/g,u=>/qrcodepay\\.line\\.me/.test(u)?'</pre><a class="lpbtn" href="'+u+'">💚 開啟 LINE Pay 付款</a><pre>':'<a href="'+u+'">'+u+'</a>');
  if(isLP&&/qrcodepay\\.line\\.me/.test(t))h+='</pre><img class="lpqr" src="'+QR+'" alt="LINE Pay QR"><pre>';return h}
async function init(){
  if(!T){$("#grid").innerHTML='<div class="err">請從 ZOARÉ 的 LINE 官方帳號點「訂購連結」進來喔<br>（在 LINE 傳「訂購」就會收到專屬連結）</div>';$("#who").textContent="";return}
  try{
    const [me,cat]=await Promise.all([fetch("/shop/me?t="+encodeURIComponent(T)).then(r=>r.json()),fetch("/shop/catalog").then(r=>r.json())]);
    if(!me.ok){$("#grid").innerHTML='<div class="err">'+esc(me.error)+'</div>';$("#who").textContent="";return}
    ME=me;ALL=cat;
  }catch(e){$("#grid").innerHTML='<div class="err">載入失敗，請稍後再試</div>';return}
  $("#who").innerHTML='<b>'+esc(ME.name)+'</b><span class="tier '+(ME.tier==="vip"?"vip":"")+'">'+esc(ME.tierName)+'</span>'+(ME.until?'<small style="margin-left:6px;color:#6b6f75">到 '+esc(ME.until)+(ME.days!=null&&ME.days<=7?'（剩 '+ME.days+' 天）':'')+'</small>':'')+'<br>'+(ME.tier==="vip"?"已套用 VIP 價":"VIP 會員每件再便宜 NT$30");
  const counts={},order=[];ALL.forEach(x=>(x.c||["其他"]).forEach(c=>{if(!(c in counts)){counts[c]=0;order.push(c)}counts[c]++}));
  const CO=["會員方案","吉伊卡哇","三麗鷗","寶可夢","史努比","角落生物","拉拉熊","哆啦A夢","mofusand","動漫角色","蠟筆小新","塔麻可吉","嚕嚕米","Smiski","夢奇奇","Pickles 小青蛙","好奇猴喬治","好餓的毛毛蟲","彼得兔","什麼都是生物","捏捏療癒小物"];
  const brands=["全部"].concat(CO.filter(c=>counts[c]),order.filter(c=>!CO.includes(c)&&c!=="其他"),counts["其他"]?["其他"]:[]);
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
  VIEW=ALL.filter(x=>(brand==="全部"||(x.c||[]).includes(brand)||x.b===brand)&&(!q||words.every(w=>(x._t||(x._t=norm(x.n+x.b+x.s+x.jan+x.st+x.sh+(x.box?"盲盒box整盒":"")))).includes(w))));
  shown=0;$("#grid").innerHTML="";page();
  const qv=$("#q").value.trim();
  $("#info").innerHTML=(qv?'🔍 「'+esc(qv)+'」':'')+"共 "+VIEW.length+" 款"+(brand!=="全部"?"｜"+esc(brand):"")+(qv?' <a href="#" id="clrq" style="margin-left:8px;color:#9e1b1b">✕ 看全部商品</a>':'');
  const cq=document.getElementById("clrq");if(cq)cq.onclick=e=>{e.preventDefault();$("#q").value="";filter()};
}
function dlTxt(d){const m=(d||"").match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:\\s+(\\d{1,2}:\\d{2}))?/);if(m){const td=new Date(Date.now()+288e5).toISOString().slice(0,10),tw=new Date(Date.now()+1152e5).toISOString().slice(0,10),ds=m[1]+"-"+String(m[2]).padStart(2,"0")+"-"+String(m[3]).padStart(2,"0"),tm=m[4]||"23:59";if(ds===td)return"⏰ 今天 "+tm+" 結單";if(ds===tw)return"⏰ 明天 "+tm+" 結單";return"結單日 "+(+m[2])+"/"+(+m[3])+(m[4]&&m[4]!=="23:59"?" "+m[4]:"")}return"結單日 "+(d?d.split("（")[0]:"長期接單")}
function card(x){
  const p=price(x),q=cart[x.k]||0;
  const tags=[x.box?("整盒 "+x.box+" 個・只能整盒訂"):(!x.mem?step(x)+" 件起":""),x.mem?"":dlTxt(x.dl),x.st&&/庫存較少|洽詢|請洽/.test(x.st)?x.st.replace(/^.*・/,""):""].filter(Boolean).join("｜");
  return '<div class="card" data-k="'+esc(x.k)+'"><div class="ph">'+(x.img?'<img loading="lazy" src="'+esc(x.img)+'" alt="">':'<span style="color:#aaa;font-size:12px">圖片準備中</span>')+'</div><div class="bd"><div class="bn">'+esc(x.b)+'</div><div class="nm">'+esc(x.n)+'</div>'+(tags?'<div class="tag">'+esc(tags)+'</div>':'')+
  '<div class="pr"><b>'+fmt(p)+'</b>'+(TIER()==="vip"&&x.v<x.g?'<s>'+fmt(x.g)+'</s>':'')+(x.box?'<span style="font-size:11px;color:#888">／個</span>':'')+'</div>'+qtyBox(x,q)+'</div></div>';
}
function step(x){if(x.mem)return 1;const own=Number(x.box)||Number(x.moq)||0;if(TIER()!=="none")return own||3;const m=Math.max(21,own);return x.box?Math.ceil(m/x.box)*x.box:m}
function qtyBox(x,q){return q?'<div class="qty"><button data-a="-">−</button><input inputmode="numeric" value="'+q+'"><button data-a="+">＋</button></div>':'<button class="add" data-a="add">加入（'+step(x)+' 件）</button>'}
function page(){
  const part=VIEW.slice(shown,shown+40);shown+=part.length;
  $("#grid").insertAdjacentHTML("beforeend",part.map(card).join("")||(shown?"":'<div class="empty">找不到商品，換個關鍵字試試～</div>'));
  $("#more").hidden=shown>=VIEW.length;
}
$("#more").onclick=page;
window.addEventListener("scroll",()=>{if(!$("#more").hidden&&innerHeight+scrollY>document.body.offsetHeight-600)page()});
const byK=k=>ALL.find(x=>x.k===k);
function setQ(k,q){const t0=TIER();q=Math.max(0,Math.floor(q)||0);if(q)cart[k]=q;else delete cart[k];save();bar();
  if(TIER()!==t0){document.querySelectorAll('#grid .card[data-k]').forEach(el=>{const x=byK(el.dataset.k);if(x)el.outerHTML=card(x)});return}
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
function notes(L){const t=TIER(),out=[],total=L.filter(l=>!l.x.mem).reduce((a,l)=>a+l.q,0);
  L.forEach(({x,q})=>{if(x.mem)return;const mq=step(x);if(x.box&&q%x.box)out.push(x.n+"：整盒商品請以 "+x.box+" 的倍數訂購");else if(q<mq)out.push(x.n+"："+(t==="none"?"非會員":"會員")+"這款 "+mq+" 件起")});
  if(t!=="none"&&total>0&&total<21)out.push("會員混批合計需 21 件起（目前 "+total+" 件）");return out}
$("#openCart").onclick=()=>{renderCart();$("#sheet").classList.add("on")};
$("#openOrders").onclick=openOrders;
function left(dl){const m=dl.match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:\\s+(\\d{1,2}):(\\d{2}))?/);if(!m)return"";const t=Date.UTC(+m[1],+m[2]-1,+m[3],(m[4]?+m[4]:23)-8,m[5]?+m[5]:59)-Date.now();if(t<0)return"已結單";const d=Math.floor(t/864e5),h=Math.floor(t%864e5/36e5);return d?"剩 "+d+" 天 "+h+" 小時":"剩 "+h+" 小時"}
async function openNews(){
  $("#panel").innerHTML='<h2>商品動態<button class="x" id="nx">×</button></h2><div class="empty">載入中…</div>';$("#sheet").classList.add("on");$("#nx").onclick=()=>$("#sheet").classList.remove("on");
  try{const r=await fetch("/shop/news").then(r=>r.json());
    const th=ks=>'<div class="th">'+ks.map(k=>byK(k)).filter(x=>x&&x.img).map(x=>'<img loading="lazy" src="'+esc(x.img)+'">').join("")+'</div>';
    let h='';
    if(r.ann.length)h+='<div class="nsec"><h3>📢 最新公告</h3>'+r.ann.map(a=>'<div class="ann"><small>'+esc(a.d)+'</small>'+esc(a.t)+'</div>').join("")+'</div>';
    if(r.dl.length)h+='<div class="nsec"><h3>⏰ 即將結單</h3>'+r.dl.map(g=>'<div class="ng"><div class="t"><span>'+esc(g.b)+'　'+g.n+' 款</span><small class="cd">'+esc(left(g.dl))+'</small></div><div style="font-size:12px;color:#6b6f75">結單日 '+esc(g.dl.split("（")[0])+'</div>'+th(g.ks)+'<button data-go="'+esc(g.b)+'">去看看</button></div>').join("")+'</div>';
    if(r.fresh.length)h+='<div class="nsec"><h3>🆕 最新上架</h3>'+r.fresh.map(g=>'<div class="ng"><div class="t"><span>'+esc(g.b)+'</span><small>'+esc(g.ad.slice(5).replace("-","/"))+' 上架・'+g.n+' 款</small></div>'+th(g.ks)+'<button data-go="'+esc(g.b)+'">去看看</button></div>').join("")+'</div>';
    if(r.restockCount)h+='<div class="nsec"><h3>🔁 再販商品</h3><div class="ng"><div class="t"><span>再販預定 '+r.restockCount+' 款</span></div><button data-q="再販">去看看</button></div></div>';
    $("#panel").innerHTML='<h2>商品動態<button class="x" id="nx">×</button></h2>'+(h||'<div class="empty">目前沒有新的動態喔</div>');
    $("#nx").onclick=()=>$("#sheet").classList.remove("on");
    $("#panel").querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{brand=b.dataset.go;$("#q").value="";document.querySelectorAll(".chip[data-b]").forEach(c=>c.classList.toggle("on",c.dataset.b===brand));filter();$("#sheet").classList.remove("on");scrollTo(0,0)});
    $("#panel").querySelectorAll("[data-q]").forEach(b=>b.onclick=()=>{brand="全部";$("#q").value=b.dataset.q;document.querySelectorAll(".chip[data-b]").forEach(c=>c.classList.toggle("on",c.dataset.b==="全部"));filter();$("#sheet").classList.remove("on");scrollTo(0,0)});
  }catch(e){$("#panel").querySelector(".empty").textContent="載入失敗，請稍後再試"}
}
const STC={"待付款":"s1","已回報匯款":"s2","待確認":"s1","已付款":"s2","已出貨":"s3","已取消":"s4"};
async function openOrders(){
  $("#panel").innerHTML='<h2>我的訂單<button class="x" id="ox">×</button></h2><div class="empty">載入中…</div>';$("#sheet").classList.add("on");$("#ox").onclick=()=>$("#sheet").classList.remove("on");
  try{const r=await fetch("/shop/orders?t="+encodeURIComponent(T)).then(r=>r.json());if(!r.ok)throw 0;
    const body=r.orders.length?r.orders.map(o=>'<div class="ord"><div class="hd"><span>'+esc(o.id)+'</span><span class="st '+(STC[o.status]||"")+'">'+esc(o.status)+'</span></div>'+
      '<div style="color:#6b6f75;font-size:12.5px">'+esc(o.at)+'｜'+o.qty+' 件｜'+esc(o.tier)+'價</div><div>合計 <b>'+fmt(o.total)+'</b></div>'+
      (o.paid5?'<div style="font-size:12.5px">匯款後五碼：'+esc(o.paid5)+'</div>':'')+(o.track?'<div style="font-size:12.5px">🚚 物流單號：<b>'+esc(o.track)+'</b></div>':'')+
      (o.status==="待付款"&&(o.pay==="LINE Pay"?r.linepay:r.bank)?'<div class="warn" style="margin-top:8px">'+(o.pay==="LINE Pay"?"💚 LINE Pay 付款資料":"🏦 轉帳資料")+'<br>'+payHTML(o.pay==="LINE Pay"?r.linepay:r.bank,o.pay==="LINE Pay").replace(/\\n/g,"<br>").replace(/<\\/?pre>/g,"")+'<br>付款後請在 LINE 傳'+(o.pay==="LINE Pay"?"「付款截圖」":"「後五碼」和「轉帳截圖」")+'</div>':'')+
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
  '<div class="tot">共 '+L.length+' 款 '+n+' 件<br>合計 <b>'+fmt(total)+'</b>（'+esc(TN[TIER()])+'價）'+(TIER()!==ME.tier?'<br><small style="color:#9e1b1b">🎉 購物車有會員方案，送出後自動升級為'+TN[TIER()]+'，這張訂單直接套用會員價</small>':'')+'<br><small style="color:#6b6f75">運費：'+(TIER()==="vip"?"VIP 免運":"由客服確認後通知")+'</small></div>'+
  '<form id="of"><label>收件人姓名</label><input class="f" name="name" required value="'+esc(form.name||"")+'">'+
  '<label>手機號碼</label><input class="f" name="phone" type="tel" required value="'+esc(form.phone||"")+'">'+
  '<label>寄送方式</label><select class="f" name="ship" required>'+["7-11 店到店","全家店到店","萊爾富店到店","宅配","其他"].map(s=>'<option'+(form.ship===s?" selected":"")+'>'+s+'</option>').join("")+'</select>'+
  '<label>門市名稱／收件地址</label><input class="f" name="addr" required value="'+esc(form.addr||"")+'">'+
  '<label>付款方式</label><div class="pays">'+["轉帳","LINE Pay"].map(p=>'<label class="pay"><input type="radio" name="pay" value="'+p+'"'+((form.pay||"轉帳")===p?" checked":"")+'><span>'+(p==="轉帳"?"🏦 銀行轉帳":"💚 LINE Pay")+'</span></label>').join("")+'</div>'+
  '<label>備註（選填）</label><textarea class="f" name="note" rows="2"></textarea>'+
  '<button class="go" id="go">送出訂單</button></form>';
  $("#cx").onclick=()=>$("#sheet").classList.remove("on");
  $("#of").onsubmit=submit;
}
async function submit(e){
  e.preventDefault();const fd=Object.fromEntries(new FormData(e.target));form=fd;try{localStorage.setItem("zo_form",JSON.stringify({name:fd.name,phone:fd.phone,ship:fd.ship,addr:fd.addr,pay:fd.pay}))}catch(_){}
  const btn=$("#go");btn.disabled=true;btn.textContent="送出中…";
  try{
    const r=await fetch("/shop/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:T,items:lines().map(l=>({k:l.x.k,q:l.q})),form:fd})}).then(r=>r.json());
    if(!r.ok)throw new Error(r.error||"送出失敗");
    cart={};save();bar();document.querySelectorAll(".qty").forEach(el=>{const c=el.closest(".card");if(c)el.outerHTML=qtyBox(byK(c.dataset.k),0)});
    $("#panel").innerHTML='<div class="done"><div style="font-size:44px">✅</div><h3>訂單已送出</h3><div>訂單編號 <b>'+esc(r.id)+'</b><br>共 '+r.qty+' 件　合計 <b>'+fmt(r.total)+'</b></div>'+
    (r.bank?'<pre>'+(fd.pay==="LINE Pay"?"💚 LINE Pay 付款資料":"🏦 轉帳資料")+'\\n'+payHTML(r.bank,fd.pay==="LINE Pay")+'\\n\\n'+(fd.pay==="LINE Pay"?"付款後請回到 LINE 傳「付款截圖」":"轉帳後請回到 LINE 傳「後五碼」和「轉帳截圖」")+'，系統會自動對帳</pre>':'<pre>我們確認庫存後，會在 LINE 傳付款資料給你喔～</pre>')+
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
  { k: "寶可夢", w: ["寶可夢", "ポケモン", "皮卡丘", "pokemon"] },
  { k: "史努比", w: ["史努比", "スヌーピー", "peanuts", "snoopy"], subs: [["史努比", ["史努比", "スヌーピー", "snoopy"]], ["糊塗塔克", ["糊塗塔克", "糊塗塌客", "塔克", "ウッドストック", "woodstock"]]] },
  { k: "角落生物", w: ["角落生物", "すみっコ"] },
  { k: "拉拉熊", w: ["拉拉熊", "懶懶熊", "リラックマ", "rilakkuma"] },
  { k: "哆啦A夢", w: ["哆啦a夢", "ドラえもん"] },
  { k: "mofusand", w: ["mofusand"] },
  { k: "動漫角色", w: ["鬼滅", "咒術", "排球", "航海王", "七龍珠", "柯南", "鋼彈", "膽大黨", "火影"], subs: [
    ["鬼滅之刃", ["鬼滅"]], ["咒術回戰", ["咒術"]], ["排球少年", ["排球"]], ["航海王", ["航海王", "ワンピース"]],
    ["七龍珠", ["七龍珠", "ドラゴンボール"]], ["名偵探柯南", ["柯南", "コナン"]], ["鋼彈", ["鋼彈", "ガンダム"]], ["膽大黨", ["膽大黨", "ダンダダン"]]] },
  { k: "塔麻可吉", w: ["塔麻可吉", "たまごっち", "tamagotchi"] },
  { k: "嚕嚕米", w: ["嚕嚕米", "ムーミン", "moomin"] },
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
  const mq = minQty({ box: packN(it), moq: moqOf(it) }, tier);
  const note = [packN(it) ? `整盒 ${packN(it)} 個・只能整盒訂` : tier === "none" ? `${mq} 件起（會員 ${minQty({ box: packN(it), moq: moqOf(it) }, "vip")} 件起）` : `會員 ${mq} 件起`, /庫存較少|洽詢/.test(it.st || "") ? (it.st || "").replace(/^.*・/, "") : ""].filter(Boolean).join("｜");
  const body = [
    { type: "text", text: (it.b || "").slice(0, 40), size: "xxs", color: "#888888" },
    { type: "text", text: it.n.slice(0, 80), size: "sm", weight: "bold", wrap: true, maxLines: 3 },
    { type: "text", text: price + (packN(it) ? " ／個" : ""), size: "lg", weight: "bold", color: "#9E1B1B", margin: "sm" },
    { type: "text", text: sub, size: "xxs", color: "#888888" },
  ];
  const dlt = dlLabel(it);
  body.push({ type: "text", text: "⏰ " + dlt, size: "xs", weight: "bold", color: /今天|明天/.test(dlt) ? "#D0021B" : "#161616", margin: "sm", wrap: true });
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
  return [{ type: "flex", altText: `${title}商品目錄（共 ${total} 款）`, contents: { type: "carousel", contents: bubbles }, quickReply: qr(back) }];
}


// 客人只打品牌／角色名稱（例如「吉伊卡哇」「酷洛米」）→ 直接傳這個系列／角色的全部商品卡片；
// 有加補充字（相框、S娃…）才交給 AI 依細項推薦
const kwNorm = (x) => String(x || "").toLowerCase().replace(/[\s・·、,，.。!！?？~～]/g, "");
function matchKeyword(text) {
  let t = kwNorm(text).replace(/^(請問|我要|我想要|想找|想要|有沒有|有無|找)/, "").replace(/(有嗎|有沒有|有賣嗎|的商品|商品|系列|全部|周邊|全系列|的|嗎|呢|喔|唷)+$/, "");
  if (!t || t.length > 20) return null;
  for (const cat of CATS) {
    const subW = new Set((cat.subs || []).flatMap(([n, ws]) => [n, ...ws]).map(kwNorm));
    if ([cat.k, ...cat.w].map(kwNorm).filter((w) => w === kwNorm(cat.k) || !subW.has(w)).includes(t)) return { cat, sub: null };
  }
  for (const cat of CATS) {
    const cw = [cat.k, ...cat.w].map(kwNorm);
    for (const sub of cat.subs || []) {
      const sw = [sub[0], ...sub[1].filter((w) => w[0] !== "$")].map(kwNorm).filter((w) => w.length >= 2 && !/^[(（]/.test(w) && !/[)）]$/.test(w));
      for (const w of sw) for (const c of ["", ...cw]) if (t === c + w || t === w + c) return { cat, sub };
    }
  }
  for (const cat of WEB_CATS) if ([cat.k, ...cat.w].map(kwNorm).includes(t)) return { cat, sub: null };
  return null;
}
export async function keywordBrowse(env, deps, uid, text) {
  const m = matchKeyword(text);
  if (!m) return null;
  const { cat, sub } = m;
  const items = await deps.loadCatalog(env);
  const { total, list } = pickItems(items, sub ? sub[1] : cat.w, deps.isExpired, sub ? cat.w : null);
  if (!list.length) return null;
  const tier = await getTier(env, uid), link = await shopLink(env, uid);
  const title = sub ? `${cat.k}・${sub[0]}` : cat.k;
  const back = cat.subs ? [...cat.subs.filter(([n]) => !sub || n !== sub[0]).map(([n]) => [n, `目錄 ${cat.k} ${n}`]), ["← 其他系列", "商品目錄"]] : CATS.map((c) => [c.k, "目錄 " + c.k]);
  // 最多 3 組卡片（35 款），超過的用「看全部」連到網站
  const show = list.slice(0, 35), msgs = [];
  for (let i = 0; i < show.length; i += 12) {
    const part = show.slice(i, i + 12).map((it) => bubble(it, tier, link));
    if (i + 12 >= show.length) { if (part.length === 12) part.pop(); part.push(moreBubble(title, total, link, sub ? sub[0] : cat.k)); }
    msgs.push({ type: "flex", altText: `${title}商品（共 ${total} 款）`, contents: { type: "carousel", contents: part } });
  }
  msgs[msgs.length - 1].quickReply = qr(back);
  return msgs;
}

// ---------- 老闆：客人訂單追蹤、刪除／修改、銷售狀況 ----------
const OPEN = ["待付款", "已回報匯款", "待確認", "已付款"];
const nowTW = () => new Date(Date.now() + 8 * 3600e3);
const lineCost = (o, l) => (l.mem ? 0 : l.cost != null ? l.cost : l.price - (o.tier === "vip" ? 50 : 80));
async function allOrders(env, n = 200) {
  const ids = JSON.parse((await env.SESSIONS.get("orders")) || "[]").slice(0, n);
  const out = [];
  for (const id of ids) { const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null"); if (o) out.push(o); }
  return out;
}
async function saveOrder(env, o) { await env.SESSIONS.put("o:" + o.id, JSON.stringify(o), { expirationTtl: 180 * 86400 }); }
function situation(o) {
  const days = Math.floor((nowTW() - new Date(o.at.replace(" ", "T") + ":00Z")) / 864e5);
  const s = { 待付款: `等客人付款${days >= 1 ? `（已 ${days} 天，可以催一下）` : ""}`, 已回報匯款: `客人回報後五碼 ${o.paid5 || ""}，等截圖`,
    待確認: "付款截圖對不上，要人工確認", 已付款: "已付款，等出貨", 已出貨: `已出貨${o.track ? "（" + o.track + "）" : ""}`, 已取消: "已取消" }[o.status] || o.status;
  return s + (o.memo ? `\n　📝 ${o.memo}` : "");
}
function orderCard(o, full = true) {
  const items = o.lines.map((l) => `　・${l.n} ×${l.q}　NT$${l.sub.toLocaleString()}`).join("\n");
  return `【${o.id}】${o.lineName}（${o.at.slice(5)}）\n${full ? items + "\n" : ""}　合計 NT$${o.total.toLocaleString()}｜${o.form.pay || "轉帳"}\n　狀況：${situation(o)}`;
}
function chunk(texts, head) {
  const out = []; let cur = head;
  for (const t of texts) { if ((cur + "\n\n" + t).length > 4500) { out.push(cur); cur = t; } else cur = cur ? cur + "\n\n" + t : t; }
  if (cur) out.push(cur);
  return out.slice(0, 5);
}
function recalc(o) {
  for (const l of o.lines) l.sub = l.price * l.q;
  o.total = o.lines.reduce((a, l) => a + l.sub, 0);
  o.qty = o.lines.reduce((a, l) => a + l.q, 0);
  o.notes = ruleNotes(o.lines, o.tier);
}
function payDiff(o) {
  if (!["已付款", "已出貨"].includes(o.status)) return "";
  const paid = (o.payInfo && o.payInfo.amount) || 0;
  if (!paid || paid === o.total) return "";
  return o.total > paid ? `\n⚠️ 已付 NT$${paid.toLocaleString()}，還需補 NT$${(o.total - paid).toLocaleString()}` : `\n⚠️ 已付 NT$${paid.toLocaleString()}，需退 NT$${(paid - o.total).toLocaleString()}`;
}
async function notifyCustomer(env, deps, o, msg) {
  msg += payDiff(o);
  if (deps.lineApi) await deps.lineApi(env, "/v2/bot/message/push", { to: o.uid, messages: [{ type: "text", text: msg }] });
}
async function findOrdersByName(env, name) {
  const all = await allOrders(env);
  return all.filter((o) => o.lineName.includes(name) || (o.form && o.form.name && o.form.name.includes(name)));
}
// 會員方案訂單被取消／刪除（還沒付款）→ 恢復原本的會員等級
async function revertMem(env, o) {
  if (!o || !o.memGranted || o.paidAt || ["已付款", "已出貨"].includes(o.statusBefore || "")) return;
  const cur = await getTier(env, o.uid);
  if (cur !== o.tier) return;
  if (!o.prevTier || o.prevTier === "none" || (o.prevUntil && o.prevUntil < Date.now())) await setMembership(env, o.uid, "none");
  else await setMembership(env, o.uid, o.prevTier, o.prevUntil ? { until: o.prevUntil } : { months: 1 });
}
async function deleteOrder(env, id) {
  try { await revertMem(env, JSON.parse((await env.SESSIONS.get("o:" + id)) || "null")); } catch (e) {}
  await env.SESSIONS.delete("o:" + id);
  const idx = JSON.parse((await env.SESSIONS.get("orders")) || "[]").filter((x) => x !== id);
  await env.SESSIONS.put("orders", JSON.stringify(idx));
}
// 目前有效會員人數（tier:<uid>）
async function memberCounts(env) {
  const c = { vip: 0, member: 0 };
  let cursor;
  do {
    const r = await env.SESSIONS.list({ prefix: "tier:", cursor });
    for (const k of r.keys) { const v = await env.SESSIONS.get(k.name); const tx = Number(await env.SESSIONS.get("tx:" + k.name.slice(5))) || 0; if (tx && tx < Date.now()) continue; if (c[v] != null) c[v]++; }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return c;
}
async function salesReport(env, range) {
  const now = nowTW(), today = now.toISOString().slice(0, 10);
  let from = today.slice(0, 7) + "-01", label = `${Number(today.slice(5, 7))} 月`;
  if (/今天|今日/.test(range)) { from = today; label = "今天"; }
  else if (/本週|這週|本周|這周/.test(range)) { const d = new Date(now); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); from = d.toISOString().slice(0, 10); label = "本週"; }
  else if (/全部|累計|總/.test(range)) { from = "2000-01-01"; label = "累計"; }
  else { const m = range.match(/(\d{1,2})\s*月/); if (m) { from = `${today.slice(0, 4)}-${String(m[1]).padStart(2, "0")}-01`; label = `${Number(m[1])} 月`; } }
  const to = label.endsWith("月") && label !== `${Number(today.slice(5, 7))} 月` ? from.slice(0, 7) : null;
  const all = await allOrders(env);
  const items = {}; let rev = 0, profit = 0, n = 0, pcs = 0, pend = 0, pendAmt = 0;
  const mem = { vip: { q: 0, amt: 0 }, member: { q: 0, amt: 0 } };
  for (const o of all) {
    const d = (o.paidAt || o.at).slice(0, 10);
    const inRange = to ? d.startsWith(to) : d >= from;
    if (!inRange) continue;
    if (o.status === "已付款" || o.status === "已出貨") {
      n++; rev += o.total;
      for (const l of o.lines) {
        const c = lineCost(o, l); profit += (l.price - c) * l.q;
        if (l.mem && mem[l.mem]) { mem[l.mem].q += l.q; mem[l.mem].amt += l.sub; continue; }
        pcs += l.q;
        const k = l.n; items[k] = items[k] || { q: 0, amt: 0 }; items[k].q += l.q; items[k].amt += l.sub;
      }
    } else if (OPEN.includes(o.status)) { pend++; pendAmt += o.total; }
  }
  const act = await memberCounts(env);
  const memTxt = `\n\n👑 會員方案\nVIP NT$1,000：賣出 ${mem.vip.q} 份 NT$${mem.vip.amt.toLocaleString()}\n一般 NT$100：賣出 ${mem.member.q} 份 NT$${mem.member.amt.toLocaleString()}\n目前有效會員：VIP ${act.vip} 位｜一般 ${act.member} 位`;
  const top = Object.entries(items).sort((a, b) => b[1].q - a[1].q).slice(0, 15).map(([k, v], i) => `${i + 1}. ${k}　×${v.q}　NT$${v.amt.toLocaleString()}`);
  return `📈 銷售狀況｜${label}\n\n已付款訂單：${n} 筆\n銷售件數：${pcs} 件（${Object.keys(items).length} 個品項）\n銷售額：NT$${rev.toLocaleString()}\n淨利：NT$${profit.toLocaleString()}${rev ? `（毛利率 ${Math.round((profit / rev) * 100)}%）` : ""}\n\n🏆 品項銷量${top.length ? "\n" + top.join("\n") : "：還沒有"}${memTxt}\n\n⏳ 未付款訂單：${pend} 筆 NT$${pendAmt.toLocaleString()}（不算進銷售額）\n\n※ 淨利＝售價－成本（成本用報價公式算），還沒扣運費、匯款手續費等其他支出；會員費全額算淨利\n可以傳「銷售狀況 今天／本週／9月／累計」`;
}

async function ownerOrders(env, t, deps) {
  // 銷售狀況
  const sm = t.match(/^(銷售狀況|銷售|業績|銷售報表)\s*(.*)$/);
  if (sm) return await salesReport(env, sm[2] || "");
  // 客人訂單總覽
  if (/^(客人訂單|所有訂單|訂單追蹤|未完成訂單|追蹤訂單)$/.test(t)) {
    const open = (await allOrders(env)).filter((o) => OPEN.includes(o.status));
    if (!open.length) return "目前沒有進行中的訂單👌";
    const byC = {};
    for (const o of open) (byC[o.lineName] = byC[o.lineName] || []).push(o);
    const cards = Object.entries(byC).map(([c, os]) => `👤 ${c}（${os.length} 筆）\n` + os.map((o) => orderCard(o)).join("\n"));
    const sum = open.reduce((a, o) => a + o.total, 0);
    return chunk(cards, `📋 進行中訂單 ${open.length} 筆　NT$${sum.toLocaleString()}\n（傳「ZO… 備註 內容」可以加備註）`);
  }
  // 某位客人的訂單：「小美 訂單」「小美的訂單」
  let m = t.match(/^(.+?)\s*的?\s*訂單$/);
  if (m && !/^(客人|所有|最新|未完成|我的)$/.test(m[1]) && !/^刪除|刪除$/.test(m[1]) && !/^ZO\w{10}/i.test(m[1])) {
    const os = await findOrdersByName(env, m[1].trim());
    if (!os.length) return `找不到「${m[1]}」的訂單`;
    return chunk(os.slice(0, 10).map((o) => orderCard(o)), `👤 ${m[1]} 的訂單（${os.length} 筆）`);
  }
  // 刪除某位客人的訂單：「刪除 小美 的訂單」「小美 訂單刪除」
  m = t.match(/^刪除\s*(.+?)\s*的?\s*訂單$/) || t.match(/^(.+?)\s*的?\s*訂單\s*刪除$/);
  if (m && !/^ZO/i.test(m[1])) {
    const os = (await findOrdersByName(env, m[1].trim())).filter((o) => o.status !== "已出貨");
    if (!os.length) return `找不到「${m[1]}」可以刪除的訂單`;
    if (os.length > 1) return `「${m[1]}」有 ${os.length} 筆訂單，請指定要刪哪一筆：\n` + os.map((o) => `・${o.id}　NT$${o.total.toLocaleString()}　${o.status}`).join("\n") + `\n\n傳「刪除 ZO…」`;
    await deleteOrder(env, os[0].id);
    return `🗑️ 已刪除「${os[0].lineName}」的訂單 ${os[0].id}（NT$${os[0].total.toLocaleString()}）`;
  }
  // 訂單編號相關
  m = t.match(/^(?:刪除\s*(ZO\w{10})|(ZO\w{10})\s*刪除)$/i);
  if (m) {
    const id = (m[1] || m[2]).toUpperCase();
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (!o) return `找不到訂單 ${id}`;
    await deleteOrder(env, id);
    return `🗑️ 已刪除訂單 ${id}（${o.lineName}　NT$${o.total.toLocaleString()}）`;
  }
  m = t.match(/^(ZO\w{10})\s+([\s\S]+)$/i);
  if (!m) return null;
  const id = m[1].toUpperCase(), cmd = m[2].trim();
  if (/^(已付款|已出貨|取消)(\s|$)/.test(cmd)) return null; // 交給狀態指令
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o) return `找不到訂單 ${id}`;
  // 備註
  let x = cmd.match(/^(?:備註|狀況|註記)[\s:：]*([\s\S]*)$/);
  if (x) { o.memo = x[1].trim().slice(0, 200); await saveOrder(env, o); return `📝 ${id} 備註已更新：${o.memo || "（已清除）"}`; }
  // 收件資料
  x = cmd.match(/^(?:地址|門市|收件地址)[\s:：]*(.+)$/);
  if (x) { o.form.addr = x[1].trim().slice(0, 150); await saveOrder(env, o); return `好👌 ${id} 地址改成：${o.form.addr}`; }
  x = cmd.match(/^(?:電話|手機)[\s:：]*(.+)$/);
  if (x) { o.form.phone = x[1].trim().slice(0, 20); await saveOrder(env, o); return `好👌 ${id} 電話改成：${o.form.phone}`; }
  x = cmd.match(/^(?:收件人|姓名)[\s:：]*(.+)$/);
  if (x) { o.form.name = x[1].trim().slice(0, 40); await saveOrder(env, o); return `好👌 ${id} 收件人改成：${o.form.name}`; }
  const find = (kw) => o.lines.filter((l) => l.n.includes(kw) || l.jan === kw);
  // 刪除品項：「ZO… 刪 小八」
  x = cmd.match(/^(?:刪除?|拿掉|移除)\s*(.+)$/);
  if (x) {
    const hit = find(x[1].trim());
    if (!hit.length) return `${id} 裡找不到「${x[1]}」`;
    if (hit.length > 1) return `「${x[1]}」對到好幾款，請打更完整的名稱：\n` + hit.map((l) => "・" + l.n).join("\n");
    o.lines = o.lines.filter((l) => l !== hit[0]);
    if (!o.lines.length) { await deleteOrder(env, id); return `🗑️ ${id} 品項都刪完了，整張訂單已刪除`; }
    recalc(o); await saveOrder(env, o);
    await notifyCustomer(env, deps, o, `您的訂單 ${id} 已更新：移除「${hit[0].n}」\n新的合計 NT$${o.total.toLocaleString()}`);
    return `好👌 ${id} 已移除「${hit[0].n}」\n新合計 NT$${o.total.toLocaleString()}（已通知客人）${payDiff(o)}`;
  }
  // 加品項：「ZO… 加 4970381929411 3」
  x = cmd.match(/^(?:加|新增|加入)\s*(.+?)\s+(\d+)\s*(?:個|件|盒)?$/);
  if (x && deps.loadCatalog) {
    const kw = x[1].trim(), q = Number(x[2]);
    const pool = slim(await deps.loadCatalog(env), deps.isExpired || (() => false));
    const hits = pool.filter((p) => p.jan === kw || p.n.includes(kw));
    if (!hits.length) return `目錄裡找不到「${kw}」`;
    if (hits.length > 1 && !hits.find((h) => h.jan === kw)) return `「${kw}」對到 ${hits.length} 款，請用 JAN 碼或更完整的名稱：\n` + hits.slice(0, 8).map((h) => `・${h.n}（${h.jan}）`).join("\n");
    const it = hits.find((h) => h.jan === kw) || hits[0];
    const price = o.tier === "vip" ? it.v : it.g;
    const ex = o.lines.find((l) => l.k === it.k);
    if (ex) ex.q += q; else o.lines.push({ k: it.k, n: it.n, b: it.b, jan: it.jan, q, price, cost: it.mem ? 0 : it.g - 80, sub: 0, box: it.box, moq: it.moq, mem: it.mem || "" });
    recalc(o); await saveOrder(env, o);
    await notifyCustomer(env, deps, o, `您的訂單 ${id} 已更新：加入「${it.n}」×${q}\n新的合計 NT$${o.total.toLocaleString()}`);
    return `好👌 ${id} 已加入「${it.n}」×${q}\n新合計 NT$${o.total.toLocaleString()}（已通知客人）${payDiff(o)}`;
  }
  // 改數量：「ZO… 小八 改 24」「ZO… 小八 24個」
  x = cmd.match(/^(.+?)\s*(?:改成?|改為|數量|→|=)?\s*(\d+)\s*(?:個|件|盒)?$/);
  if (x) {
    const hit = find(x[1].replace(/(改成?|改為|數量)$/, "").trim());
    if (!hit.length) return `${id} 裡找不到「${x[1]}」`;
    if (hit.length > 1) return `「${x[1]}」對到好幾款，請打更完整的名稱：\n` + hit.map((l) => "・" + l.n).join("\n");
    const q = Number(x[2]);
    if (q === 0) o.lines = o.lines.filter((l) => l !== hit[0]); else hit[0].q = q;
    if (!o.lines.length) { await deleteOrder(env, id); return `🗑️ ${id} 品項都刪完了，整張訂單已刪除`; }
    recalc(o); await saveOrder(env, o);
    await notifyCustomer(env, deps, o, `您的訂單 ${id} 已更新：「${hit[0].n}」數量改為 ${q}\n新的合計 NT$${o.total.toLocaleString()}`);
    return `好👌 ${id}「${hit[0].n}」改成 ${q} 個\n新合計 NT$${o.total.toLocaleString()}（已通知客人）${payDiff(o)}`;
  }
  return `看不懂這個訂單指令😂 可以用：\n・${id} 備註 內容\n・${id} 小八 改 24\n・${id} 刪 小八\n・${id} 加 JAN碼 3\n・${id} 地址 新地址\n・刪除 ${id}\n・${id} 已付款／已出貨／取消`;
}

// 給商家後台用
export { TIER_NAME, sign, allOrders, saveOrder, deleteOrder, lineCost, situation, OPEN, payDiff, slim, catsOf };
export const CAT_NAMES = () => CATS.concat(WEB_CATS).map((c) => c.k);

// AI 報價時用的商品卡片
export async function productCards(env, uid, items, altText) {
  const tier = await getTier(env, uid);
  const link = await shopLink(env, uid);
  const bubbles = items.filter((it) => it && it.img).slice(0, 12).map((it) => bubble(it, tier, link));
  if (!bubbles.length) return null;
  return { type: "flex", altText: (altText || "商品報價").slice(0, 300), contents: { type: "carousel", contents: bubbles } };
}

// ---------- 會員方案卡片（客人打 會員／VIP／$1000／$100…） ----------
const RAW_IMG = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/";
function memBubble(title, price, perks, img, btn, uri, dark) {
  const fg = dark ? "#FFFFFF" : "#161616", sub = dark ? "#C9CCD0" : "#6B6F75";
  return { type: "bubble", size: "kilo",
    hero: { type: "image", url: img, size: "full", aspectRatio: "1:1", aspectMode: "cover" },
    body: { type: "box", layout: "vertical", spacing: "sm", backgroundColor: dark ? "#161616" : "#FFFFFF", contents: [
      { type: "text", text: title, weight: "bold", size: "lg", color: fg },
      { type: "text", text: price, weight: "bold", size: "xl", color: dark ? "#E9C46A" : "#9E1B1B" },
      ...perks.map((p) => ({ type: "text", text: "✓ " + p, size: "xs", color: sub, wrap: true })) ] },
    footer: { type: "box", layout: "vertical", backgroundColor: dark ? "#161616" : "#FFFFFF", contents: [{ type: "button", style: "primary", color: dark ? "#9E1B1B" : "#161616", height: "sm", action: { type: "uri", label: btn, uri } }] } };
}
export async function membershipCards(env, uid) {
  const link = (await shopLink(env, uid)) + "&q=" + encodeURIComponent("會員方案");
  const tier = await getTier(env, uid);
  const bubbles = [
    memBubble("👑 VIP 會員", "NT$1,000／月", ["國際＋國內運費全免", "全館 VIP 價，每件比一般價便宜 NT$30", "不同款混批 21 件，每款照商品起批數", "新品優先通知"], RAW_IMG + "member_vip.jpg", "加入 VIP 會員", link, true),
    memBubble("一般會員", "NT$100／月", ["免國際運費", "不同款混批 21 件，每款照商品起批數", "商品用一般價"], RAW_IMG + "member_gen.jpg", "加入一般會員", link, false),
  ];
  const mi = await memberInfo(env, uid);
  const exp = mi.until ? `有效到 ${fmtDay(mi.until)}（還有 ${mi.days} 天）` : "";
  const head = tier === "vip" ? `您已經是 VIP 會員囉👑 ${exp}\n要續約可以點下面直接下單，會從到期日往後延長～` : tier === "member" ? `您目前是一般會員，${exp}\n升級 VIP 運費全免、每件再便宜 NT$30👇` : "ZOARÉ 批發會員方案👇 付款完成會自動開通，效期 1 個月";
  const out = [{ type: "flex", altText: head, contents: { type: "carousel", contents: bubbles } }];
  if (tier !== "none") out.unshift({ type: "text", text: head });
  return out;
}

// ---------- 新朋友加入的歡迎訊息 ----------
export async function welcomeMessages(env, uid, name) {
  const link = await shopLink(env, uid);
  const hi = name ? `${name} 您好～` : "您好～";
  const text = `${hi}歡迎加入 ZOARÉ 🎉
我們是日本角色商品批發，吉伊卡哇、三麗鷗、寶可夢、史努比、角落生物…上千款日本正版商品，集單預購、批發價直送台灣🇯🇵

━━ 怎麼買？3 個步驟 ━━
① 找商品：直接在這裡打角色名字，例如「吉伊卡哇」「酷洛米」，馬上傳商品卡片給您
② 看清楚：每張卡片都有價格、起批數、結單日
③ 下單：按卡片上的「我要訂購」，或打開您的專屬商城👇
${link}
（這是您專用的連結，價格會自動套用您的會員價，請不要轉傳）
付款可以轉帳或 LINE Pay，付完在這裡傳後五碼＋截圖，系統自動對帳

━━ 查報價小技巧 ━━
・找特定款式：加細項，例如「吉伊卡哇 相框」「小八 S娃」
・手上有照片或條碼：直接傳照片、JAN 條碼或商品編號
・慢慢逛：點下方選單「商品目錄」照分類看
・看新品、快結單的商品：點「商品動態」
・查訂單：點「訂單查詢」`;
  const text2 = `━━ 起批數怎麼算？ ━━
・非會員：每款 21 件起（商品本身起批數更多的照商品）
・會員：每款只要達到商品自己的起批數，很多款 1～3 件就能訂，不同款合計 21 件就能出單
👉 想少量多樣進貨，加入會員最划算

━━ 會員方案 ━━
👑 VIP 會員 NT$1,000／月（推薦）
・國際＋國內運費全免
・全館 VIP 價，每件再便宜 NT$30
・新品優先通知
🔹 一般會員 NT$100／月：只免國際運費

💡 幫您算：每月進貨 34 件以上，VIP 每件省的 NT$30 就把月費賺回來了，運費還全免！
點下面卡片就能直接加入，付款完成自動開通👇`;
  const qrs = [["吉伊卡哇", "吉伊卡哇"], ["三麗鷗", "三麗鷗"], ["商品目錄", "商品目錄"], ["加入 VIP", "會員方案"], ["商品動態", "商品動態"]];
  const cards = await membershipCards(env, uid);
  cards[0].quickReply = { items: qrs.map(([l, t]) => ({ type: "action", action: { type: "message", label: l, text: t } })) };
  return [{ type: "text", text }, { type: "text", text: text2 }, ...cards];
}

// 下單會員方案但 3 天內沒付款 → 恢復原本等級並通知老闆（每次排程檢查）
export async function memExpiry(env, deps) {
  const ids = JSON.parse((await env.SESSIONS.get("orders")) || "[]");
  const limit = new Date(Date.now() + 8 * 3600e3 - 3 * 86400e3).toISOString().slice(0, 16).replace("T", " ");
  const owner = await env.SESSIONS.get("owner");
  for (const id of ids) {
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (!o || !o.memGranted || o.memReverted || o.paidAt || !OPEN.includes(o.status) || o.status === "已付款" || o.at > limit) continue;
    await revertMem(env, o);
    o.memReverted = true;
    await env.SESSIONS.put("o:" + id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
    if (owner) await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `⏰ ${o.lineName} 的會員方案訂單 ${o.id} 超過 3 天沒付款，已恢復為${TIER_NAME[o.prevTier || "none"]}\n之後客人付款、你傳「${o.id} 已付款」就會重新開通` }] });
  }
}

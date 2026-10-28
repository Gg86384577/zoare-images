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
let SLIM = null, SLIM_SRC = null, SLIM_TXT = null, SLIM_TXT_KEY = "";
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + s.length.toString(36); }
const MEMBER_ITEMS = [
  { k: "MEMBER|VIP", n: "VIP 會員（月費）每月 10 張國內＋10 張國際運費券・VIP 專屬價", b: "ZOARÉ 會員方案", s: "", g: 1000, v: 1000, img: "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/member_vip.jpg?v=2", moq: 0, box: 0, pk: "", st: "", sh: "", dl: "", jan: "", ad: "", c: ["會員方案"], mem: "vip" },
  { k: "MEMBER|GEN", n: "一般會員（月費）每月 5 張國內運費券", b: "ZOARÉ 會員方案", s: "", g: 100, v: 100, img: "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/member_gen.jpg?v=2", moq: 0, box: 0, pk: "", st: "", sh: "", dl: "", jan: "", ad: "", c: ["會員方案"], mem: "member" },
];
// 網站多加的分類（LINE 選單按鈕有上限，不放這些）
const WEB_CATS = [
  { k: "蠟筆小新", w: ["蠟筆小新", "小新", "クレヨンしんちゃん"] }, { k: "Pickles 小青蛙", w: ["pickle", "ピクルス"] },
  { k: "夢奇奇", w: ["夢奇奇", "蒙奇奇", "モンチッチ", "monchhichi"] }, { k: "Smiski", w: ["smiski", "スミスキー"] },
  { k: "好奇猴喬治", w: ["喬治", "おさるのジョージ"] }, { k: "好餓的毛毛蟲", w: ["毛毛蟲", "はらぺこあおむし"] },
  { k: "彼得兔", w: ["彼得兔", "ピーターラビット"] }, { k: "什麼都是生物", w: ["什麼都是生物"] },
  { k: "迪士尼", w: ["迪士尼", "ディズニー", "disney", "史迪奇", "小熊維尼", "玩具總動員", "動物方城市"] },
  { k: "湯姆貓與傑利鼠", w: ["湯姆貓", "傑利鼠", "貓和老鼠", "トムとジェリー", "とむとじぇりー", "tom and jerry"] },
  { k: "飛天小女警", w: ["飛天小女警", "パワーパフ", "パワパフ", "powerpuff"] },
  { k: "玩偶小狗斯斯", w: ["斯斯", "スンスン", "パペットスンスン", "sunsun", "puppet sunsun"] },
  { k: "米飛兔", w: ["米飛兔", "米菲", "ミッフィー", "miffy"] },
  { k: "星之卡比", w: ["卡比", "カービィ", "kirby"] },
  { k: "麵包小偷", w: ["麵包小偷", "パンどろぼう"] },
  { k: "海綿寶寶", w: ["海綿寶寶", "スポンジ・ボブ", "スポンジボブ", "spongebob"] },
  { k: "粉紅兔兔", w: ["粉紅兔兔", "胖次兔", "おぱんちゅうさぎ"] },
  { k: "彩虹熊", w: ["彩虹熊", "ケアベア", "care bears"] },
  { k: "艾斯特兔", w: ["艾斯特兔", "愛絲兔", "esther bunny", "エスターバニー"] },
  { k: "憂傷熊", w: ["憂傷熊", "グルーミー"] },
  { k: "Suzy's Zoo", w: ["suzy's zoo", "スージー・ズー"] },
  { k: "Studio UG", w: ["studio ug", "スタジオｕｇ"] },
  { k: "小海豹", w: ["小海豹", "ゴマちゃん", "アシベ"] },
  { k: "企鵝家族", w: ["企鵝家族", "ピングー", "pingu"] },
  { k: "貓咪大戰爭", w: ["貓咪大戰爭", "にゃんこ大戦争"] },
  { k: "小矮人圖鑑", w: ["小矮人圖鑑", "小人圖鑑", "こびとづかん"] },
  { k: "卡娜赫拉的小動物", w: ["卡娜赫拉", "カナヘイ", "p助"] },
  { k: "麵包超人", w: ["麵包超人", "アンパンマン"] },
  { k: "超級瑪利歐", w: ["瑪利歐", "馬力歐", "マリオ", "耀西"] },
  { k: "RE-MENT 盒玩", w: ["re-ment", "リーメント", "盒玩"] },
  { k: "平成懷舊", w: ["平成懷舊", "魔法莓莓", "まじかるベリーベリー"] },
  { k: "銀喉長尾山雀", w: ["銀喉長尾山雀", "シマエナガ"] },
  { k: "麻糬熊貓", w: ["麻糬熊貓", "糯米熊貓", "もちもちぱんだ", "もちぱん"] },
  { k: "小熊學校", w: ["小熊學校", "がんばれ!ルルロロ", "the bear's school", "くまのがっこう"] },
  { k: "小小兵", w: ["小小兵", "ミニオン"] },
  { k: "Lovely MongMong", w: ["mongmong"] },
  { k: "多摩君", w: ["多摩君", "タマ&フレンズ"] },
  { k: "汎用兔", w: ["汎用兔", "汎用うさぎ"] },
  { k: "小幽靈 Obakenu", w: ["obakenu", "小幽靈", "おばけーぬ", "オバケーヌ"] },
  { k: "mojojojo", w: ["mojojojo"] },
  { k: "小羊肖恩", w: ["小羊肖恩", "掌門狗", "ひつじのショーン", "shaun"] },
  { k: "哥斯拉", w: ["哥斯拉", "ゴジラ", "godzilla"] },
  { k: "櫻桃小丸子", w: ["櫻桃小丸子", "小丸子", "まる子", "ちびまる子"] },
  { k: "雨傘雨具", w: ["雨傘", "摺疊傘", "長柄傘", "兒童傘", "透明傘", "雨衣", "雨披"] },
  { k: "襪子", w: ["短襪", "居家襪", "保暖襪", "圖案襪", "角色襪", "兒童襪", "半襪", "浮紋襪", "後跟襪"] },
  { k: "包袋收納", w: ["束口袋", "托特包", "環保購物袋", "環保袋", "收納包", "便當袋", "手提袋", "後背袋", "收納包", "零錢包", "斜背包", "票卡夾", "收納盒", "筆袋"] },
  { k: "居家保暖", w: ["毛毯", "半身毯", "圍巾", "耳罩", "手套", "室內鞋", "拖鞋"] },
  { k: "零食包裝系列", w: ["零食"] },
  { k: "J's Planning", w: ["j's planning"] },
  { k: "幽遊白書", w: ["幽遊白書", "幽☆遊☆白書", "幽助", "飛影", "藏馬", "蔵馬", "桑原"] },
];
let CAT_LC = null;
function catsOf(it) {
  if (!CAT_LC) CAT_LC = CATS.concat(WEB_CATS).map((c) => [c.k, c.w.map((w) => w.toLowerCase())]);
  const h = ((it.n || "") + " " + (it.ja || "") + " " + (it.b || "") + " " + (it.s || "")).toLowerCase();
  const out = [];
  for (const [k, ws] of CAT_LC) for (const w of ws) if (h.includes(w)) { out.push(k); break; }
  return out.length ? out : ["其他"];
}
// 到貨／發售時間：把各家型錄寫法統一成客人看得懂的一句（看不出來就不顯示）
export function shipLabel(it) {
  const sh = String(it.ship || "").trim(), st = String(it.st || "");
  const now = new Date(Date.now() + 8 * 3600e3), ym = now.getUTCFullYear() * 100 + now.getUTCMonth() + 1;
  if (/^現貨$|好評発売中|発売中|常規商品/.test(sh) || /^現貨/.test(st)) return "現貨";
  let m = sh.match(/(\d{4})年(\d{1,2})月(上旬|中旬|下旬)?/);
  if (m) { const v = +m[1] * 100 + +m[2]; return v < ym || (v === ym && /新品|再販/.test(sh)) ? "現貨" : `預計 ${+m[2]}月${m[3] || ""}到貨`; }
  m = sh.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) { const v = +m[1] * 100 + +m[2]; return v < ym ? "現貨" : `預計 ${+m[2]}/${+m[3]} 發售`; }
  m = sh.match(/次回入荷\s*(\d{1,2})月/);
  if (m) return `下一批 ${+m[1]}月到貨`;
  m = sh.match(/(\d{1,2})月[～~〜-](\d{1,2})月/);
  if (m) return `預計 ${+m[1]}～${+m[2]}月到貨`;
  return "";
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
      moq: moqOf(it), box: packN(it), pk: it.pack || "", st: it.st || "", sh: shipLabel(it), dl: it.dlx || it.dl || "", jan: it.jan || it.code || "", ad: it.ad || "", c: catsOf(it), m: mfrOf(it.b), ...(it.alt ? { alt: it.alt } : {}), ...(it.hid ? { hid: 1 } : {}) });
  }
  out.push(...MEMBER_ITEMS);
  SLIM = out; SLIM_SRC = items;
  return out;
}

// ---------- 訂購規則（只提醒，不擋） ----------
// 起批規則：非會員＝每款起批數的倍數、至少 21 件；一般會員＝每款照起批數、整張訂單混批合計 21 件；VIP＝每款照起批數、不限總件數。
// 三種方案都一樣：已付款訂單依廠商累積滿 NT$20,000（＝人民幣 4,000 元，匯率高時跟著調高，對客人一律只寫台幣）才向日本叫貨，先付款先寄。
// 例：起批 2 → 會員 2／非會員 22；起批 3 → 3／21；起批 6 → 6／24；起批 48 → 48／48
export function minQty(x, tier) {
  if (x.mem) return 1;
  const u = Number(x.box) || Number(x.moq) || 3;
  if (tier !== "none") return u;
  return u >= 21 ? u : Math.ceil(21 / u) * u;
}
// 每款數量規則（強制）：要 ≥ 起批數，而且是單位（入數／整盒數）的倍數
export function qtyUnit(x) { return x.mem ? 1 : Number(x.box) || Number(x.moq) || 3; }
export function fixQty(x, tier, q) { q = Math.floor(Number(q) || 0); if (q <= 0) return 0; const u = qtyUnit(x), m = minQty(x, tier); return Math.max(m, Math.ceil(q / u) * u); }
export function ruleNotes(lines, tier) {
  const notes = [];
  const total = lines.filter((l) => !l.mem).reduce((a, l) => a + l.q, 0);
  for (const l of lines) {
    if (l.mem) continue;
    const mq = minQty(l, tier);
    if (l.box && l.q % l.box) notes.push(`${l.n}：盲盒／整箱商品請以 ${l.box} 的倍數訂購`);
    else if (l.q < mq) notes.push(`${l.n}：${tier === "vip" ? "VIP 會員" : tier === "none" ? "非會員" : "一般會員"}這款 ${mq} 件起`);
  }
  if (tier === "member" && total > 0 && total < 21) notes.push(`一般會員整張訂單混批合計需 21 件（目前 ${total} 件）`);
  if (total > 0) notes.push(`依廠商湊單：同一廠商的已付款訂單湊滿${POOL_SHOW} 就向日本叫貨，先付款先寄`);
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
  if (!parts.length) parts.push("目前沒有新上線的商品喔～");
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
    // 目錄版本放進網址：每次更新目錄，客人手機就一定抓新的商品清單（不會被快取卡住）
    return new Response(PAGE.replaceAll("__CV__", encodeURIComponent(deps.ver || "")), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (p === "/shop/catalog") {
    // 商品清單很大：算好的結果存成文字（記憶體＋KV），同一版本／匯率／結單規則只算一次，避免每台伺服器都重算而逾時
    const hdr = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" };
    let key = "";
    try { if (deps.catStamp) key = "slimc:" + hashStr(await deps.catStamp(env)); } catch (e) {}
    if (key && SLIM_TXT && SLIM_TXT_KEY === key) return new Response(SLIM_TXT, { headers: hdr });
    let txt = null;
    if (key && env.SESSIONS) { try { txt = await env.SESSIONS.get(key); } catch (e) {} }
    if (!txt) {
      txt = JSON.stringify(slim(await deps.loadCatalog(env), deps.isExpired));
      if (key && env.SESSIONS) { const put = env.SESSIONS.put(key, txt, { expirationTtl: 7200 }).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(put); }
    }
    if (key) { SLIM_TXT = txt; SLIM_TXT_KEY = key; }
    return new Response(txt, { headers: hdr });
  }
  if (p === "/shop/hot") {
    const all = await deps.loadCatalog(env);
    const hot = await hotPicks(env, all, deps.isExpired, 40);
    return Response.json(hot.map(keyOf), { headers: { "cache-control": "public, max-age=600" } });
  }
  if (p === "/shop/news") {
    const n = await buildNews(env, slim(await deps.loadCatalog(env), deps.isExpired));
    const pick = (arr) => arr.slice(0, 8).map((x) => x.k);
    return Response.json({ ann: n.ann.slice(0, 5), restockCount: n.restockCount,
      dl: n.dlGroups.slice(0, 10).map((g) => ({ b: g.b, dl: g.dl, n: g.items.length, ks: pick(g.items) })),
      fresh: n.newGroups.slice(0, 12).map((g) => ({ b: g.b, ad: g.ad, n: g.items.length, ks: pick(g.items) })) });
  }
  // 訪客購物車暫存：公開賣場選好商品 → 存一個代碼 → 透過 LINE 換成客人自己的下單頁
  if (p === "/shop/guestcart") {
    if (request.method === "POST") {
      let b; try { b = await request.json(); } catch (e) { return Response.json({ ok: false, error: "資料格式錯誤" }, { status: 400 }); }
      const c = {}, src = (b && b.cart) || {};
      for (const k of Object.keys(src).slice(0, 80)) { const q = Math.floor(Number(src[k])); if (typeof k === "string" && k.length < 200 && q > 0 && q < 100000) c[k] = q; }
      if (!Object.keys(c).length) return Response.json({ ok: false, error: "購物車是空的" }, { status: 400 });
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let id = "";
      const rnd = crypto.getRandomValues(new Uint8Array(6)); for (const x of rnd) id += A[x % A.length];
      await env.SESSIONS.put("gc:" + id, JSON.stringify(c), { expirationTtl: 3 * 86400 });
      return Response.json({ ok: true, id });
    }
    const id = String(url.searchParams.get("id") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const v = id ? await env.SESSIONS.get("gc:" + id) : null;
    return Response.json(v ? { ok: true, cart: JSON.parse(v) } : { ok: false });
  }
  // 購物車追蹤（只記會員專屬連結的客人；加入、修改、清空都會同步）
  if (p === "/shop/cart" && request.method === "POST") {
    let body; try { body = await request.json(); } catch (e) { return Response.json({ ok: false }, { status: 400 }); }
    const uid = await verifyToken(env, body.t);
    if (!uid) return Response.json({ ok: false }, { status: 401 });
    const map = new Map(slim(await deps.loadCatalog(env), deps.isExpired).map((x) => [x.k, x]));
    const tier = await getTier(env, uid);
    const lines = [];
    for (const [k, q0] of Object.entries(body.cart || {}).slice(0, 300)) { const it = map.get(k), q = Math.floor(Number(q0)); if (it && q > 0 && q <= 100000) lines.push({ k, n: it.n, b: it.b, q, price: tier === "vip" ? it.v : it.g }); }
    await saveCartTrack(env, uid, lines, await deps.displayName(env, uid), tier);
    return Response.json({ ok: true });
  }
  if (p === "/shop/pools") {
    const P = await getPools(env), o = {};
    const c = {};
    for (const m in P.pools) { o[m] = P.pools[m].pct; c[m] = P.pools[m].nt || 0; }
    return Response.json({ ok: true, pct: o }, { headers: { "cache-control": "public, max-age=120" } });
  }
  if (p === "/shop/me") {
    const uid = await verifyToken(env, url.searchParams.get("t"));
    if (!uid) return Response.json({ ok: false, error: "連結無效，請回到 LINE 重新點訂購連結" }, { status: 401 });
    const tier = await getTier(env, uid);
    const mi = await memberInfo(env, uid);
    return Response.json({ ok: true, name: await deps.displayName(env, uid), tier, tierName: TIER_NAME[tier], until: mi.until ? fmtDay(mi.until) : "", days: mi.days, coupons: await couponView(env, uid), camp: activeCampaign(), sc: await shipCoupons(env, uid), shipRule: SHIP_RULE });
  }
  if (p === "/shop/orders") {
    const uid = await verifyToken(env, url.searchParams.get("t"));
    if (!uid) return Response.json({ ok: false, error: "連結無效" }, { status: 401 });
    const list = await myOrders(env, uid, 20);
    await Promise.all(list.map(async (o) => { o._mst = await orderMfrStatus(env, o); }));
    await fillLineImgs(env, deps, list);
    return Response.json({ ok: true, orders: list.map((o) => ({ id: o.id, at: o.at, status: o.status, paid5: o.paid5 || "", track: o.track || "", pay: o.form.pay || "轉帳",
      mst: o._mst || [], total: o.total, qty: o.qty, tier: TIER_NAME[o.tier], discount: o.coupon ? o.coupon.amt : 0, earned: o.earned ? o.earned.amt : 0, lines: o.lines.map((l) => ({ n: l.n, q: l.q, price: l.price, sub: l.sub, img: l.img || "", sh: !!shippedMark(o, l) })), form: o.form })),
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
      const rw = RAWK(await deps.loadCatalog(env)).get(it.k), rp = rw && rw.pb;
      lines.push({ k: it.k, n: it.n, b: it.b, jan: it.jan, img: it.img || "", q, price, cost: it.mem ? 0 : it.g - 80, ...(rp && rp.cd && rp.d && !it.mem ? { rc: Math.round(((it.g - 80) * rp.cd) / rp.d) } : {}), sub: price * q, box: it.box, moq: it.moq, mem: it.mem || "", cs: caseN(it), c: it.c || [], m: it.m || mfrOf(it.b) });
    }
    if (!lines.length) return Response.json({ ok: false, error: "購物車是空的，或商品已下架" }, { status: 400 });
    if (tier === "member") { const pcs = lines.filter((l) => !l.mem).reduce((x, l) => x + l.q, 0); if (pcs > 0 && pcs < 21) return Response.json({ ok: false, error: `一般會員整張訂單混批合計要 21 件以上（目前 ${pcs} 件），請再加 ${21 - pcs} 件以上\n\n加入 VIP 會員就沒有總件數限制，可以真正少量叫貨` }, { status: 400 }); }
    const badQ = lines.filter((l) => !l.mem && fixQty(l, tier, l.q) !== l.q);
    if (badQ.length) return Response.json({ ok: false, error: "下列商品數量需為起批數或起批數的倍數，請調整後再送出：\n" + badQ.slice(0, 8).map((l) => `・${l.n}：${l.q} 件 → 請改成 ${fixQty(l, tier, l.q)} 件`).join("\n") }, { status: 400 });
    const f = body.form || {};
    const clean = (s, n = 100) => String(s || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
    const form = { name: clean(f.name, 40), phone: clean(f.phone, 20), ship: clean(f.ship, 20), addr: clean(f.addr, 150), note: clean(f.note, 300), pay: f.pay === "LINE Pay" ? "LINE Pay" : "轉帳" };
    if (!form.name || !form.phone || !form.ship || !form.addr) return Response.json({ ok: false, error: "請填寫收件人、電話、寄送方式與門市／地址" }, { status: 400 });
    const sumAll = lines.reduce((a, l) => a + l.sub, 0);
    const qty = lines.reduce((a, l) => a + l.q, 0);
    const d = new Date(Date.now() + 8 * 3600e3);
    const id = "ZO" + d.toISOString().slice(2, 10).replace(/-/g, "") + Math.random().toString(36).slice(2, 6).toUpperCase();
    // 使用折抵券
    let total = sumAll, coupon = null, cps = null;
    if (body.coupon) {
      const view = await couponView(env, uid), c = view.find((x) => x.id === body.coupon);
      if (!c || c.status !== "可使用") return Response.json({ ok: false, error: "這張折抵券目前不能使用（可能已使用、過期或來源訂單還沒付款）" }, { status: 400 });
      if (sumAll < c.min) return Response.json({ ok: false, error: `這張折抵券要訂單滿 NT$${c.min.toLocaleString()} 才能使用` }, { status: 400 });
      coupon = { id: c.id, amt: c.amt }; total = sumAll - c.amt;
      cps = await getCoupons(env, uid); const cc = cps.find((x) => x.id === c.id); if (cc) cc.used = id;
    }
    // 活動送折抵券（付款後生效）
    const camp = activeCampaign(), earn = campaignEarn(lines, camp);
    const notes = ruleNotes(lines, tier);
    const lineName = await deps.displayName(env, uid);
    const order = { id, uid, lineName, tier, lines, total, qty, form, notes, status: "待付款", at: d.toISOString().slice(0, 16).replace("T", " ") };
    if (coupon) { order.coupon = coupon; order.subtotal = sumAll; }
    if (earn.amt) {
      cps = cps || (await getCoupons(env, uid));
      const today = twDay(), cid = "CP" + Math.random().toString(36).slice(2, 8).toUpperCase();
      cps.unshift({ id: cid, amt: earn.amt, min: earn.amt * camp.minX, name: camp.name, src: id, at: today, exp: addDays(today, camp.days), used: "" });
      order.earned = { id: cid, amt: earn.amt, base: earn.base, camp: camp.name };
    }
    if (cps) await saveCoupons(env, uid, cps);
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
    ctx.waitUntil(saveCartTrack(env, uid, [], "", tier).catch(() => {}));
    return Response.json({ ok: true, id, total, qty, notes, bank, tierName: TIER_NAME[tier], upgraded: tier !== prevTier, discount: coupon ? coupon.amt : 0, earned: order.earned ? order.earned.amt : 0 });
  }
  return new Response("Not found", { status: 404 });
}

// ---------- 折抵券（下次訂購使用） ----------
// 活動：期間內「指定系列」商品的訂單金額（不用整箱）達標，就送折抵券；付款後生效，30 天內使用，下次訂單滿券面 5 倍可折抵
export const CAMPAIGNS = [
  { id: "SR1025", name: "三麗鷗・吉伊卡哇滿額回饋", from: "2026-10-22", to: "2026-10-25", cat: ["三麗鷗", "吉伊卡哇"], tiers: [[30000, 1000], [20000, 600], [10000, 300], [3000, 100]], days: 30, minX: 5 },
];
const twDay = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export function caseN(it) { const m = String((it && (it.pk || it.pack)) || "").match(/(?:入数|入數|装箱数|裝箱數)\s*(\d+)/); return m ? +m[1] : 0; }
export function activeCampaign(day = twDay()) { return CAMPAIGNS.find((c) => day >= c.from && day <= c.to) || null; }
// 這張訂單符合活動的金額（只算指定系列的品項）→ 可以拿到多少折抵券
export function campaignEarn(lines, camp) {
  if (!camp) return { amt: 0, base: 0 };
  let base = 0;
  for (const l of lines) { if (!l.mem && (l.c || []).some((c) => [].concat(camp.cat).includes(c))) base += l.sub; }
  const t = camp.tiers.find(([min]) => base >= min);
  return { amt: t ? t[1] : 0, base, next: camp.tiers.slice().reverse().find(([min]) => base < min) || null };
}
async function getCoupons(env, uid) { try { return JSON.parse((await env.SESSIONS.get("cp:" + uid)) || "[]"); } catch (e) { return []; } }
async function saveCoupons(env, uid, list) { await env.SESSIONS.put("cp:" + uid, JSON.stringify(list.slice(0, 60))); }
// 每張券的狀態：付款後生效／可使用／已使用／已過期／已失效（來源訂單取消）
export async function couponView(env, uid) {
  const list = await getCoupons(env, uid), today = twDay();
  const src = await Promise.all(list.map((c) => env.SESSIONS.get("o:" + c.src)));
  return list.map((c, i) => {
    const o = JSON.parse(src[i] || "null"), st = o ? o.status : "";
    const status = c.used ? "已使用" : st === "已取消" ? "已失效" : c.exp < today ? "已過期" : ["已付款", "已出貨"].includes(st) ? "可使用" : "付款後生效";
    return { id: c.id, amt: c.amt, min: c.min, name: c.name, exp: c.exp, at: c.at, src: c.src, used: c.used || "", status };
  });
}
export async function couponText(env, uid, link) {
  const v = await couponView(env, uid), camp = activeCampaign();
  const ok = v.filter((c) => c.status === "可使用"), wait = v.filter((c) => c.status === "付款後生效");
  const sc = await shipCoupons(env, uid);
  let t = shipCouponLine(sc) + "\n" + SHIP_RULE + "\n\n" + (ok.length || wait.length ? "🎟 您的折抵券\n\n" + [...ok, ...wait].map((c) => `・NT$${c.amt} 折抵券（${c.name}）\n　${c.status === "可使用" ? "✅ 可使用" : "⏳ 付款後生效"}・訂單滿 NT$${c.min.toLocaleString()} 可用・有效到 ${c.exp.slice(5).replace("-", "/")}`).join("\n") : "目前沒有可使用的折抵券喔");
  if (camp) t += `\n\n🎀 ${camp.name}進行中（${camp.from.slice(5).replace("-", "/")}～${camp.to.slice(5).replace("-", "/")}）\n${[].concat(camp.cat).join("、")}商品訂單滿額：${camp.tiers.slice().reverse().map(([a, b]) => `滿 $${a.toLocaleString()} 送 $${b.toLocaleString()}`).join("、")}`;
  return t + `\n\n下單時在購物車選擇折抵券就會自動扣除👇\n${link}`;
}
async function saveCartTrack(env, uid, lines, name, tier) {
  const idx = JSON.parse((await env.SESSIONS.get("carts")) || "[]").filter((u) => u !== uid);
  if (!lines.length) { await env.SESSIONS.delete("ct:" + uid); await env.SESSIONS.put("carts", JSON.stringify(idx)); return; }
  const prev = JSON.parse((await env.SESSIONS.get("ct:" + uid)) || "null");
  const now = Date.now();
  await env.SESSIONS.put("ct:" + uid, JSON.stringify({ uid, name: name || "", tier, lines, total: lines.reduce((a, l) => a + l.price * l.q, 0), qty: lines.reduce((a, l) => a + l.q, 0), at: now, since: prev ? prev.since : now, reminded: prev && prev.reminded && prev.sig === sigOf(lines) ? prev.reminded : 0, sig: sigOf(lines) }), { expirationTtl: 30 * 86400 });
  idx.unshift(uid); await env.SESSIONS.put("carts", JSON.stringify(idx.slice(0, 300)));
}
const sigOf = (lines) => lines.map((l) => l.k + ":" + l.q).sort().join(",");
export async function cartList(env) {
  const idx = JSON.parse((await env.SESSIONS.get("carts")) || "[]");
  const rows = await Promise.all(idx.map((u) => env.SESSIONS.get("ct:" + u)));
  return rows.map((r) => JSON.parse(r || "null")).filter(Boolean).sort((a, b) => b.at - a.at);
}
const agoTxt = (ms) => { const m = Math.floor((Date.now() - ms) / 60000); return m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.floor(m / 60)} 小時前` : `${Math.floor(m / 1440)} 天前`; };
export async function cartReport(env) {
  const L = await cartList(env);
  if (!L.length) return "🛒 目前沒有客人的購物車有東西\n（只記錄用專屬連結進商城的客人；訪客的購物車只存在他自己手機）";
  return `🛒 購物車還沒結帳的客人（${L.length} 位）\n\n` + L.slice(0, 20).map((c) => `👤 ${c.name || "（未知）"}｜${TIER_NAME[c.tier] || ""}｜${agoTxt(c.at)}更新${c.reminded ? "｜已提醒" : ""}\n` + c.lines.slice(0, 8).map((l) => `・${l.n} ×${l.q}`).join("\n") + (c.lines.length > 8 ? `\n…還有 ${c.lines.length - 8} 款` : "") + `\n共 ${c.lines.length} 款 ${c.qty} 件・NT$${c.total.toLocaleString()}`).join("\n\n") + (L.length > 20 ? `\n\n…還有 ${L.length - 20} 位，請看後台「購物車」` : "");
}
// 放了 6 小時以上沒結帳 → 提醒一次（11:00～21:00 才傳；內容改了會重新計時）
export async function runCartReminders(env, deps, opt = {}) {
  const h = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (!opt.force && (h < 11 || h >= 21 || (await env.SESSIONS.get("cartremind")) === "off")) return 0;
  let n = 0;
  for (const c of await cartList(env)) {
    if (opt.uid && c.uid !== opt.uid) continue;
    if (!opt.force && (c.reminded || Date.now() - c.at < 6 * 3600e3)) continue;
    const link = await shopLink(env, c.uid);
    const text = `${c.name ? c.name + " " : ""}您好～您的購物車裡還有 ${c.lines.length} 款商品（${c.qty} 件）還沒結帳喔🛒\n\n${c.lines.slice(0, 5).map((l) => "・" + l.n + " ×" + l.q).join("\n")}${c.lines.length > 5 ? "\n…" : ""}\n\n部分商品有結單日或數量限制，要下單的話點這裡繼續👇\n${link}\n有任何問題直接跟我們說～`;
    const r = await deps.lineApi(env, "/v2/bot/message/push", { to: c.uid, messages: [{ type: "text", text }] });
    c.reminded = Date.now(); await env.SESSIONS.put("ct:" + c.uid, JSON.stringify(c), { expirationTtl: 30 * 86400 });
    if (!r || !r.ok) console.log("cart remind failed", c.uid); else n++;
  }
  return n;
}
// ---------- 湊單邀請：還沒湊滿的廠商，LINE 提醒全部買家一起湊（一則訊息最多列 3 家廠商）----------
// 每家廠商最多 3 天發一次、每位客人最多 1 天收一則；11:00～21:00 才發；LINE 傳「湊單提醒 關」可關掉
export async function mfrLink(env, uid, m) { return (await shopLink(env, uid)) + "&mf=" + encodeURIComponent(m); }
export async function runPoolReminders(env, deps, opt = {}) {
  const h = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (!opt.force && (h < 11 || h >= 21 || (await env.SESSIONS.get("poolremind")) === "off")) return { sent: 0, done: [] };
  const P = await getPools(env), need = P.need || POOL_NT, owner = await env.SESSIONS.get("owner");
  const ms = [];
  for (const [m, p] of Object.entries(P.pools || {}).sort((a, b) => b[1].pct - a[1].pct)) {
    if (opt.only && m !== opt.only) continue;
    if (p.nt >= need || (!opt.force && p.pct < 20)) continue;
    if (!opt.force && Date.now() - Number((await env.SESSIONS.get("pr:m:" + m)) || 0) < 3 * 86400e3) continue;
    ms.push([m, p]);
  }
  if (!ms.length) return { sent: 0, done: [] };
  // 全部買家：下過單的＋傳過訊息的＋有購物車的
  const orders = await allOrders(env, 500), uids = new Set();
  for (const o of orders) uids.add(o.uid);
  try { for (const c of await cartList(env)) uids.add(c.uid); } catch (e) {}
  try { const ks = await env.SESSIONS.list({ prefix: "n:" }); const v = await Promise.all(ks.keys.slice(0, 1000).map((k) => env.SESSIONS.get(k.name))); v.forEach((u) => u && uids.add(u)); } catch (e) {}
  uids.delete(owner); uids.delete(null); uids.delete(undefined);
  const top = ms.slice(0, 3); let sent = 0; const RT = await mfrRatios(env, deps);
  for (const uid of uids) {
    if (!/^U[0-9a-f]{32}$/.test(uid)) continue;
    if (!opt.force && Date.now() - Number((await env.SESSIONS.get("pr:u:" + uid)) || 0) < 86400e3) continue;
    const mine = new Set(orders.filter((o) => o.uid === uid && o.status === "已付款").map((o) => o.id)), ut = await getTier(env, uid);
    const parts = [];
    for (const [m, p] of top) parts.push(`📦 ${m}：已湊 ${p.pct}%，還差 ${Math.max(0, 100 - p.pct)}%${p.orders.some((id) => mine.has(id)) ? "（您的訂單也在這批）" : ""}\n👉 ${await mfrLink(env, uid, m)}`);
    const text = `這幾家廠商正在湊單，一起湊就能早點向日本叫貨🙌（每家湊滿${POOL_SHOW} 就叫貨）\n同一家廠商的商品都能一起湊（不同角色、系列都可以），湊滿後約 2～3 週到貨。\n\n${parts.join("\n\n")}\n\n點連結就會直接列出那家廠商的所有商品～`;
    const r = deps.lineApi ? await deps.lineApi(env, "/v2/bot/message/push", { to: uid, messages: [{ type: "text", text }] }).catch(() => null) : null;
    await env.SESSIONS.put("pr:u:" + uid, String(Date.now()), { expirationTtl: 3 * 86400 });
    if (r && r.ok !== false) sent++;
  }
  for (const [m] of top) await env.SESSIONS.put("pr:m:" + m, String(Date.now()), { expirationTtl: 30 * 86400 });
  const done = top.map(([m, p]) => `${m}（${p.pct}%）`);
  if (sent && owner && deps.lineApi && !opt.quiet) await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `📣 已發湊單邀請給全部買家 ${sent} 位：\n${done.join("、")}` }] }).catch(() => {});
  return { sent, done };
}
// ---------- 製造商湊單（同一家製造商累積滿人民幣 4,000 元才能向日本叫貨） ----------
export const POOL_MIN = 4000; // 人民幣（廠商規定）
export const ASK_AT_POOL = false; // 改成到貨時才問客人要不要先寄
export const POOL_SHOW = "約 NT$30,000"; // 對客人說的門檻（實際叫貨仍以進價判斷，不對外說明）
export const POOL_NT = 20000; // 對客人顯示的台幣門檻；人民幣 4,000 × 當天匯率超過 2 萬就跟著調高
export const poolNeed = (rate) => Math.max(POOL_NT, Math.ceil(POOL_MIN * (rate || 0)));
const MFR = [[/^309 /, "三麗鷗 309"], [/^CRUX/, "CRUX"], [/^Nakajima/, "Nakajima"], [/^T's Factory/, "T's Factory"], [/^Kamio/, "Kamio"], [/^J's Planning/, "J's Planning"],
  [/^萬代/, "萬代南夢宮"], [/^角色雜貨・背包|^企鵝家族/, "Unic"], [/^OST/, "OST"], [/^A Planning/, "A Planning"], [/^Sun Arrow/, "Sun Arrow"], [/^Hatakeyama/, "畠山"],
  [/^森本/, "森本產業"], [/^日本現貨/, "中央煽賣"], [/^RE-MENT/, "RE-MENT"], [/^三麗鷗 (出門毛茸茸風|黑色螢光系列|黑白單色系列)|^幽遊白書/, "K-company"], [/^Marimo/, "Marimo Craft"],
  [/^San-X/, "San-X"], [/^Ensky/, "Ensky"], [/^GPS/, "GPS"], [/^NIC/, "NIC"], [/^Smiski/, "Dreams"], [/^Tomantoys/, "Tomantoys"], [/^景品 FuRyu/, "FuRyu 景品"], [/^景品 SEGA/, "SEGA 景品"], [/^景品 Eikoh/, "Eikoh 景品"]];
export function mfrOf(b) { b = String(b || ""); for (const [r, n] of MFR) if (r.test(b)) return n; return b.split(" ")[0] || "其他"; }
async function cnyRate(env) { try { const r = JSON.parse((await env.SESSIONS.get("rates")) || "null"); if (r && r.CNY) return r.CNY; } catch (e) {} return 4.9; }
const lineCostNT = (o, l) => (l.mem ? 0 : (l.cost != null ? l.cost : l.price - (o.tier === "vip" ? 50 : 80))) * l.q;
// 已付款、還沒叫貨的部分 → 依製造商加總（人民幣），湊滿就通知老闆
export async function computePools(env, deps = {}) {
  const rate = await cnyRate(env), need = poolNeed(rate), orders = await allOrders(env, 500);
  const pools = {};
  for (const o of orders) {
    if (o.status !== "已付款") continue;
    for (const l of o.lines || []) {
      if (l.mem) continue;
      const m = l.m || mfrOf(l.b);
      if ((o.po && o.po[m]) || (o.sh && o.sh[m]) || (o.defer && o.defer[m])) continue;
      const p = (pools[m] = pools[m] || { nt: 0, orders: [], since: o.paidAt || o.at });
      p.nt += lineCostNT(o, l);
      if (!p.orders.includes(o.id)) p.orders.push(o.id);
      if ((o.paidAt || o.at) < p.since) p.since = o.paidAt || o.at;
    }
  }
  const tAt = new Map(orders.map((o) => [o.id, o.paidAt || o.at]));
  for (const m in pools) { pools[m].orders.sort((a, b) => String(tAt.get(a)).localeCompare(String(tAt.get(b)))); pools[m].nt = Math.round(pools[m].nt); pools[m].pct = Math.min(100, Math.floor((pools[m].nt / need) * 100)); }
  const prev = JSON.parse((await env.SESSIONS.get("pools")) || "{}"), notified = prev.notified || {};
  const owner = await env.SESSIONS.get("owner");
  for (const m in pools) {
    const p = pools[m], sig = p.orders.slice().sort().join(",");
    if (p.nt >= need && notified[m] !== sig && owner && deps.lineApi) {
      await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `📦 ${m} 已湊滿叫貨金額！\n已付款待叫貨：NT$${p.nt.toLocaleString()}（門檻 NT$${need.toLocaleString()}）\n訂單 ${p.orders.length} 筆：${p.orders.join("、")}\n\n請到後台「叫貨」查看要叫的商品，叫完傳「叫貨 ${m} 完成」` }] }).catch(() => {});
      notified[m] = sig;
    }
    if (ASK_AT_POOL && p.nt >= need && deps.lineApi) {
      const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
      for (const id of p.orders) {
        const o = orders.find((x) => x.id === id);
        if (!o || (o.ask && o.ask[m])) continue;
        o.ask = o.ask || {}; o.ask[m] = { at: now, ans: "" };
        await saveOrder(env, o);
        const its = o.lines.filter((l) => !l.mem && (l.m || mfrOf(l.b)) === m);
        await deps.lineApi(env, "/v2/bot/message/push", { to: o.uid, messages: [{ type: "text", text: `🎉 ${m} 已經湊滿發貨金額囉！\n您的訂單 ${id} 裡這家的商品：\n${its.slice(0, 8).map((l) => `・${l.n} ×${l.q}`).join("\n")}${its.length > 8 ? `\n…共 ${its.length} 款` : ""}\n\n要這批一起向日本叫貨、到貨就寄出嗎？\n${SHIP_RULE}\n\n想等其他廠商一起寄可以選「順延」，這批會先讓排下一位的客人出貨，下一批湊滿再問您～`, quickReply: { items: [{ type: "action", action: { type: "message", label: "✅ 這次出貨", text: `這次出貨 ${id} ${m}` } }, { type: "action", action: { type: "message", label: "⏸ 順延下一批", text: `順延 ${id} ${m}` } }] } }] }).catch(() => {});
      }
    }
  }
  const out = { at: Date.now(), rate, need, pools, notified };
  await env.SESSIONS.put("pools", JSON.stringify(out));
  return out;
}
// ---------- 運費券（每月發放，取代原本的會員免運） ----------
export const SHIP_DOM = 60, SHIP_KG = 220;
export const SC_QUOTA = { vip: { dom: 10, intl: 10 }, member: { dom: 5, intl: 0 }, none: { dom: 0, intl: 0 } };
const ymTW = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
export async function shipCoupons(env, uid) {
  const tier = await getTier(env, uid), q = SC_QUOTA[tier] || SC_QUOTA.none, ym = ymTW();
  const used = JSON.parse((await env.SESSIONS.get(`sc:${uid}:${ym}`)) || '{"dom":0,"intl":0}');
  return { tier, ym, quota: q, used, dom: Math.max(0, q.dom - used.dom), intl: Math.max(0, q.intl - used.intl) };
}
async function useShipCoupon(env, uid, kind) {
  const c = await shipCoupons(env, uid);
  if (!(c[kind] > 0)) return false;
  c.used[kind] = (c.used[kind] || 0) + 1;
  await env.SESSIONS.put(`sc:${uid}:${c.ym}`, JSON.stringify(c.used), { expirationTtl: 70 * 86400 });
  return true;
}
export function shipCouponLine(c) {
  if (!c || (!c.quota.dom && !c.quota.intl)) return "🚚 運費券：加入會員每月送（一般會員 5 張國內、VIP 10 張國內＋10 張國際）";
  return `🚚 本月運費券：國內 ${c.dom}/${c.quota.dom} 張${c.quota.intl ? `、國際 ${c.intl}/${c.quota.intl} 張` : ""}（每月 1 號重新發放）`;
}
export const SHIP_RULE = `每次出貨國內運費 NT$${SHIP_DOM}，國際運費依物流公司報價（約每公斤 NT$${SHIP_KG}）；會員出貨時自動用運費券折抵`;
// 客人回覆「這次出貨／順延」
export async function customerShipReply(env, uid, text, deps = {}) {
  const m0 = String(text || "").match(/^(這次出貨|順延)\s+(ZO\w{10})\s+(.+)$/i);
  if (!m0) return null;
  const id = m0[2].toUpperCase(), m = m0[3].trim(), o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o || o.uid !== uid) return "找不到這張訂單，可以傳「我的訂單」查看～";
  if (!orderMfrs(o).includes(m)) return `訂單 ${id} 裡沒有「${m}」的商品喔`;
  if (o.po && o.po[m]) return `訂單 ${id} 的 ${m} 商品已經向日本叫貨囉，到貨就會寄出～`;
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  o.ask = o.ask || {}; o.ask[m] = Object.assign(o.ask[m] || {}, { ans: m0[1] === "順延" ? "順延" : "出貨", ansAt: now });
  o.defer = o.defer || {};
  if (m0[1] === "順延") o.defer[m] = { at: now }; else delete o.defer[m];
  await saveOrder(env, o);
  try { await computePools(env, deps); } catch (e) {}
  const owner = await env.SESSIONS.get("owner");
  if (owner && deps.lineApi) await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `${m0[1] === "順延" ? "⏸" : "✅"} ${o.lineName || "客人"}（${id}）${m}：${m0[1] === "順延" ? "選擇順延到下一批" : "確認這次出貨"}` }] }).catch(() => {});
  return m0[1] === "順延" ? `好的👌 訂單 ${id} 的 ${m} 商品順延到下一批\n這批會先讓排下一位的客人出貨，下一批湊滿時會再問您～` : `好的👌 訂單 ${id} 的 ${m} 商品會在這批一起向日本叫貨，到貨就寄出～\n${SHIP_RULE}`;
}
// 每家廠商「售價／進價」平均比例（一般價、VIP 價），把進價門檻換成客人看得懂的會員價金額
export async function mfrRatios(env, deps) {
  try { const r = JSON.parse((await env.SESSIONS.get("mratio")) || "null"); if (r && Date.now() - r.at < 12 * 3600e3) return r.r; } catch (e) {}
  if (!deps || !deps.loadCatalog) { try { return (JSON.parse((await env.SESSIONS.get("mratio")) || "null") || {}).r || {}; } catch (e) { return {}; } }
  const acc = {};
  for (const x of await deps.loadCatalog(env)) { if (x.hid || !(x.g > 80)) continue; const m = mfrOf(x.b), a = (acc[m] = acc[m] || [0, 0, 0]); a[0] += x.g - 80; a[1] += x.g; a[2] += x.v || x.g - 30; }
  const r = {}; for (const m in acc) r[m] = { g: +(acc[m][1] / acc[m][0]).toFixed(3), v: +(acc[m][2] / acc[m][0]).toFixed(3) };
  await env.SESSIONS.put("mratio", JSON.stringify({ at: Date.now(), r }));
  return r;
}
export const tierRatio = (R, m, tier) => { const x = R && R[m]; return x ? (tier === "vip" ? x.v : x.g) : 1; };
const r100 = (n) => Math.ceil(n / 100) * 100;
export async function getPools(env) { return JSON.parse((await env.SESSIONS.get("pools")) || "null") || { pools: {}, need: poolNeed(await cnyRate(env)), rate: await cnyRate(env) }; }
// 一張訂單裡每家製造商目前的狀態（給客人看）
export const orderMfrs = (o) => [...new Set((o.lines || []).filter((l) => !l.mem).map((l) => l.m || mfrOf(l.b)))];
const mmdd = (t) => (t ? String(t).slice(5, 10).replace("-", "/") : "");
export function mfrStatusSync(o, P, need, RT) {
  need = need || POOL_NT;
  const out = [], gap = (p) => { const pc = p ? p.pct : 0; return pc < 100 ? `・還差 ${100 - pc}%` : ""; };
  for (const m of orderMfrs(o)) {
    const sh = o.sh && o.sh[m];
    if (sh) out.push({ m, s: "已出貨（" + mmdd(sh.at) + "）" + (sh.track ? "・物流單號 " + sh.track : ""), k: "sh" });
    else if (o.status === "已出貨") out.push({ m, s: "已出貨", k: "sh" });
    else if (o.status === "已取消") out.push({ m, s: "已取消", k: "x" });
    else if (o.arr && o.arr[m]) { const w = orderMfrs(o).filter((x) => !(o.sh && o.sh[x]) && !(o.arr && o.arr[x])); out.push({ m, s: "已到貨（" + mmdd(o.arr[m].at) + "）" + (!w.length || o.early === "先寄" ? "，準備出貨" : o.early === "等齊" ? "，幫您留著等其他商品一起寄" : "，等您回覆要不要先寄"), k: "arr" }); }
    else if (o.po && o.po[m]) out.push({ m, s: "已向日本叫貨（" + mmdd(o.po[m].at) + "），約 2～3 週到貨，到貨就先寄這家的商品", k: "po" });
    else if (o.status === "已付款" && o.defer && o.defer[m]) out.push({ m, s: "已順延到下一批（下一批湊滿會再問您）", k: "defer" });
    else if (o.status !== "已付款") { const p = P[m]; out.push({ m, s: `付款後開始湊單（這家目前 ${p ? p.pct : 0}%，湊滿${POOL_SHOW} 叫貨）`, k: "wait" }); }
    else { const p = P[m], qi = p ? p.orders.indexOf(o.id) + 1 : 0, qn = qi > 0 ? `・排第 ${qi} 位（先付款先寄）` : ""; out.push({ m, s: (p && p.nt >= need ? "已湊滿，準備向日本叫貨" : `湊單中 ${p ? p.pct : 0}%${gap(p)}（湊滿${POOL_SHOW} 叫貨）`) + qn, k: "pool" }); }
  }
  return out;
}
export async function orderMfrStatus(env, o) { const G = await getPools(env); return mfrStatusSync(o, G.pools, G.need || poolNeed(G.rate), await mfrRatios(env)); }
async function myOrders(env, uid, n = 5) {
  const ids = JSON.parse((await env.SESSIONS.get("ou:" + uid)) || "[]").slice(0, n);
  const out = [];
  for (const r of await Promise.all(ids.map((id) => env.SESSIONS.get("o:" + id)))) { const o = JSON.parse(r || "null"); if (o) out.push(o); }
  return out;
}
// 客人在 LINE 查訂單
export async function customerOrders(env, uid, link) {
  const list = await myOrders(env, uid, 5);
  const lemai = "";
  if (!list.length) return `目前沒有線上訂購網站的訂單紀錄喔${lemai}\n\n🛒 線上訂購：${link}`;
  const mst = await Promise.all(list.map((o) => orderMfrStatus(env, o)));
  const rows = list.map((o, i) => `📦 ${o.id}（${o.at.slice(0, 10)}）\n${o.qty} 件　NT$${o.total.toLocaleString()}　${o.form.pay || "轉帳"}　狀態：${o.status}${o.track ? "\n物流單號：" + o.track : ""}${mst[i].length > 1 && o.status !== "已取消" || (mst[i].length && !["已出貨", "已取消"].includes(o.status)) ? "\n" + mst[i].map((x) => `　・${x.m}：${x.s}`).join("\n") : ""}`);
  return `您最近的訂單：\n\n${rows.join("\n\n")}\n\n要看完整明細，請點：\n${link}&v=orders\n（或傳訂單編號給我）${lemai}`;
}
const strike = (t) => [...String(t)].map((c) => c + "\u0336").join("");
function shippedMark(o, l) { const m = l.m || mfrOf(l.b); return o.sh && o.sh[m] ? "✅已出貨 " : ""; }
export async function customerOrderDetail(env, uid, id) {
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o || o.uid !== uid) return null;
  const mst = await orderMfrStatus(env, o);
  return `訂單 ${o.id}（${o.at}）\n狀態：${o.status}${(mst.length > 1 && o.status !== "已取消") || (mst.length && !["已出貨", "已取消"].includes(o.status)) ? "\n" + mst.map((x) => `・${x.m}：${x.s}`).join("\n") : ""}${o.paid5 ? "　後五碼 " + o.paid5 : ""}${o.track ? "\n物流單號：" + o.track : ""}\n\n${orderText(o, false)}\n\n收件人：${o.form.name}\n寄送：${o.form.ship}　${o.form.addr}`;
}
async function payInfo(env, pay) {
  return (await env.SESSIONS.get(pay === "LINE Pay" ? "linepay" : "bank")) || "";
}
const payHow = (pay) => pay === "LINE Pay" ? "付款後請回到 LINE 傳「付款截圖」給我們" : "轉帳後請回到 LINE 傳「後五碼」和「轉帳截圖」給我們";
function orderText(o, withRules = true) {
  const items = o.lines.map((l) => shippedMark(o, l) ? `・✅已出貨 ${strike(l.n + " ×" + l.q)}` : `・${l.n} ×${l.q}　NT$${l.sub.toLocaleString()}`).join("\n");
  return `訂單編號：${o.id}\n${items}\n\n共 ${o.qty} 件　${o.coupon ? `小計 NT$${(o.subtotal || o.total + o.coupon.amt).toLocaleString()}\n🎟 折抵券 −NT$${o.coupon.amt}\n` : ""}合計 NT$${o.total.toLocaleString()}（${TIER_NAME[o.tier]}價）${o.earned ? `\n🎁 ${o.earned.camp}：付款後送 NT$${o.earned.amt} 折抵券（下次使用）` : ""}\n運費：依廠商分批寄出，每次出貨國內 NT$${SHIP_DOM}，國際依物流報價（約每公斤 NT$${SHIP_KG}），會員用運費券折抵${o.shipDue ? `\n已出貨運費：NT$${o.shipDue.toLocaleString()}` : ""}` +
    `\n付款方式：${o.form.pay || "轉帳"}` +
    (withRules && o.notes.length ? `\n\n⚠️ 訂購規則提醒：\n${o.notes.slice(0, 8).map((n) => "・" + n).join("\n")}` : "");
}
// 訂單品項照片：新訂單直接存 img；舊訂單用目錄補
let IMGMAP = null, IMGMAP_AT = 0;
export async function fillLineImgs(env, deps, orders) {
  const need = orders.some((o) => (o.lines || []).some((l) => !l.mem && !l.img));
  if (!need || !deps || !deps.loadCatalog) return;
  if (!IMGMAP || Date.now() - IMGMAP_AT > 3600e3) {
    try { const all = await deps.loadCatalog(env); IMGMAP = new Map(); for (const x of all) { if (!x.img) continue; IMGMAP.set(keyOf(x), x.img); if (x.jan) IMGMAP.set("j:" + x.jan, x.img); } IMGMAP_AT = Date.now(); } catch (e) { return; }
  }
  for (const o of orders) for (const l of o.lines || []) if (!l.mem && !l.img) l.img = IMGMAP.get(l.k) || (l.jan ? IMGMAP.get("j:" + l.jan) : "") || "";
}
// 訂單商品卡片（附照片），一張卡最多 12 款
function orderCards(o, title) {
  const L = (o.lines || []).filter((l) => !l.mem && l.img).slice(0, 12);
  if (!L.length) return null;
  return { type: "flex", altText: (title + " " + o.id).slice(0, 300), contents: { type: "carousel", contents: L.map((l) => ({ type: "bubble", size: "micro",
    hero: { type: "image", url: l.img, size: "full", aspectRatio: "1:1", aspectMode: "cover" },
    body: { type: "box", layout: "vertical", spacing: "xs", paddingAll: "10px", contents: [
      { type: "text", text: l.n, size: "xs", wrap: true, maxLines: 3, weight: "bold" },
      { type: "text", text: `×${l.q}　NT$${(l.sub || l.price * l.q).toLocaleString()}`, size: "xs", color: "#9E1B1B", weight: "bold" } ] } })) } };
}
async function notifyOrder(env, deps, o, bank) {
  try {
    const owner = await env.SESSIONS.get("owner");
    if (owner) {
      const oc = orderCards(o, "新訂單商品");
      await deps.lineApi(env, "/v2/bot/message/push", { to: owner, messages: [...(oc ? [oc] : []), { type: "text", text:
        `🛒 新訂單！\n客人：${o.lineName}（${TIER_NAME[o.tier]}${o.memGranted && o.prevTier !== o.tier ? `，下單會員方案已自動從${TIER_NAME[o.prevTier]}升級` : ""}）\n${orderText(o)}\n\n收件人：${o.form.name}\n電話：${o.form.phone}\n寄送：${o.form.ship}　${o.form.addr}` +
        (o.form.note ? `\n備註：${o.form.note}` : "") }] });
    }
    const cardsMsg = orderCards(o, "訂購商品");
    await deps.lineApi(env, "/v2/bot/message/push", { to: o.uid, messages: [...(cardsMsg ? [cardsMsg] : []), { type: "text", text:
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
  if (ok) { try { await computePools(env, deps); } catch (e) {} }
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
// ---------- 批次到貨（每批＝同一廠商湊滿 NT$20,000 叫的一次貨） ----------
export async function listBatches(env, n = 60) {
  const ids = JSON.parse((await env.SESSIONS.get("batches")) || "[]").slice(0, n);
  return (await Promise.all(ids.map((id) => env.SESSIONS.get("batch:" + id)))).filter(Boolean).map((x) => JSON.parse(x));
}
// 實際進價：叫貨後填實際付給廠商的日圓＋運費，報表的成本照實際比例調整（售價不受影響）
export async function costFactors(env) {
  const F = new Map();
  for (const b of await listBatches(env, 200)) if (b.cost && b.cost.est > 0) { const f = b.cost.nt / b.cost.est; for (const id of b.orders) F.set(id + "|" + b.m, f); }
  return F;
}
// 內部成本折扣（只影響報表淨利，不影響售價／湊單進度）：三麗鷗日幣商品實際 55 折進貨，售價仍照 65 折計算
const COST_RULE = { re: /三麗鷗|Sanrio|Hello Kitty|美樂蒂|酷洛米|大耳狗|布丁狗|帕恰狗|人魚漢頓|雙子星|山姆企鵝|大眼蛙|酷企鵝|可樂鈴|巧克力貓|優莎娜|栗子兔/, skip: /^(景品|日本現貨|萬代|RE-MENT|GPS)/, ratio: 0.55 / 0.65 };
let RAWK_SRC = null, RAWK_MAP = null;
function RAWK(items) { if (RAWK_SRC !== items) { RAWK_SRC = items; RAWK_MAP = new Map(items.map((x) => [keyOf(x), x])); } return RAWK_MAP; }
export const lineCostReal = (o, l, F) => {
  const c = lineCost(o, l); if (l.mem) return c;
  const f = F && F.get(o.id + "|" + (l.m || mfrOf(l.b))); if (f) return c * f;
  if (l.rc != null) return l.rc;
  if (l.cost != null && COST_RULE.re.test((l.b || "") + (l.n || "")) && !COST_RULE.skip.test(l.b || "")) return c * COST_RULE.ratio;
  return c;
};
async function setBatchCost(env, key, rest) {
  const bs = await listBatches(env, 200);
  const b = bs.find((x) => x.id.toUpperCase() === key.toUpperCase()) || bs.find((x) => x.m === key);
  if (!b) return `找不到批次「${key}」。傳「批次」看編號，或用廠商名，例如：進價 K-company ¥93291 運費1100`;
  const jm = rest.match(/[¥￥]?\s*([\d,]+)\s*(?:円|日圓|日幣)?/), rm = rest.match(/匯率\s*([\d.]+)/), sm = rest.match(/運費\s*\$?\s*([\d,]+)/), fm = rest.match(/(?:手續費|其他)\s*\$?\s*([\d,]+)/);
  const clean = rest.replace(/匯率\s*[\d.]+|運費\s*\$?\s*[\d,]+|(?:手續費|其他)\s*\$?\s*[\d,]+/g, "");
  const jm2 = clean.match(/[¥￥]?\s*([\d,]+)/);
  if (!jm2) return `請輸入實際付給廠商的日圓，例如：進價 ${b.id} ¥93291 運費1100（匯率不填就用今天的牌告）`;
  const jpy = Number(jm2[1].replace(/,/g, ""));
  let rate = rm ? Number(rm[1]) : null;
  if (!rate) { const r = JSON.parse((await env.SESSIONS.get("rates")) || "null"); rate = (r && r.JPY) || 0.21; }
  const ship = sm ? Number(sm[1].replace(/,/g, "")) : 0, fee = fm ? Number(fm[1].replace(/,/g, "")) : 0;
  let est = 0;
  for (const id of b.orders) { const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null"); if (!o || o.status === "已取消") continue; for (const l of o.lines) if (!l.mem && (l.m || mfrOf(l.b)) === b.m) est += lineCost(o, l) * l.q; }
  const nt = Math.round(jpy * rate + ship + fee);
  b.cost = { jpy, rate, ship, fee, nt, est: Math.round(est), at: nowMin() };
  await env.SESSIONS.put("batch:" + b.id, JSON.stringify(b));
  const d = Math.round(est) - nt;
  return `好👌 ${b.id}（${b.m}）實際進價已記錄\n日圓 ¥${jpy.toLocaleString()} × ${rate}${ship ? ` ＋運費 $${ship.toLocaleString()}` : ""}${fee ? ` ＋其他 $${fee.toLocaleString()}` : ""}\n＝實際成本 NT$${nt.toLocaleString()}（原本估 NT$${Math.round(est).toLocaleString()}，${d >= 0 ? "省了" : "多花"} NT$${Math.abs(d).toLocaleString()}）\n銷售報表的淨利會照實際成本計算，商城售價不變`;
}
// 訂單裡已到貨、還沒寄的廠商；還沒到貨的廠商
export function arrivalState(o) {
  const ms = orderMfrs(o).filter((m) => !(o.sh && o.sh[m]));
  const arrived = ms.filter((m) => o.arr && o.arr[m]), waiting = ms.filter((m) => !(o.arr && o.arr[m]));
  const choice = o.early || "";
  const ready = arrived.length && (!waiting.length || choice === "先寄");
  return { arrived, waiting, ready: !!ready, choice };
}
async function batchArrived(env, deps, key) {
  const bs = await listBatches(env, 300);
  let b = bs.find((x) => x.id.toUpperCase() === key.toUpperCase()) || bs.find((x) => x.m === key && x.status === "已叫貨");
  if (!b) return `找不到批次「${key}」。傳「批次」可以看所有批次`;
  if (b.status === "已到貨") return `批次 ${b.id}（${b.m}）已經標記到貨過了`;
  const now = nowMin(); b.status = "已到貨"; b.arrAt = now;
  await env.SESSIONS.put("batch:" + b.id, JSON.stringify(b));
  let ready = 0, asked = 0;
  for (const id of b.orders) {
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (!o || o.status === "已取消" || (o.sh && o.sh[b.m])) continue;
    o.arr = o.arr || {}; o.arr[b.m] = { at: now, bid: b.id };
    const st = arrivalState(o);
    if (st.waiting.length && !o.early) {
      o.early = ""; o.earlyAsk = now;
      const its = o.lines.filter((l) => !l.mem && st.arrived.includes(l.m || mfrOf(l.b)));
      await deps.lineApi?.(env, "/v2/bot/message/push", { to: o.uid, messages: [{ type: "text", text: `📦 您的訂單 ${id} 有商品到貨囉！\n已到貨（${st.arrived.join("、")}）：\n${its.slice(0, 10).map((l) => `・${l.n} ×${l.q}`).join("\n")}${its.length > 10 ? `\n…共 ${its.length} 款` : ""}\n\n還在等：${st.waiting.join("、")}\n\n要先寄已到貨的商品嗎？\n・先寄：這次出貨運費 NT$${SHIP_DOM}（會員可用運費券折抵），國際運費另計\n・等齊再寄：先幫您留著，其他商品到了再一起寄，只算一次運費`, quickReply: { items: [{ type: "action", action: { type: "message", label: "🚚 先寄", text: `先寄 ${id}` } }, { type: "action", action: { type: "message", label: "⏳ 等齊再寄", text: `等齊再寄 ${id}` } }] } }] }).catch(() => {});
      asked++;
    } else ready++;
    await saveOrder(env, o);
  }
  return `好👌 批次 ${b.id}（${b.m}）已標記到貨\n・可以直接出貨：${ready} 筆\n・還有其他廠商沒到、已 LINE 問客人要不要先寄：${asked} 筆\n\n後台「叫貨」→「待出貨」會列出要寄的訂單`;
}
export async function earlyShipReply(env, uid, text, deps = {}) {
  const m0 = String(text || "").match(/^(先寄|等齊再寄)\s+(ZO\w{10})$/i);
  if (!m0) return null;
  const id = m0[2].toUpperCase(), o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o || o.uid !== uid) return "找不到這張訂單，可以傳「我的訂單」查看～";
  const st = arrivalState(o);
  if (!st.arrived.length) return `訂單 ${id} 目前沒有已到貨、還沒寄的商品喔`;
  o.early = m0[1] === "先寄" ? "先寄" : "等齊"; o.earlyAt = nowMin();
  await saveOrder(env, o);
  const owner = await env.SESSIONS.get("owner");
  if (owner) await pushTo(deps, env, owner, `${o.early === "先寄" ? "🚚" : "⏳"} ${o.lineName || "客人"}（${id}）：${o.early === "先寄" ? "已到貨的商品要先寄（" + st.arrived.join("、") + "）" : "等其他商品到齊再一起寄"}`);
  return o.early === "先寄" ? `好的👌 訂單 ${id} 已到貨的商品（${st.arrived.join("、")}）會先寄出\n這次運費國內 NT$${SHIP_DOM}（會員會先用運費券折抵），出貨時會再通知您～` : `好的👌 先幫您留著，等 ${st.waiting.join("、")} 到貨後一起寄，只算一次運費～`;
}
// 依廠商出貨：國內運費每次 NT$60、國際運費出貨時問老闆金額；會員先用運費券
const nowMin = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
async function pushTo(deps, env, to, text) { if (!deps.lineApi) return false; const r = await deps.lineApi(env, "/v2/bot/message/push", { to, messages: [{ type: "text", text }] }).catch(() => null); return !!(r && r.ok); }
async function shipPart(env, deps, id, rest) {
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o) return `找不到訂單 ${id}`;
  if (!["已付款", "已出貨"].includes(o.status)) return `訂單 ${id} 目前是「${o.status}」，付款後才能出貨`;
  const ms = orderMfrs(o), todo = ms.filter((x) => !(o.sh && o.sh[x]));
  if (!ms.length) { if (o.status === "已出貨") return `訂單 ${id} 已經是完成狀態了`; o.status = "已出貨"; o.doneAt = nowMin(); await saveOrder(env, o); return `好👌 ${id} 是會員費訂單（沒有實體商品），已標記完成`; }
  let group, tail;
  if (/^全部(\s|$)/.test(rest)) { group = todo; tail = rest.slice(2); }
  else if (/^已到貨(\s|$)/.test(rest)) { group = arrivalState(o).arrived; tail = rest.slice(3); }
  else { const m = ms.slice().sort((a, b) => b.length - a.length).find((x) => rest === x || rest.startsWith(x + " ") || rest.startsWith(x + "/")); if (!m) return `訂單 ${id} 裡沒有這家廠商。這張訂單的廠商：${ms.join("、")}\n格式：${id} 分批出貨 廠商名 物流單號 國際運費金額\n（整張一起寄：${id} 分批出貨 全部 物流單號 國際運費金額）`; group = [m]; tail = rest.slice(m.length); }
  if (!group.length) return `訂單 ${id} 的商品都已經出貨了`;
  if (group.some((x) => o.sh && o.sh[x])) return `訂單 ${id} 的 ${group.join("、")} 已經標記出貨過了`;
  let track = tail.replace(/^[\s/]+/, "").trim(), intlAmt = null;
  const am = track.match(/(?:國際(?:運費)?\s*\$?\s*|\$\s*)(\d+)/), kgm = track.match(/(\d+(?:\.\d+)?)\s*(?:kg|公斤)/i);
  if (am) { intlAmt = Number(am[1]); track = track.replace(am[0], "").trim(); }
  else if (kgm) { intlAmt = Math.ceil(Number(kgm[1]) * SHIP_KG); track = track.replace(kgm[0], "").trim(); }
  track = track.slice(0, 60);
  const domCp = await useShipCoupon(env, o.uid, "dom"), intlCp = await useShipCoupon(env, o.uid, "intl");
  const fee = { dom: domCp ? 0 : SHIP_DOM, domCp, intlCp, intl: intlCp ? 0 : intlAmt };
  const due = fee.dom + (fee.intl || 0), now = nowMin();
  o.shipDue = (o.shipDue || 0) + due;
  o.sh = o.sh || {};
  const key = group.join("＋");
  for (const x of group) o.sh[x] = { at: now, track, fee: x === group[0] ? fee : { same: group[0] }, batch: key };
  const left = ms.filter((x) => !o.sh[x]);
  o.early = "";
  if (!left.length) { o.statusBefore = o.status; o.status = "已出貨"; if (track) o.track = track; }
  await env.SESSIONS.put("o:" + id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
  const sc = await shipCoupons(env, o.uid);
  const items = o.lines.filter((l) => !l.mem && group.includes(l.m || mfrOf(l.b)));
  const pend = fee.intl === null;
  const msg = `🚚 您的訂單 ${id} ${left.length ? "有商品先出貨囉！" : ms.length > group.length ? "最後一批商品出貨囉！" : "出貨囉！"}\n${ms.length > 1 ? "廠商：" + group.join("、") + "\n" : ""}${items.slice(0, 15).map((l) => `・${l.n} ×${l.q}`).join("\n")}${items.length > 15 ? `\n…共 ${items.length} 款` : ""}${track ? "\n物流單號：" + track : ""}\n\n本次運費\n・國內：${domCp ? "已用國內運費券折抵 ✅" : "NT$" + SHIP_DOM}\n・國際：${intlCp ? "已用國際運費券折抵 ✅" : pend ? "依物流公司報價，確定後另外通知您" : "NT$" + fee.intl.toLocaleString()}${due ? `\n本次運費${pend ? "（目前）" : ""}合計 NT$${due.toLocaleString()}，客服會跟您確認付款～` : ""}\n${shipCouponLine(sc)}${left.length ? `\n\n其他廠商的商品（${left.join("、")}）到貨後會再寄出，可以傳「我的訂單」查看進度～` : ""}`;
  const sent = await pushTo(deps, env, o.uid, msg);
  return `好👌 ${id}「${group.join("、")}」已標記出貨${track ? "（物流單號 " + track + "）" : ""}\n運費：國內 ${domCp ? "用券" : "NT$" + SHIP_DOM}・國際 ${intlCp ? "用券" : pend ? "❓待填" : "NT$" + fee.intl}${due ? `，目前要跟客人收 NT$${due}` : ""}${left.length ? "\n還沒出貨：" + left.join("、") : "\n整張訂單都出貨了，狀態改成「已出貨」"}${sent ? "\n已通知客人" : ""}${pend ? `\n\n❓ 這次國際運費要收多少？請回覆：\n${id} 國際運費 金額\n例如：${id} 國際運費 440` : ""}`;
}
async function setIntlFee(env, deps, id, amt, mName) {
  const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
  if (!o) return `找不到訂單 ${id}`;
  const ent = Object.entries(o.sh || {}).filter(([m, v]) => v.fee && !v.fee.same && (!mName || m === mName || (v.batch || "").includes(mName)));
  const tgt = ent.find(([, v]) => v.fee.intl === null) || (mName ? ent[0] : null);
  if (!tgt) return `訂單 ${id} 沒有待填國際運費的出貨紀錄${ent.length ? "（要改已填的金額請加廠商名：" + id + " 國際運費 金額 廠商名）" : ""}`;
  const f = tgt[1].fee, old = f.intl || 0;
  if (f.intlCp) return `訂單 ${id} 這次出貨已用國際運費券折抵，不用收國際運費`;
  f.intl = amt; o.shipDue = (o.shipDue || 0) - old + amt;
  await env.SESSIONS.put("o:" + id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
  const sent = await pushTo(deps, env, o.uid, `📦 訂單 ${id}（${tgt[1].batch || tgt[0]}）的國際運費：NT$${amt.toLocaleString()}\n這次出貨運費合計 NT$${(f.dom + amt).toLocaleString()}（國內 ${f.domCp ? "用券" : "NT$" + f.dom}）\n客服會跟您確認付款，謝謝🙏`);
  return `好👌 ${id} 國際運費 NT$${amt}，這次出貨要跟客人收 NT$${f.dom + amt}${sent ? "\n已通知客人" : ""}`;
}
export async function shopOwnerCommand(env, text, deps = {}) {
  if (/^(叫貨|叫貨進度|湊單)$/.test(text)) { const P = await computePools(env, deps); const L = Object.entries(P.pools).sort((a, b) => b[1].nt - a[1].nt); return L.length ? "📦 製造商湊單進度（已付款、還沒叫貨，門檻 NT$" + P.need.toLocaleString() + "）\n\n" + L.map(([m, p]) => `${p.nt >= P.need ? "✅" : "⏳"} ${m}：NT$${p.nt.toLocaleString()}（${p.pct}%）・${p.orders.length} 筆訂單${p.nt >= P.need ? "・可以叫貨" : ""}`).join("\n") + "\n\n叫完貨傳「叫貨 廠商名 完成」，例如：叫貨 森本產業 完成" : "目前沒有已付款、待叫貨的訂單"; }
  const pm = text.match(/^叫貨\s+(.+?)\s*(完成|已叫)$/);
  if (pm) {
    const m = pm[1].trim(), now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
    const orders = await allOrders(env, 500); let n = 0, nt = 0;
    const bid = "B" + now.slice(5, 10).replace("-", "") + "-" + Date.now().toString(36).slice(-3).toUpperCase(), ids = [];
    for (const o of orders.slice().sort((a, b) => String(a.paidAt || a.at).localeCompare(String(b.paidAt || b.at)))) {
      if (o.status !== "已付款" || !(o.lines || []).some((l) => !l.mem && (l.m || mfrOf(l.b)) === m) || (o.po && o.po[m]) || (o.sh && o.sh[m])) continue;
      if (o.defer && o.defer[m]) { delete o.defer[m]; if (o.ask) delete o.ask[m]; await saveOrder(env, o); continue; } // 順延的客人回到下一批
      o.po = o.po || {}; o.po[m] = { at: now, bid }; await saveOrder(env, o); n++; ids.push(o.id);
      for (const l of o.lines) if (!l.mem && (l.m || mfrOf(l.b)) === m) nt += lineCostNT(o, l);
    }
    if (n) { await env.SESSIONS.put("batch:" + bid, JSON.stringify({ id: bid, m, at: now, orders: ids, nt: Math.round(nt), status: "已叫貨" })); const bi = JSON.parse((await env.SESSIONS.get("batches")) || "[]"); bi.unshift(bid); await env.SESSIONS.put("batches", JSON.stringify(bi.slice(0, 300))); }
    await computePools(env, deps);
    return n ? `好👌 ${m} 已標記叫貨，批次 ${bid}，共 ${n} 筆訂單\n貨備好／到貨時按後台「這批到貨了」，或傳「到貨 ${bid}」` : `找不到「${m}」已付款、待叫貨的訂單（廠商名稱要跟「叫貨」清單上的一樣）`;
  }
  if (/^(購物車|客人購物車|誰加購物車)$/.test(text)) return await cartReport(env);
  const crm = text.match(/^購物車提醒\s*(全部|U[0-9a-f]{32})$/);
  if (crm) { const n = await runCartReminders(env, deps, { force: true, uid: crm[1] === "全部" ? "" : crm[1] }); return n ? `好👌 已發購物車結帳提醒給 ${n} 位客人` : "目前沒有可以提醒的購物車"; }
  if (/^購物車提醒\s*(開|關|開啟|關閉)$/.test(text)) { const off = /關/.test(text); await env.SESSIONS.put("cartremind", off ? "off" : "on"); return off ? "好👌 已關閉購物車提醒" : "好👌 已開啟購物車提醒：客人放了 6 小時沒結帳，會在 11:00～21:00 傳一則提醒（每次只提醒一次）"; }
  const t = text.trim();
  const dm = t.match(/^(ZO\w{10})\s*差額已處理$/i);
  if (dm) {
    const id = dm[1].toUpperCase(), o = await env.SESSIONS.get("o:" + id, "json");
    if (!o) return `找不到訂單 ${id}`;
    const d = payDiff(o).trim();
    if (!d) return `${id} 目前沒有差額要處理`;
    o.diffDone = o.total; o.diffLog = (o.diffLog || []).concat({ at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " "), note: d.replace(/^⚠️\s*/, "") });
    await saveOrder(env, o);
    return `好👌 ${id} 差額已標記處理（${d.replace(/^⚠️\s*/, "")}）`;
  }
  const cm = t.match(/^進價\s+(\S+)\s+([\s\S]+)$/);
  if (cm) return await setBatchCost(env, cm[1], cm[2]);
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
    return `好👌 已新增公告，客人點「新品上線」就會看到：\n${d} ${an[1].trim()}`;
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
  const prm = t.match(/^湊單提醒\s*(開|關|.+)?$/);
  if (prm) {
    const a = (prm[1] || "").trim();
    if (a === "開" || a === "關") { await env.SESSIONS.put("poolremind", a === "關" ? "off" : "on"); return `好👌 湊單邀請已${a === "關" ? "關閉" : "開啟"}`; }
    const r = await runPoolReminders(env, deps, { force: true, only: a || undefined, quiet: true });
    return r.sent ? `好👌 已發湊單邀請給全部買家，共 ${r.sent} 位\n廠商：${r.done.join("、")}` : `目前沒有可以發的對象${a ? "（廠商名稱要跟「叫貨」清單上的一樣，且還沒湊滿）" : ""}`;
  }
  const mg = t.match(/^合併\s+((?:ZO\w{10}[\s,，、]*){2,})$/i);
  if (mg) return await mergeOrders(env, deps, [...new Set(mg[1].toUpperCase().match(/ZO\w{10}/g))]);
  const am2 = t.match(/^(?:到貨|備好貨|已到貨)\s+(.+)$/);
  if (am2) return await batchArrived(env, deps, am2[1].trim());
  if (/^批次$/.test(t)) { const bs = await listBatches(env, 20); return bs.length ? "📦 最近批次（每批＝同廠商湊滿 NT$20,000 叫的一次貨）\n\n" + bs.map((b) => `${b.status === "已到貨" ? "✅" : "⏳"} ${b.id}｜${b.m}｜NT$${(b.nt || 0).toLocaleString()}｜${b.orders.length} 筆｜${b.status}`).join("\n") + "\n\n貨到了傳「到貨 批次編號」" : "目前還沒有批次"; }
  const sm = t.match(/^(ZO\w{10})\s+分批出貨\s+([\s\S]+)$/i);
  if (sm) return await shipPart(env, deps, sm[1].toUpperCase(), sm[2].trim());
  const im = t.match(/^(ZO\w{10})\s+國際運費\s+\$?\s*(\d+)\s*(.*)$/i);
  if (im) return await setIntlFee(env, deps, im[1].toUpperCase(), Number(im[2]), im[3].trim());
  const om = t.match(/^(ZO\w{10})(?:\s*(已付款|已出貨|取消)(?:\s+(.+))?)?$/i);
  if (om) {
    const id = om[1].toUpperCase();
    const o = JSON.parse((await env.SESSIONS.get("o:" + id)) || "null");
    if (!o) return `找不到訂單 ${id}`;
    if (om[2] === "已出貨" && orderMfrs(o).some((x) => !(o.sh && o.sh[x]))) return await shipPart(env, deps, id, ("全部 " + (om[3] || "")).trim());
    if (om[2]) {
      o.statusBefore = o.status;
      o.status = om[2] === "取消" ? "已取消" : om[2];
      if (o.status === "已取消") { await revertMem(env, o); if (o.coupon) { const cps = await getCoupons(env, o.uid); const cc = cps.find((x) => x.id === o.coupon.id && x.used === o.id); if (cc) { cc.used = ""; await saveCoupons(env, o.uid, cps); } } }
      if (om[3]) o.track = om[3].trim().slice(0, 60);
      if (o.status === "已付款") {
        o.paidAt = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
        o.payInfo = Object.assign({ method: o.form.pay || "轉帳", amount: o.total }, o.payInfo || {});
        const mem = o.lines.find((l) => l.mem === "vip") ? "vip" : o.lines.find((l) => l.mem === "member") ? "member" : "";
        if (mem && !(o.memUntil && (await getTier(env, o.uid)) === mem)) { const r = await setMembership(env, o.uid, mem, { months: 1 }); o.memUntil = r.until; }
      }
      await env.SESSIONS.put("o:" + id, JSON.stringify(o), { expirationTtl: 180 * 86400 });
      try { await computePools(env, deps); } catch (e) {}
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
<title>ZOARÉ 批發商城</title>
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
.ph{aspect-ratio:1;background:#f6f6f7;display:flex;align-items:center;justify-content:center;position:relative}.pz{position:absolute;left:6px;top:6px;z-index:2;font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.15);pointer-events:none}.pz.pre{background:#7b5cd6}.pz.now{background:#1f9d63}.pzd{display:inline-block;font-size:12px;font-weight:800;padding:2px 9px;border-radius:999px;color:#fff;margin:4px 0}
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
.dsep{grid-column:1/-1;font-weight:800;font-size:14px;padding:6px 2px 0;color:var(--ink)}.vsub{font-size:12px;color:#6b6f75;margin:-2px 0 4px}.vg{background:#fff;border-radius:12px;padding:10px;margin-top:8px}.vh{display:flex;gap:10px;align-items:center}.vrow img,.vh img{width:72px!important;height:72px!important;}.vh img{width:56px;height:56px;object-fit:contain;background:#f6f6f7;border-radius:8px}.vrow .t small{color:#6b6f75}.add.sel{background:#9e1b1b}.cp{display:flex;gap:12px;align-items:center;background:#fff;border-radius:14px;padding:12px;margin-top:8px;border:2px dashed #ff8fb0}.cp.off{opacity:.55;border-color:#ccc}.cpa{font-weight:900;font-size:22px;color:#e0507d;min-width:96px;text-align:center}.cpt small{color:#6b6f75}.camp{background:#fff0f5;border-radius:12px;padding:10px 12px;margin-top:10px;font-size:13px;line-height:1.6;color:#5a3442}.camp small{color:#8a6070}.cpb{background:#fff;border-radius:12px;padding:10px 12px;margin-top:10px;font-size:14px}.cpo{display:block;margin-top:6px}.cpo small{color:#6b6f75}.cpo.dis{color:#aaa}.opts{margin-top:6px}.oh{font-size:11px;color:#9e1b1b;font-weight:700;margin-bottom:2px}.op{display:grid;grid-template-columns:1fr auto;gap:0 6px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:6px 7px;margin-top:6px}.op .ol b{display:block;font-size:12px}.op .ol small{display:block;font-size:10px;color:#6b6f75}.op .opr{font-weight:800;font-size:15px}.op .qty,.op .add{grid-column:1/3}
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
.ord ul{list-style:none;margin-top:6px;border-top:1px dashed var(--line);padding-top:6px}.ord li{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;padding:3px 0}.oim{width:46px;height:46px;object-fit:cover;border-radius:8px;flex:none;background:#f2f2f2}
.panel.vmode{padding:0;background:#fff}.vtop{position:sticky;top:0;z-index:3;height:0;display:flex;justify-content:flex-end}.vx{margin:10px 12px 0 0;border:0;background:rgba(255,255,255,.92);border-radius:50%;width:38px;height:38px;font-size:24px;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.vhero{position:relative;background:linear-gradient(180deg,#f7f7f8,#efeff1);height:min(46vh,380px);display:flex;align-items:center;justify-content:center;border-radius:18px 18px 0 0}.vhero img{max-width:88%;max-height:90%;object-fit:contain}.vz{position:absolute;right:12px;bottom:12px;background:rgba(22,22,22,.72);color:#fff;font-size:12px;border-radius:999px;padding:5px 11px;pointer-events:none}
.vinfo{padding:14px 16px 2px}.vb{font-size:12px;color:var(--sub)}.vtt{font-size:19px;font-weight:800;margin:3px 0 4px;line-height:1.3}.vpr{font-size:22px;font-weight:800;color:var(--red)}
.vsec{padding:12px 16px 0}.vh2{font-weight:800;font-size:15px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:baseline}.vh2 span{color:var(--sub);font-weight:400;font-size:12px}
.vgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.vt{border:1.5px solid var(--line);border-radius:12px;padding:5px 5px 6px;text-align:center;background:#fff;cursor:pointer}.vt.on{border-color:var(--ink);box-shadow:0 0 0 1.5px var(--ink) inset}
.vti{position:relative;aspect-ratio:1/1;background:#f6f6f7;border-radius:8px;display:flex;align-items:center;justify-content:center;overflow:hidden}.vti img{max-width:100%;max-height:100%;object-fit:contain}.vti b{position:absolute;top:3px;right:3px;background:var(--red);color:#fff;font-size:11px;border-radius:999px;padding:1px 7px}.vti i{position:absolute;left:3px;top:3px;font-style:normal;background:#1f6b33;color:#fff;font-size:10px;border-radius:6px;padding:1px 5px}
.vtn{font-size:12px;font-weight:700;margin-top:5px;line-height:1.25;height:2.5em;overflow:hidden}.vtp{font-size:12px;color:var(--sub)}
.vdet{margin:16px 16px 0;background:var(--bg);border-radius:16px;padding:14px}.vdn{font-weight:800;font-size:17px}.vdm{font-size:12px;color:var(--sub);margin:3px 0 2px}.vdet .op{background:#fff;border:0}
.vbar{position:sticky;bottom:0;z-index:3;background:#fff;border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:12px;margin-top:16px}.vbar #vsum{flex:1;font-size:14px;line-height:1.3}.vbar #vsum small{color:var(--sub)}.vbar .go{margin:0;padding:0 28px}
@media(min-width:640px){.vgrid{grid-template-columns:repeat(6,minmax(0,1fr))}}
.mg{font-size:10.5px;color:#9e1b1b;margin:0 0 2px}.vinfo .mg{font-size:12px}.ms{display:none}.card .ml{display:none}.card .ms{display:inline}.mg2{margin:8px 0 2px;padding:9px 11px;border-radius:10px;background:#f7f3ea;border:1px solid #e6dcc4;font-size:12.5px;line-height:1.6;color:#4a4a4a}.mg2 b{color:#161616}.mf{display:flex;align-items:center;gap:5px;font-size:11px;color:#6b6f75;margin:2px 0 1px;cursor:pointer}.mf b{color:#161616}.pb{flex:1;height:5px;background:#e6e7ea;border-radius:9px;overflow:hidden;min-width:28px}.pb i{display:block;height:100%;background:linear-gradient(90deg,#c9a45c,#9e1b1b)}.pp{font-size:10px}.mst{font-size:12.5px;background:#f6f6f7;border-radius:10px;padding:6px 10px;margin-top:6px;line-height:1.6}
.toast{position:fixed;left:50%;bottom:110px;transform:translateX(-50%);background:rgba(22,22,22,.92);color:#fff;font-size:14px;border-radius:12px;padding:10px 16px;z-index:60;opacity:0;pointer-events:none;transition:opacity .2s;max-width:86vw;text-align:center}.toast.on{opacity:1}
.lb{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.9);display:none;flex-direction:column;align-items:center;justify-content:center;padding:16px;color:#fff}.lb.on{display:flex}.lb img{max-width:100%;max-height:68vh;object-fit:contain;background:#fff;border-radius:12px}.lbt{margin-top:10px;font-size:15px;font-weight:700;text-align:center}.lbb{display:flex;gap:10px;margin-top:12px;align-items:center}.lbb button{border:0;border-radius:12px;height:44px;min-width:44px;font-size:22px;background:#333;color:#fff}.lbb .lbs{background:#fff;color:#161616;font-size:16px;font-weight:700;padding:0 20px}.lb small{margin-top:10px;color:#bbb;font-size:12px}.lbc{position:absolute;top:12px;right:14px;border:0;background:none;color:#fff;font-size:34px}.zm{cursor:zoom-in}
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
<div class="bar"><button id="openOrders" class="ghost">訂單查詢</button><div class="sum" id="sum">購物車是空的</div><button id="openCart">查看購物車</button></div>
<div class="sheet" id="sheet"><div class="panel" id="panel"></div></div>
<div class="lb" id="lb"><button class="lbc" id="lbc">×</button><img id="lbi" alt=""><div class="lbt" id="lbt"></div><div class="lbb"><button id="lbp">‹</button><button class="lbs" id="lbs">⬇️ 儲存照片</button><button id="lbn">›</button></div><small>儲存沒反應的話，長按圖片也可以存到手機</small></div>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let ME=null,ALL=[],VIEW=[],NEWV=[],shown=0,brand="新品上架",cart={},lastAd=null;
try{cart=JSON.parse(localStorage.getItem("zo_cart")||"{}")}catch(e){}
let CSY=null;const save=()=>{try{localStorage.setItem("zo_cart",JSON.stringify(cart))}catch(e){};if(T){clearTimeout(CSY);CSY=setTimeout(()=>{fetch("/shop/cart",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:T,cart}),keepalive:true}).catch(()=>{})},1500)}};
const TN={vip:"VIP 會員",member:"一般會員",none:"非會員"};
function TIER(){if(!ME)return"none";if(cart["MEMBER|VIP"]||ME.tier==="vip")return"vip";if(cart["MEMBER|GEN"]||ME.tier==="member")return"member";return"none"}
const price=x=>TIER()==="vip"?x.v:x.g;
const fmt=n=>"NT$"+n.toLocaleString();
const QR="https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/linepay_qr.png";
function payHTML(t,isLP){let h=esc(t).replace(/(https?:\\/\\/[^\\s<]+)/g,u=>/qrcodepay\\.line\\.me/.test(u)?'</pre><a class="lpbtn" href="'+u+'">💚 開啟 LINE Pay 付款</a><pre>':'<a href="'+u+'">'+u+'</a>');
  if(isLP&&/qrcodepay\\.line\\.me/.test(t))h+='</pre><img class="lpqr" src="'+QR+'" alt="LINE Pay QR"><pre>';return h}
async function init(){
  if(!T){
    // 訪客（公開連結進來）：可以逛、加購物車，下單時再用 LINE 確認身分
    try{ALL=await fetch("/shop/catalog?v=__CV__").then(r=>r.json())}catch(e){$("#grid").innerHTML='<div class="err">載入失敗，請稍後再試</div>';return}
    ME={guest:true,tier:"none",name:"訪客",tierName:"訪客"};
  }else{
  try{
    const [me,cat]=await Promise.all([fetch("/shop/me?t="+encodeURIComponent(T)).then(r=>r.json()),fetch("/shop/catalog?v=__CV__").then(r=>r.json())]);
    if(!me.ok){$("#grid").innerHTML='<div class="err">'+esc(me.error)+'</div>';$("#who").textContent="";return}
    ME=me;ALL=cat;
  }catch(e){$("#grid").innerHTML='<div class="err">載入失敗，請稍後再試</div>';return}
  }
  {const KM=new Map(ALL.map(x=>[x.k,x]));ALL.forEach(x=>{if(x.alt&&!x.hid){const p=KM.get(x.alt);if(p)x._xt=p.n+" "+p.jan+" 現貨"}})}
  if(ME.guest)$("#who").innerHTML='<b>歡迎逛逛 ZOARÉ</b><span class="tier">訪客</span><br>顯示一般價（VIP 會員每件再便宜 NT$30）・選好後用 LINE 一鍵下單';
  else $("#who").innerHTML='<b>'+esc(ME.name)+'</b><span class="tier '+(ME.tier==="vip"?"vip":"")+'">'+esc(ME.tierName)+'</span>'+(ME.until?'<small style="margin-left:6px;color:#6b6f75">到 '+esc(ME.until)+(ME.days!=null&&ME.days<=7?'（剩 '+ME.days+' 天）':'')+'</small>':'')+'<br>'+(ME.tier==="vip"?"已套用 VIP 價":"VIP 會員每件再便宜 NT$30");
  const counts={},order=[];ALL.forEach(x=>(x.c||["其他"]).forEach(c=>{if(!(c in counts)){counts[c]=0;order.push(c)}counts[c]++}));
  const CO=["會員方案","吉伊卡哇","三麗鷗","寶可夢","史努比","角落生物","拉拉熊","哆啦A夢","mofusand","動漫角色","蠟筆小新","塔麻可吉","嚕嚕米","Smiski","夢奇奇","Pickles 小青蛙","好奇猴喬治","好餓的毛毛蟲","彼得兔","什麼都是生物","捏捏療癒小物"];
  const brands=["全部"].concat(CO.filter(c=>counts[c]),order.filter(c=>!CO.includes(c)&&c!=="其他"),counts["其他"]?["其他"]:[]);
  $("#chips").innerHTML='<button class="chip news on" data-b="新品上架">✨ 新品上架</button><button class="chip news" data-b="熱賣推薦">🔥 熱賣推薦</button><button class="chip news" id="newsBtn">📢 最新動態</button>'+(ME.guest?'':'<button class="chip news" id="cpBtn">🎟 我的優惠券</button>')+brands.map(b=>'<button class="chip'+'" data-b="'+esc(b)+'">'+esc(b)+'</button>').join("");
  $("#newsBtn").onclick=openNews;if(!ME.guest)$("#cpBtn").onclick=openCoupons;
  $("#chips").onclick=async e=>{const b=e.target.dataset.b;if(!b)return;if(b==="熱賣推薦"&&!HOT){try{HOT=await fetch("/shop/hot?v=__CV__").then(r=>r.json())}catch(_){HOT=[]}}brand=b;document.querySelectorAll(".chip").forEach(c=>c.classList.toggle("on",c.dataset.b===b));filter()};
  for(const k in cart) if(!ALL.find(x=>x.k===k)) delete cart[k];
  if(T&&Object.keys(cart).length)save(); // 打開商城時就把手機裡原本的購物車同步上來
  buildFam();
  fetch("/shop/pools").then(r=>r.json()).then(r=>{if(r&&r.ok){POOL=r;filter()}}).catch(()=>{});
  {const byD={};ALL.forEach(x=>{if(x.hid||x.mem||!x.img)return;const d=x.ad||"";(byD[d]=byD[d]||[]).push(x)});
   Object.keys(byD).sort().reverse().forEach(d=>{const g={},ord=[];byD[d].forEach(x=>{if(!g[x.b]){g[x.b]=[];ord.push(x.b)}g[x.b].push(x)});let more=true;for(let i=0;more;i++){more=false;ord.forEach(b=>{if(g[b][i]){NEWV.push(g[b][i]);more=true}})}})}
  NEWV=grp(NEWV);
  filter();bar();
  const Q0=new URLSearchParams(location.search).get("q");if(Q0){$("#q").value=Q0;filter();if(VIEW.length===1&&VIEW[0]._f)openVar(VIEW[0]._f)}
  // 訪客的購物車透過 LINE 帶過來（cart=代碼）
  const CID=new URLSearchParams(location.search).get("cart");
  if(CID&&T){try{const r=await fetch("/shop/guestcart?id="+encodeURIComponent(CID)).then(r=>r.json());if(r.ok&&r.cart){for(const k in r.cart)if(ALL.find(x=>x.k===k))cart[k]=r.cart[k];save();bar();renderCart();$("#sheet").classList.add("on")}}catch(e){}}
  const MF0=new URLSearchParams(location.search).get("mf");if(MF0)goMf(MF0);
  const V=new URLSearchParams(location.search).get("v");if(V==="orders")openOrders();if(V==="news")openNews();
}
const norm=s=>String(s).toLowerCase().replace(/[\\s・·、，,。．.()（）「」\\-_/|｜]/g,"");
let tmr;$("#q").oninput=()=>{clearTimeout(tmr);tmr=setTimeout(filter,250)};
// 沒空格的關鍵字也能找：「吉伊卡哇相框」＝「吉伊卡哇」＋「相框」
function hit(h,w){if(h.includes(w))return true;if(w.length<4)return false;for(let i=2;i<=w.length-2;i++){if(h.includes(w.slice(0,i))&&hit(h,w.slice(i)))return true}return false}
let HOT=null;
function filter(){
  poolBar();
  if(brand==="熱賣推薦"&&HOT){const m=new Map(ALL.map(x=>[x.k,x]));VIEW=grp(HOT.map(k=>m.get(k)).filter(Boolean));shown=0;$("#grid").innerHTML="";page();$("#info").innerHTML="🔥 熱賣推薦｜大家最近都在買的 "+VIEW.length+" 款";return}
  if(brand==="新品上架"&&!$("#q").value.trim()){VIEW=NEWV;shown=0;lastAd=null;$("#grid").innerHTML="";page();const lim=new Date(Date.now()-14*864e5+288e5).toISOString().slice(0,10),nn=NEWV.filter(x=>(x.ad||"")>=lim).length;$("#info").innerHTML="✨ 新品上架｜最近 14 天上架 "+nn+" 款，最新的排最前面（往下滑看更早的商品）"+PZ_LEG;return}
  if(brand.indexOf("廠商:")===0&&!$("#q").value.trim()){const m=brand.slice(3);VIEW=grp(ALL.filter(x=>!x.hid&&x.m===m));shown=0;lastAd=null;$("#grid").innerHTML="";page();const p=POOL.pct[m]||0;$("#info").innerHTML="🏭 廠商："+esc(m)+"｜共 "+VIEW.length+" 款｜湊單進度 "+p+"%・還差 "+Math.max(0,100-p)+"%（湊滿約 NT$30,000 就叫貨，同廠商商品都能一起湊）";return}
  const q=norm($("#q").value);const words=$("#q").value.trim().toLowerCase().split(/\\s+/).filter(Boolean).map(norm);
  VIEW=grp(pinSort(ALL.filter(x=>!x.hid&&(brand==="全部"||brand==="新品上架"||(x.c||[]).includes(brand)||x.b===brand)&&(!q||words.every(w=>hit(x._t||(x._t=norm(x.n+x.b+x.s+x.jan+x.st+x.sh+(x.m||"")+(x.c||[]).join(" ")+(x.box?"盲盒box整盒":"")+(x._xt||""))),w))))));
  shown=0;$("#grid").innerHTML="";page();
  const qv=$("#q").value.trim();
  $("#info").innerHTML=(qv?'🔍 「'+esc(qv)+'」':'')+"共 "+VIEW.length+" 款"+(brand!=="全部"&&brand!=="新品上架"?"｜"+esc(brand):"")+(qv?' <a href="#" id="clrq" style="margin-left:8px;color:#9e1b1b">✕ 看全部商品</a>':'');
  const cq=document.getElementById("clrq");if(cq)cq.onclick=e=>{e.preventDefault();$("#q").value="";filter()};
}
function dlTxt(d){const m=(d||"").match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:\\s+(\\d{1,2}:\\d{2}))?/);if(m){const td=new Date(Date.now()+288e5).toISOString().slice(0,10),tw=new Date(Date.now()+1152e5).toISOString().slice(0,10),ds=m[1]+"-"+String(m[2]).padStart(2,"0")+"-"+String(m[3]).padStart(2,"0"),tm=m[4]||"23:59";if(ds===td)return"⏰ 今天 "+tm+" 結單";if(ds===tw)return"⏰ 明天 "+tm+" 結單";return"結單日 "+(+m[2])+"/"+(+m[3])+(m[4]&&m[4]!=="23:59"?" "+m[4]:"")}return"結單日 "+(d?d.split("（")[0]:"長期接單")}
const VCT=new Set(["XO","TX","KR","HG","PC","PN","CN","KU","MM","KT","AP","MP","US","MA","MN","SB","LT"]);
const VCH=["鴨鴨Pekkle","小羊琵亞諾","Hello Kitty","凱蒂貓","美樂蒂","酷洛米","大耳狗喜拿","大耳狗","布丁狗","帕恰狗","人魚漢頓","山姆企鵝","大眼蛙","酷企鵝","雙子星","優莎娜","琵亞諾","巧克力貓","小麥粉","栗子兔","吉伊卡哇","吉伊","小八","烏薩奇","兔兔","小桃","飛鼠","栗子饅頭","海獺","史努比","糊塗塌客","皮卡丘","蛋黃哥"];
const VSZ=new Set(["SS","S","M","L","LL","XL","3L","A","B","C","D","E","F","G","H","RD","PK","BL","BK","YE","GR","WH","BR","PU","GY","BE","NV","OR","LB","LP","DB","紅","粉","粉紅","藍","水藍","黑","白","黃","綠","紫","棕","灰","米","橘","金","銀","淺藍","深藍","紅色","粉色","藍色","黑色","白色","黃色","綠色","紫色","棕色","灰色"]);
let FAM={};
function famOf(x){const n=x.n,i=Math.max(n.lastIndexOf("/"),n.lastIndexOf("／"));if(i>0)return[n.slice(0,i).trim(),n.slice(i+1).trim()];
  let base=n;const vs=[];const m=base.match(/[（(]([^（）()]{1,20})[)）]\\s*$/);if(m){vs.push(m[1]);base=base.slice(0,m.index)}
  const s=(x.s||"").trim();if(s&&base.includes(s)&&base.trim()!==s){base=base.split(s).join(" ");vs.push(s)}
  for(const c of VCH)if(base.includes(c)){base=base.split(c).join(" ");vs.push(c)}
  const keep=[];base.split(" ").forEach(t=>{if(!t)return;if(VSZ.has(t.toUpperCase())||VCT.has(t)||/^[0-9.]+(cm|mm|ml)$/i.test(t))vs.push(t);else keep.push(t)});
  return[keep.join(" "),vs.join(" ")]}
function buildFam(){FAM={};ALL.forEach(x=>{if(x.hid||x.mem||!x.img)return;const[b,v]=famOf(x);x._v=v||x.n;if(b.length>=2){x._f=x.b+"|"+b;x._fb=b;(FAM[x._f]=FAM[x._f]||[]).push(x)}});
  const SR={SS:1,S:2,M:3,L:4,LL:5,XL:6,"3L":7};const sk=x=>{const t=(x._v||"").split(" ");let r=0;const rest=t.filter(w=>{const u=w.toUpperCase();if(SR[u]){r=SR[u];return false}return true}).join(" ");return [rest,r]};
  for(const k in FAM){if(FAM[k].length<2){FAM[k].forEach(x=>{delete x._f});delete FAM[k];continue}FAM[k].sort((a,b)=>{const A=sk(a),B=sk(b);return A[0]<B[0]?-1:A[0]>B[0]?1:A[1]-B[1]})}}
function grp(list){const seen=new Set(),out=[];for(const x of list){if(x._f){if(seen.has(x._f))continue;seen.add(x._f)}out.push(x)}return out}
function gsel(k){let n=0;FAM[k].forEach(y=>{n+=cart[y.k]||0;if(y.alt)n+=cart[y.alt]||0});return n}
function gcard(x){const L=FAM[x._f],ps=L.map(price),mn=Math.min(...ps),mx=Math.max(...ps),sel=gsel(x._f),hasA=L.some(y=>y.alt);
  return '<div class="card" data-g="'+esc(x._f)+'" data-r="'+esc(x.k)+'"><div class="ph">'+pzF(L)+(x.img?'<img loading="lazy" src="'+esc(x.img)+'" alt="">':'')+'</div><div class="bd"><div class="bn">'+esc(x.b)+'</div>'+mfB(x)+'<div class="nm">'+esc(x._fb)+'</div><div class="tag">共 '+L.length+' 種規格／款式'+(hasA?'・部分有現貨':'')+'</div><div class="pr"><b>'+fmt(mn)+(mx>mn?'～'+fmt(mx):'')+'</b></div><button class="add'+(sel?' sel':'')+'">'+(sel?'已選 '+sel+' 件・修改':'選擇規格')+'</button></div></div>'}
function vrow(y){const A=y.alt?byK(y.alt):null,im=y.img?'<img class="zm" data-z="'+esc(y.k)+'" src="'+esc(y.img)+'">':'';
  if(A)return '<div class="vg"><div class="vh">'+im+'<b>'+esc(y._v)+'</b></div>'+opt(y,"⏳ 要等・較便宜","向日本訂貨・"+step(y)+" 件起")+opt(A,"⚡ 現貨・馬上出",(A.st&&A.st.indexOf("較少")>=0?"庫存較少・":"")+step(A)+" 件起")+'</div>';
  return '<div class="row vrow" data-k="'+esc(y.k)+'">'+im+'<div class="t">'+esc(y._v)+'<br><small>'+fmt(price(y))+'・'+(y.box?"整盒 "+y.box+" 個":step(y)+" 件起")+(y.sh?"・"+esc(y.sh):"")+'</small></div>'+qtyBox(y,cart[y.k]||0)+'</div>'}
let LB=null;
function openLB(L,i){LB={L,i};$("#lb").classList.add("on");showLB()}
function showLB(){const x=LB.L[LB.i];$("#lbi").src=x.img;$("#lbt").textContent=(x._v&&x._f?x._fb+"／"+x._v:x.n)+(LB.L.length>1?"（"+(LB.i+1)+"/"+LB.L.length+"）":"");$("#lbp").style.visibility=$("#lbn").style.visibility=LB.L.length>1?"visible":"hidden"}
async function saveLB(){const x=LB.L[LB.i],nm=((x._v&&x._f?x._fb+"_"+x._v:x.n)||"zoare").split("").map(c=>'/:*?"<>| '.indexOf(c)>=0||c.charCodeAt(0)===92?"_":c).join("").slice(0,60)+".jpg";
  try{const b=await fetch(x.img,{mode:"cors"}).then(r=>{if(!r.ok)throw 0;return r.blob()});const f=new File([b],nm,{type:b.type||"image/jpeg"});
    if(navigator.canShare&&navigator.canShare({files:[f]})){await navigator.share({files:[f]});return}
    const u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download=nm;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)
  }catch(e){if(e&&e.name==="AbortError")return;window.open(x.img,"_blank")}}
$("#lbc").onclick=()=>$("#lb").classList.remove("on");$("#lb").onclick=e=>{if(e.target.id==="lb")$("#lb").classList.remove("on")};
$("#lbp").onclick=()=>{LB.i=(LB.i-1+LB.L.length)%LB.L.length;showLB()};$("#lbn").onclick=()=>{LB.i=(LB.i+1)%LB.L.length;showLB()};$("#lbs").onclick=saveLB;
document.addEventListener("click",e=>{const z=e.target.closest&&e.target.closest("img.zm");if(z){e.stopPropagation();const y=byK(z.dataset.z);if(!y)return;if(z.closest("#grid")&&!y._f&&!y.mem&&inPool(y.m)){openOne(y);return}const L=y._f&&FAM[y._f]?FAM[y._f]:[y];openLB(L,Math.max(0,L.indexOf(y)))}},true);
let VK=null,VI=0;
function vRefresh(k){document.querySelectorAll('#grid .card[data-g="'+CSS.escape(k)+'"]').forEach(el=>{const x=byK(el.dataset.r);if(x)el.outerHTML=card(x)})}
function vClose(){const k=VK;VK=null;$("#panel").classList.remove("vmode");$("#sheet").classList.remove("on");if(k)vRefresh(k)}
function openVar(k,i){const L=FAM[k];if(!L)return;VK=k;VI=i!=null?i:Math.max(0,L.findIndex(y=>cart[y.k]||(y.alt&&cart[y.alt])));
  const ps=L.map(price),mn=Math.min(...ps),mx=Math.max(...ps);
  $("#panel").classList.add("vmode");
  $("#panel").innerHTML='<div class="vtop"><button class="vx" id="vx">×</button></div><div class="vhero" id="vhero"></div><div class="vinfo"><div class="vb">'+esc(L[0].b)+'</div>'+mfB(L[0])+'<div class="vtt">'+esc(L[0]._fb)+'</div><div class="vpr">'+fmt(mn)+(mx>mn?' ～ '+fmt(mx):'')+'</div></div><div class="vsec"><div class="vh2">選擇款式・規格<span>共 '+L.length+' 種</span></div><div class="vgrid" id="vgrid"></div></div><div class="vdet" id="vdet"></div>'+mfStrip(L[0])+'<div class="vbar"><div id="vsum"></div><button class="go" id="vok">選好了</button></div>';
  $("#sheet").classList.add("on");$("#panel").scrollTop=0;$("#vx").onclick=vClose;$("#vok").onclick=vClose;
  $("#vgrid").onclick=e=>{const t=e.target.closest("[data-vi]");if(!t)return;VI=+t.dataset.vi;renderVar();const d=$("#vdet");if(d)d.scrollIntoView({behavior:"smooth",block:"nearest"})};
  if(L.length===1)$("#vgrid").parentNode.style.display="none";
  renderVar()}
function renderVar(){const L=FAM[VK];if(!L)return;const y=L[VI]||L[0],A=y.alt?byK(y.alt):null;
  $("#vhero").innerHTML=(y.img?'<img class="zm" data-z="'+esc(y.k)+'" src="'+esc(y.img)+'" alt="">':'')+'<span class="vz">🔍 點圖放大・儲存照片</span>';
  $("#vgrid").innerHTML=L.map((z,i)=>{const n=(cart[z.k]||0)+(z.alt?cart[z.alt]||0:0);return '<div class="vt'+(i===VI?' on':'')+'" data-vi="'+i+'"><div class="vti">'+(z.img?'<img loading="lazy" src="'+esc(z.img)+'" alt="">':'')+(n?'<b>'+n+'</b>':'')+(z.alt?'<i>日本現貨</i>':'')+'</div><div class="vtn">'+esc(z._v)+'</div><div class="vtp">'+fmt(price(z))+'</div></div>'}).join("");
  const sub=y.box?"整盒 "+y.box+" 個・只能整盒訂":step(y)+" 件起";
  $("#vdet").innerHTML='<div class="vdn">'+esc(y._v)+'</div>'+pzLine(y)+'<div class="vdm">'+esc(sub)+'</div>'+(A?opt(y,"⏳ 要等・較便宜","向日本訂貨・"+step(y)+" 件起")+opt(A,"⚡ 現貨・馬上出",(A.st&&A.st.indexOf("較少")>=0?"庫存較少・":"")+step(A)+" 件起"):'<div class="op" data-k="'+esc(y.k)+'"><div class="ol"><b>'+esc(TN[TIER()])+'價</b><small>'+(TIER()!=="vip"&&y.v<y.g?"VIP 會員 "+fmt(y.v):"&nbsp;")+'</small></div><div class="opr">'+fmt(price(y))+'</div>'+qtyBox(y,cart[y.k]||0)+'</div>');
  let n=0,amt=0;L.forEach(z=>[z.k,z.alt].forEach(k=>{if(k&&cart[k]){const w=byK(k);if(w){n+=cart[k];amt+=price(w)*cart[k]}}}));
  $("#vsum").innerHTML=n?'這款已選 <b>'+n+'</b> 件<br><small>'+fmt(amt)+'</small>':'<small>點上面的款式，再按「加入」</small>'}
document.addEventListener("click",e=>{if(e.target.closest("[data-k]"))return;const g=e.target.closest("#grid [data-g]");if(g)openVar(g.dataset.g)});
function opt(y,lab,sub){return '<div class="op" data-k="'+esc(y.k)+'"><div class="ol"><b>'+lab+'</b><small>'+esc(sub)+'</small></div><div class="opr">'+fmt(price(y))+'</div>'+qtyBox(y,cart[y.k]||0)+'</div>'}
function card(x){
  if(x._f&&FAM[x._f])return gcard(x);
  const A=x.alt&&!x.hid?byK(x.alt):null;
  if(A){const tg=[dlTxt(x.dl)].filter(Boolean).join("｜");
    return '<div class="card" data-k="'+esc(x.k)+'"><div class="ph">'+pz(x)+(x.img?'<img loading="lazy" src="'+esc(x.img)+'" alt="">':'')+'</div><div class="bd"><div class="bn">'+esc(x.b)+'</div>'+mfB(x)+'<div class="nm">'+esc(x.n)+'</div>'+(tg?'<div class="tag">'+esc(tg)+'</div>':'')+
    '<div class="opts"><div class="oh">請選擇要等還是要現貨 👇</div>'+opt(x,"⏳ 要等・較便宜","向日本訂貨・"+step(x)+" 件起")+opt(A,"⚡ 現貨・馬上出",(A.st&&A.st.indexOf("較少")>=0?"庫存較少・":"")+step(A)+" 件起")+'</div></div></div>'}
  const p=price(x),q=cart[x.k]||0;
  const tags=[x.box?("整盒 "+x.box+" 個・只能整盒訂"):(!x.mem?step(x)+" 件起":""),x.mem?"":dlTxt(x.dl),x.st&&/庫存較少|洽詢|請洽/.test(x.st)?x.st.replace(/^.*・/,""):""].filter(Boolean).join("｜");
  return '<div class="card" data-k="'+esc(x.k)+'"><div class="ph">'+pz(x)+(x.img?'<img class="zm" data-z="'+esc(x.k)+'" loading="lazy" src="'+esc(x.img)+'" alt="">':'<span style="color:#aaa;font-size:12px">圖片準備中</span>')+'</div><div class="bd"><div class="bn">'+esc(x.b)+'</div>'+mfB(x)+'<div class="nm">'+esc(x.n)+'</div>'+(tags?'<div class="tag">'+esc(tags)+'</div>':'')+
  '<div class="pr"><b>'+fmt(p)+'</b>'+(TIER()==="vip"&&x.v<x.g?'<s>'+fmt(x.g)+'</s>':'')+(x.box?'<span style="font-size:11px;color:#888">／個</span>':'')+'</div>'+qtyBox(x,q)+'</div></div>';
}
let POOL={pct:{}};
const PZ_LEG='<div style="margin-top:6px;font-size:11.5px;line-height:1.6"><span style="background:#1f9d63;color:#fff;border-radius:999px;padding:1px 7px;font-weight:800">日本現貨</span> 日本廠商有庫存，湊單達標就能馬上向日本叫貨<br><span style="background:#7b5cd6;color:#fff;border-radius:999px;padding:1px 7px;font-weight:800">日本預購</span> 可以先下單叫貨，要到標示的時間日本才會出貨<br>※ 都不是台灣現貨，貨都是從日本叫進來</div>';
function pre(x){if(x.mem)return null;const sh=x.sh||"";if(/^(預計|下一批)/.test(sh))return{p:1,t:"日本預購",d:sh.replace(/^預計\s*/,"").replace(/到貨|發售/,"日本出貨")};if(/預購/.test(x.st||""))return{p:1,t:"日本預購",d:"日本出貨時間待確認"};return{p:0,t:"日本現貨",d:""}}
function pz(x){const r=pre(x);return r?'<span class="pz '+(r.p?'pre':'now')+'">'+(r.p?'日本預購｜'+esc(r.d):'日本現貨・可馬上叫貨')+'</span>':''}
function pzF(L){const rs=L.map(pre).filter(Boolean);if(!rs.length)return"";const ps=rs.filter(r=>r.p);if(!ps.length)return'<span class="pz now">日本現貨・可馬上叫貨</span>';const ds=[...new Set(ps.map(r=>r.d))];return'<span class="pz pre">'+(ps.length<rs.length?'部分日本預購':'日本預購｜'+esc(ds.length===1?ds[0]:"依款式"))+'</span>'}
const PZ_NOW="日本現貨：日本廠商有庫存，湊單達標就能馬上向日本叫貨（不是台灣現貨，湊滿後約 2～3 週到台灣）",PZ_PRE="日本預購：現在就能先下單叫貨，但要到標示的時間日本廠商才會出貨（不是台灣現貨）";
function pzLine(x){const r=pre(x);return r?'<div class="pzd" style="background:'+(r.p?'#7b5cd6':'#1f9d63')+'">'+(r.p?'日本預購｜'+esc(r.d):'日本現貨・可馬上叫貨')+'</div><div style="font-size:11.5px;color:#6b6f75;margin:0 0 4px">'+(r.p?PZ_PRE:PZ_NOW)+'</div>':''}
function inPool(m){const p=POOL.pct[m]||0;return !!m&&p>0&&p<100}
function pinSort(L){if(!Object.keys(POOL.pct||{}).length)return L;const a=[],b=[];L.forEach(x=>(!x.mem&&inPool(x.m)?a:b).push(x));a.sort((x,y)=>(POOL.pct[y.m]||0)-(POOL.pct[x.m]||0));return a.concat(b)}
function poolBar(){let el=document.getElementById("poolbar");if(!el){el=document.createElement("div");el.id="poolbar";$("#grid").parentNode.insertBefore(el,$("#grid"))}
  const show=(brand==="新品上架"||brand==="全部")&&!$("#q").value.trim();const ms=Object.keys(POOL.pct||{}).filter(inPool).sort((a,b)=>POOL.pct[b]-POOL.pct[a]);
  if(!show||!ms.length){el.innerHTML="";el.style.display="none";return}
  el.style.display="block";el.innerHTML='<div style="margin:4px 0 10px;padding:10px 12px;border-radius:14px;background:linear-gradient(90deg,#fff3d6,#e3f0ff);border:1px solid #f0e2bf"><div style="font-weight:800;font-size:14px;margin-bottom:6px">🔥 正在湊單・一起湊更快叫貨</div><div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:2px">'+ms.map(m=>{const p=POOL.pct[m],n=grp(ALL.filter(x=>!x.hid&&x.m===m)).length;return '<button data-mf="'+esc(m)+'" style="flex:0 0 auto;border:0;border-radius:12px;background:#fff;padding:8px 12px;text-align:left;box-shadow:0 2px 6px rgba(0,0,0,.08);font:inherit"><b style="font-size:13px">'+esc(m)+'</b><div style="height:5px;width:110px;background:#eee;border-radius:3px;margin:5px 0 3px;overflow:hidden"><i style="display:block;height:100%;width:'+p+'%;background:#e0a33a"></i></div><small style="color:#9e1b1b">'+p+'%・還差 '+(100-p)+'%</small><small style="color:#888">・'+n+' 款</small></button>'}).join("")+'</div></div>'}
function mfStrip(x){if(!x||x.mem||!inPool(x.m))return"";const p=POOL.pct[x.m],tot=grp(ALL.filter(y=>!y.hid&&y.m===x.m)).length;const L=grp(ALL.filter(y=>!y.hid&&y.m===x.m&&y.img&&!(x._f&&y._f===x._f)&&y.k!==x.k));if(!L.length)return"";
  return '<div class="vsec"><div class="vh2">🏭 同廠商一起湊・還差 '+(100-p)+'%<span>'+esc(x.m)+'</span></div><div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px">'+L.slice(0,20).map(y=>'<div data-open="'+esc(y.k)+'" style="flex:0 0 96px;cursor:pointer"><div style="height:96px;border-radius:10px;background:#f6f6f6;display:flex;align-items:center;justify-content:center;overflow:hidden"><img loading="lazy" src="'+esc(y.img)+'" style="max-width:100%;max-height:100%" alt=""></div><div style="font-size:11px;line-height:1.3;height:2.6em;overflow:hidden;margin-top:4px">'+esc(y._f&&FAM[y._f]?y._fb:y.n)+'</div><div style="font-size:12px;font-weight:700">'+fmt(price(y))+(y._f&&FAM[y._f]&&FAM[y._f].length>1?' 起':'')+'</div></div>').join("")+'</div><button class="go" data-mf="'+esc(x.m)+'" style="width:100%;margin-top:6px">看這家全部 '+tot+' 款，一起湊 →</button></div>'}
function openOne(y){const k="1:"+y.k;FAM[k]=[y];if(!y._v)y._v=y.n;y._fb=y.n;openVar(k,0)}
function openItem(y){if(!y)return;if(y._f&&FAM[y._f])openVar(y._f);else openOne(y)}
document.addEventListener("click",e=>{const t=e.target.closest&&e.target.closest("[data-open]");if(t){e.stopPropagation();e.preventDefault();openItem(byK(t.dataset.open));return}
  const n=e.target.closest&&e.target.closest("#grid .card[data-k] .nm");if(n){const y=byK(n.closest(".card").dataset.k);if(y&&!y.mem&&inPool(y.m))openOne(y)}},true);
function mfB(x){if(!x.m||x.mem)return"";const p=POOL.pct[x.m]||0;return '<div class="mf" data-mf="'+esc(x.m)+'"><span>廠商：<b>'+esc(x.m)+'</b></span><span class="pb"><i style="width:'+p+'%"></i></span><span class="pp">'+p+'%</span></div><div class="mg"><span class="ml">湊滿約 NT$30,000 叫貨・</span>還差 '+Math.max(0,100-p)+'%</div>'}
function goMf(m){if(VK)vClose();$("#sheet").classList.remove("on");brand="廠商:"+m;$("#q").value="";document.querySelectorAll(".chip").forEach(c=>c.classList.remove("on"));filter();scrollTo(0,0)}
document.addEventListener("click",e=>{const t=e.target.closest&&e.target.closest("[data-mf]");if(!t)return;e.stopPropagation();e.preventDefault();goMf(t.dataset.mf)},true);
function unit(x){return x.mem?1:Number(x.box)||Number(x.moq)||3}
function fixQ(x,q){q=Math.floor(Number(q)||0);if(q<=0)return 0;const u=unit(x),m=step(x);return Math.max(m,Math.ceil(q/u)*u)}
let TT=null;function toast(t){let el=document.getElementById("toast");if(!el){el=document.createElement("div");el.id="toast";el.className="toast";document.body.appendChild(el)}el.textContent=t;el.classList.add("on");clearTimeout(TT);TT=setTimeout(()=>el.classList.remove("on"),2600)}
function step(x){if(x.mem)return 1;const u=Number(x.box)||Number(x.moq)||3;if(TIER()!=="none")return u;return u>=21?u:Math.ceil(21/u)*u}
function qtyBox(x,q){return q?'<div class="qty"><button data-a="-">−</button><input inputmode="numeric" value="'+q+'"><button data-a="+">＋</button></div>':'<button class="add" data-a="add">加入（'+step(x)+' 件）</button>'}
function page(){
  const part=VIEW.slice(shown,shown+40);shown+=part.length;
  const isNew=VIEW===NEWV;
  $("#grid").insertAdjacentHTML("beforeend",part.map(x=>{let h="";if(isNew&&(x.ad||"")!==lastAd){lastAd=x.ad||"";h='<div class="dsep">'+(lastAd?"📅 "+(+lastAd.slice(5,7))+"/"+(+lastAd.slice(8,10))+" 上架":"更早上架的商品")+'</div>'}return h+card(x)}).join("")||(shown?"":'<div class="empty">找不到商品，換個關鍵字試試～</div>'));
  $("#more").hidden=shown>=VIEW.length;
}
$("#more").onclick=page;
window.addEventListener("scroll",()=>{if(!$("#more").hidden&&innerHeight+scrollY>document.body.offsetHeight-600)page()});
const byK=k=>ALL.find(x=>x.k===k);
function setQ(k,q){const t0=TIER();q=Math.max(0,Math.floor(q)||0);if(q)cart[k]=q;else delete cart[k];save();bar();if(VK)setTimeout(renderVar,0);
  if(TIER()!==t0){let ch=0;for(const kk in cart){const y=byK(kk);if(y&&!y.mem){const f=fixQ(y,cart[kk]);if(f!==cart[kk]){cart[kk]=f;ch++}}}if(ch){save();bar();toast("身分改變，已自動調整 "+ch+" 款的數量為起批數的倍數")}document.querySelectorAll('#grid .card').forEach(el=>{const x=byK(el.dataset.k||el.dataset.r);if(x)el.outerHTML=card(x)});document.querySelectorAll('#panel .vrow[data-k],#panel .op[data-k]').forEach(el=>{const y=byK(el.dataset.k),b=el.querySelector(".qty,.add");if(y&&b)b.outerHTML=qtyBox(y,cart[y.k]||0)});return}
  document.querySelectorAll('#grid [data-k="'+CSS.escape(k)+'"],#panel .vrow[data-k="'+CSS.escape(k)+'"],#panel .op[data-k="'+CSS.escape(k)+'"]').forEach(el=>{if(el.classList.contains("card")&&el.querySelector(".op"))return;const b=el.querySelector(".qty,.add");if(b)b.outerHTML=qtyBox(byK(k),q)})}
document.addEventListener("click",e=>{
  const a=e.target.dataset.a;if(!a)return;const c=e.target.closest("[data-k]");if(!c)return;const k=c.dataset.k,x=byK(k),q=cart[k]||0,u=unit(x);
  if(a==="add")setQ(k,step(x));else if(a==="+")setQ(k,q?fixQ(x,q+u):step(x));else if(a==="-")setQ(k,q-u<step(x)?0:q-u);
  if(c.classList.contains("row")&&!c.classList.contains("vrow"))renderCart();
});
document.addEventListener("change",e=>{if(e.target.matches(".qty input")){const c=e.target.closest("[data-k]"),x=byK(c.dataset.k),raw=Math.floor(Number(e.target.value)||0),f=fixQ(x,raw);if(f!==raw&&raw>0)toast("這款要 "+step(x)+" 件起、以 "+unit(x)+" 件為單位，已調整為 "+f+" 件");setQ(c.dataset.k,f);e.target.value=f||"";if(c.classList.contains("row")&&!c.classList.contains("vrow"))renderCart()}});
function lines(){return Object.keys(cart).map(k=>{const x=byK(k);return x&&{x,q:cart[k],sub:price(x)*cart[k]}}).filter(Boolean)}
function bar(){const L=lines(),n=L.reduce((a,l)=>a+l.q,0),t=L.reduce((a,l)=>a+l.sub,0);
  $("#sum").innerHTML=n?L.length+" 款 "+n+" 件　<b>"+fmt(t)+"</b>":"購物車是空的"}
function notes(L){const t=TIER(),out=[],total=L.filter(l=>!l.x.mem).reduce((a,l)=>a+l.q,0);
  L.forEach(({x,q})=>{if(x.mem)return;const mq=step(x);if(x.box&&q%x.box)out.push(x.n+"：整盒商品請以 "+x.box+" 的倍數訂購");else if(q<mq)out.push(x.n+"："+(t==="vip"?"VIP 會員":t==="none"?"非會員":"一般會員")+"這款 "+mq+" 件起")});
  if(t==="member"&&total>0&&total<21)out.push("一般會員整張訂單混批合計需 21 件（目前 "+total+" 件，還差 "+(21-total)+" 件）");
  if(total>0){const ms=[...new Set(L.filter(l=>!l.x.mem&&l.x.m).map(l=>l.x.m))];out.push("依廠商湊單：同一廠商的已付款訂單湊滿約 NT$30,000 就向日本叫貨，先付款先寄（"+ms.map(m=>m+" 目前 "+(POOL.pct[m]||0)+"%").join("、")+"，付款後會加進進度）")}return out}
$("#openCart").onclick=()=>{renderCart();$("#sheet").classList.add("on")};
$("#openOrders").onclick=openOrders;
function left(dl){const m=dl.match(/(\\d{4})-(\\d{1,2})-(\\d{1,2})(?:\\s+(\\d{1,2}):(\\d{2}))?/);if(!m)return"";const t=Date.UTC(+m[1],+m[2]-1,+m[3],(m[4]?+m[4]:23)-8,m[5]?+m[5]:59)-Date.now();if(t<0)return"已結單";const d=Math.floor(t/864e5),h=Math.floor(t%864e5/36e5);return d?"剩 "+d+" 天 "+h+" 小時":"剩 "+h+" 小時"}
async function openNews(){$("#panel").classList.remove("vmode");VK=null;
  $("#panel").innerHTML='<h2>新品上線<button class="x" id="nx">×</button></h2><div class="empty">載入中…</div>';$("#sheet").classList.add("on");$("#nx").onclick=()=>$("#sheet").classList.remove("on");
  try{const r=await fetch("/shop/news").then(r=>r.json());
    const th=ks=>'<div class="th">'+ks.map(k=>byK(k)).filter(x=>x&&x.img).map(x=>'<img loading="lazy" src="'+esc(x.img)+'">').join("")+'</div>';
    let h='';
    if(r.ann.length)h+='<div class="nsec"><h3>📢 最新公告</h3>'+r.ann.map(a=>'<div class="ann"><small>'+esc(a.d)+'</small>'+esc(a.t)+'</div>').join("")+'</div>';
    if(r.dl.length)h+='<div class="nsec"><h3>⏰ 即將結單</h3>'+r.dl.map(g=>'<div class="ng"><div class="t"><span>'+esc(g.b)+'　'+g.n+' 款</span><small class="cd">'+esc(left(g.dl))+'</small></div><div style="font-size:12px;color:#6b6f75">結單日 '+esc(g.dl.split("（")[0])+'</div>'+th(g.ks)+'<button data-go="'+esc(g.b)+'">去看看</button></div>').join("")+'</div>';
    if(r.fresh.length)h+='<div class="nsec"><h3>🆕 最新上架</h3>'+r.fresh.map(g=>'<div class="ng"><div class="t"><span>'+esc(g.b)+'</span><small>'+esc(g.ad.slice(5).replace("-","/"))+' 上架・'+g.n+' 款</small></div>'+th(g.ks)+'<button data-go="'+esc(g.b)+'">去看看</button></div>').join("")+'</div>';
    if(r.restockCount)h+='<div class="nsec"><h3>🔁 再販商品</h3><div class="ng"><div class="t"><span>再販預定 '+r.restockCount+' 款</span></div><button data-q="再販">去看看</button></div></div>';
    $("#panel").innerHTML='<h2>新品上線<button class="x" id="nx">×</button></h2>'+(h||'<div class="empty">目前沒有新的動態喔</div>');
    $("#nx").onclick=()=>$("#sheet").classList.remove("on");
    $("#panel").querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{brand=b.dataset.go;$("#q").value="";document.querySelectorAll(".chip[data-b]").forEach(c=>c.classList.toggle("on",c.dataset.b===brand));filter();$("#sheet").classList.remove("on");scrollTo(0,0)});
    $("#panel").querySelectorAll("[data-q]").forEach(b=>b.onclick=()=>{brand="全部";$("#q").value=b.dataset.q;document.querySelectorAll(".chip[data-b]").forEach(c=>c.classList.toggle("on",c.dataset.b==="全部"));filter();$("#sheet").classList.remove("on");scrollTo(0,0)});
  }catch(e){$("#panel").querySelector(".empty").textContent="載入失敗，請稍後再試"}
}
const STC={"待付款":"s1","已回報匯款":"s2","待確認":"s1","已付款":"s2","已出貨":"s3","已取消":"s4"};
async function openOrders(){$("#panel").classList.remove("vmode");VK=null;
  if(ME&&ME.guest){$("#panel").innerHTML='<h2>訂單查詢<button class="x" id="ox">×</button></h2><div class="empty">訪客看不到訂單喔<br>在 ZOARÉ 的 LINE 傳「訂購」就會收到你的專屬連結，可以查訂單</div>';$("#sheet").classList.add("on");$("#ox").onclick=()=>$("#sheet").classList.remove("on");return}
  $("#panel").innerHTML='<h2>訂單查詢<button class="x" id="ox">×</button></h2><div class="empty">載入中…</div>';$("#sheet").classList.add("on");$("#ox").onclick=()=>$("#sheet").classList.remove("on");
  try{const r=await fetch("/shop/orders?t="+encodeURIComponent(T)).then(r=>r.json());if(!r.ok)throw 0;
    const body=r.orders.length?r.orders.map(o=>'<div class="ord"><div class="hd"><span>'+esc(o.id)+'</span><span class="st '+(STC[o.status]||"")+'">'+esc(o.status)+'</span></div>'+
      '<div style="color:#6b6f75;font-size:12.5px">'+esc(o.at)+'｜'+o.qty+' 件｜'+esc(o.tier)+'價</div><div>合計 <b>'+fmt(o.total)+'</b></div>'+((o.mst||[]).length&&o.status!=="已取消"&&(o.status!=="已出貨"||o.mst.length>1)?'<div class="mst">'+o.mst.map(z=>'<div>🏭 '+esc(z.m)+'：'+esc(z.s)+'</div>').join("")+'</div>':'')+
      (o.paid5?'<div style="font-size:12.5px">匯款後五碼：'+esc(o.paid5)+'</div>':'')+(o.track?'<div style="font-size:12.5px">🚚 物流單號：<b>'+esc(o.track)+'</b></div>':'')+
      (o.status==="待付款"&&(o.pay==="LINE Pay"?r.linepay:r.bank)?'<div class="warn" style="margin-top:8px">'+(o.pay==="LINE Pay"?"💚 LINE Pay 付款資料":"🏦 轉帳資料")+'<br>'+payHTML(o.pay==="LINE Pay"?r.linepay:r.bank,o.pay==="LINE Pay").replace(/\\n/g,"<br>").replace(/<\\/?pre>/g,"")+'<br>付款後請在 LINE 傳'+(o.pay==="LINE Pay"?"「付款截圖」":"「後五碼」和「轉帳截圖」")+'</div>':'')+
      '<details><summary>查看明細與收件資料</summary><ul>'+o.lines.map(l=>'<li'+(l.sh?' style="color:#999"':'')+'>'+(l.img?'<img class="oim" src="'+esc(l.img)+'" loading="lazy">':'')+'<span style="flex:1">'+(l.sh?'✅ <s>':'')+esc(l.n)+' ×'+l.q+(l.sh?'</s> 已出貨':'')+'</span><span>'+fmt(l.sub)+'</span></li>').join("")+'</ul>'+
      '<div style="font-size:12.5px;margin-top:6px;color:#444">收件人：'+esc(o.form.name)+'　'+esc(o.form.phone)+'<br>寄送：'+esc(o.form.ship)+'　'+esc(o.form.addr)+(o.form.note?'<br>備註：'+esc(o.form.note):'')+'</div></details></div>').join("")
      :'<div class="empty">還沒有訂單喔</div>';
    $("#panel").innerHTML='<h2>訂單查詢<button class="x" id="ox">×</button></h2>'+body+'<p style="font-size:12px;color:#6b6f75;margin-top:12px;text-align:center">有問題直接在 LINE 跟我們說喔</p>';
    $("#ox").onclick=()=>$("#sheet").classList.remove("on");
  }catch(e){$("#panel").innerHTML='<h2>訂單查詢<button class="x" onclick="sheet.classList.remove(\\'on\\')">×</button></h2><div class="empty">載入失敗，請稍後再試</div>'}
}
$("#sheet").onclick=e=>{if(e.target.id==="sheet"){if(VK)vClose();else $("#sheet").classList.remove("on")}};
let form={};try{form=JSON.parse(localStorage.getItem("zo_form")||"{}")}catch(e){}
let CPSEL="";
const CST={"可使用":"#1f6b33","付款後生效":"#8a5a00","已使用":"#888","已過期":"#888","已失效":"#888"};
function cpCard(c){return '<div class="cp'+(c.status==="可使用"||c.status==="付款後生效"?'':' off')+'"><div class="cpa">NT$'+c.amt+'</div><div class="cpt"><b>'+esc(c.name)+' 折抵券</b><br><small>訂單滿 NT$'+c.min.toLocaleString()+' 可用・有效到 '+esc(c.exp.slice(5).replace("-","/"))+'</small><br><span style="color:'+(CST[c.status]||"#888")+';font-weight:700;font-size:12px">'+esc(c.status==="付款後生效"?"⏳ 訂單 "+c.src+" 付款後生效":c.status==="已使用"?"已使用（"+c.used+"）":c.status)+'</span></div></div>'}
function campLine(){const C=ME&&ME.camp;if(!C)return"";const tl=C.tiers.slice().reverse().map(t=>"滿 $"+t[0].toLocaleString()+" 送 $"+t[1].toLocaleString()).join("・");return '<div class="camp">🎀 <b>'+esc(C.name)+'</b>（'+C.from.slice(5).replace("-","/")+'～'+C.to.slice(5).replace("-","/")+'）<br>'+esc([].concat(C.cat).join('、'))+'商品不用整箱，訂單達指定金額就送：'+tl+'<br><small>付款後生效，30 天內下次訂購使用，訂單滿券面 5 倍可折抵</small></div>'}
function scLine(c){if(!c||(!c.quota.dom&&!c.quota.intl))return"🚚 加入會員每月送運費券（一般會員 5 張國內、VIP 10 張國內＋10 張國際）";return"🚚 本月運費券：國內 "+c.dom+"/"+c.quota.dom+" 張"+(c.quota.intl?"、國際 "+c.intl+"/"+c.quota.intl+" 張":"")+"，出貨時自動折抵"}
function openCoupons(){$("#panel").classList.remove("vmode");VK=null;const L=(ME.coupons||[]);
  $("#panel").innerHTML='<h2>我的優惠券<button class="x" id="cpx">×</button></h2>'+'<div class="camp" style="background:#f4f1ea;border-color:#e2d9c2;color:#3a3a3a"><b>'+esc(scLine(ME.sc))+'</b><br><small>'+esc(ME.shipRule||"")+'（每月 1 號重新發放，當月有效）</small></div>'+campLine()+(L.length?L.map(cpCard).join(""):'<div class="empty">目前還沒有折抵券喔</div>');
  $("#sheet").classList.add("on");$("#cpx").onclick=()=>$("#sheet").classList.remove("on")}
function caseN(x){const m=String(x.pk||"").match(/(?:入数|入數|装箱数|裝箱數)\\s*(\\d+)/);return m?+m[1]:0}
function campEarn(L){const C=ME&&ME.camp;if(!C)return null;let base=0;L.forEach(({x,q,sub})=>{if(!x.mem&&(x.c||[]).some(c=>[].concat(C.cat).includes(c)))base+=sub});const t=C.tiers.find(t=>base>=t[0]),nx=C.tiers.slice().reverse().find(t=>base<t[0]);return{base,amt:t?t[1]:0,next:nx}}
function renderCart(){$("#panel").classList.remove("vmode");VK=null;
  const L=lines();
  if(!L.length){$("#panel").innerHTML='<h2>購物車<button class="x" onclick="sheet.classList.remove(\\'on\\')">×</button></h2><div class="empty">還沒有商品喔</div>';return}
  const N=notes(L),sum0=L.reduce((a,l)=>a+l.sub,0),n=L.reduce((a,l)=>a+l.q,0);
  const UC=ME.guest?[]:(ME.coupons||[]).filter(c=>c.status==="可使用");let sel=UC.find(c=>c.id===CPSEL);if(sel&&sum0<sel.min){sel=null;CPSEL=""}
  const total=sum0-(sel?sel.amt:0),E=ME.guest?null:campEarn(L);
  const cpHTML=(UC.length?'<div class="cpb"><b>🎟 使用折抵券</b><label class="cpo"><input type="radio" name="cpsel" value=""'+(sel?"":" checked")+'> 不使用</label>'+UC.map(c=>'<label class="cpo'+(sum0<c.min?" dis":"")+'"><input type="radio" name="cpsel" value="'+esc(c.id)+'"'+(sel&&sel.id===c.id?" checked":"")+(sum0<c.min?" disabled":"")+'> 折 NT$'+c.amt+'<small>（滿 NT$'+c.min.toLocaleString()+' 可用・到 '+esc(c.exp.slice(5).replace("-","/"))+'）'+(sum0<c.min?' 還差 NT$'+(c.min-sum0).toLocaleString():'')+'</small></label>').join("")+'</div>':'')+
    (E&&(E.amt||E.base)?'<div class="camp">🎀 '+esc(ME.camp.name)+'：本單'+esc([].concat(ME.camp.cat).join('、'))+'金額 '+fmt(E.base)+(E.amt?'，<b>付款後送 NT$'+E.amt+' 折抵券</b>':'')+(E.next?'<br><small>再加 '+fmt(E.next[0]-E.base)+' '+esc([].concat(ME.camp.cat).join('、'))+'商品，就送 NT$'+E.next[1]+'</small>':'')+'</div>':(ME.camp&&!ME.guest?'<div class="camp">🎀 '+esc(ME.camp.name)+'進行中：'+esc([].concat(ME.camp.cat).join('、'))+'商品滿額送折抵券（購物車目前沒有符合的商品）</div>':''));
  $("#panel").innerHTML='<h2>購物車<button class="x" id="cx">×</button></h2>'+
  L.map(({x,q,sub})=>'<div class="row" data-k="'+esc(x.k)+'">'+(x.img?'<img src="'+esc(x.img)+'">':'')+'<div class="t">'+esc(x.n)+'<br><small>'+fmt(price(x))+' × '+q+' = '+fmt(sub)+'</small></div>'+qtyBox(x,q)+'</div>').join("")+
  (N.length?'<div class="warn"><b>訂購規則提醒</b><br>'+N.map(esc).join("<br>")+'</div>':'')+
  cpHTML+'<div class="tot">共 '+L.length+' 款 '+n+' 件<br>'+(sel?'小計 '+fmt(sum0)+'　🎟 折抵 −'+fmt(sel.amt)+'<br>':'')+'合計 <b>'+fmt(total)+'</b>（'+esc(TN[TIER()])+'價）'+(TIER()!==ME.tier?'<br><small style="color:#9e1b1b">🎉 購物車有會員方案，送出後自動升級為'+TN[TIER()]+'，這張訂單直接套用會員價</small>':'')+'<br><small style="color:#6b6f75">運費：依廠商分批寄出，每次出貨國內 NT$60，國際運費依物流報價（約每公斤 NT$220）'+(ME.sc&&TIER()===ME.tier?'<br>'+esc(scLine(ME.sc)):'<br>會員每月送運費券：一般會員 5 張國內、VIP 10 張國內＋10 張國際')+'</small></div>'+
  '<form id="of"><label>收件人姓名</label><input class="f" name="name" required value="'+esc(form.name||"")+'">'+
  '<label>手機號碼</label><input class="f" name="phone" type="tel" required value="'+esc(form.phone||"")+'">'+
  '<label>寄送方式</label><select class="f" name="ship" required>'+["7-11 店到店","全家店到店","萊爾富店到店","宅配","其他"].map(s=>'<option'+(form.ship===s?" selected":"")+'>'+s+'</option>').join("")+'</select>'+
  '<label>門市名稱／收件地址</label><input class="f" name="addr" required value="'+esc(form.addr||"")+'">'+
  '<label>付款方式</label><div class="pays">'+["轉帳","LINE Pay"].map(p=>'<label class="pay"><input type="radio" name="pay" value="'+p+'"'+((form.pay||"轉帳")===p?" checked":"")+'><span>'+(p==="轉帳"?"🏦 銀行轉帳":"💚 LINE Pay")+'</span></label>').join("")+'</div>'+
  '<label>備註（選填）</label><textarea class="f" name="note" rows="2"></textarea>'+
  '<button class="go" id="go">送出訂單</button></form>';
  if(ME.guest){const f=$("#of");f.outerHTML='<button class="go" id="lg">💚 用 LINE 確認身分並下單</button><div style="font-size:12px;color:#6b6f75;margin-top:8px;line-height:1.6">會打開 ZOARÉ 的 LINE 官方帳號，按「傳送」後會收到你的專屬下單頁，購物車會自動帶過去，再填收件資料就完成了。<br>會員價會在專屬下單頁自動套用。</div>';$("#lg").onclick=guestCheckout}
  $("#cx").onclick=()=>$("#sheet").classList.remove("on");
  if(!ME.guest)$("#of").onsubmit=submit;
  {const pc=L.filter(l=>!l.x.mem).reduce((a,l)=>a+l.q,0);if(TIER()==="member"&&pc>0&&pc<21){const b=$("#go")||$("#lg");if(b){b.disabled=true;b.style.opacity=".45";b.textContent="還差 "+(21-pc)+" 件才能送出（一般會員混批 21 件）"}}}
  document.querySelectorAll('input[name="cpsel"]').forEach(r=>r.onchange=()=>{const f=$("#of");if(f)form=Object.assign(form||{},Object.fromEntries(new FormData(f)));CPSEL=r.value;renderCart()});
}
async function guestCheckout(){
  const b=$("#lg");b.disabled=true;b.textContent="處理中…";
  try{const r=await fetch("/shop/guestcart",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cart})}).then(r=>r.json());
    if(!r.ok)throw new Error(r.error||"失敗");location.href="/go?q="+encodeURIComponent("下單 #"+r.id);
  }catch(e){b.disabled=false;b.textContent="💚 用 LINE 確認身分並下單";alert("暫時無法處理，請稍後再試")}
}
async function submit(e){
  e.preventDefault();const fd=Object.fromEntries(new FormData(e.target));form=fd;try{localStorage.setItem("zo_form",JSON.stringify({name:fd.name,phone:fd.phone,ship:fd.ship,addr:fd.addr,pay:fd.pay}))}catch(_){}
  const btn=$("#go");btn.disabled=true;btn.textContent="送出中…";
  try{
    const r=await fetch("/shop/order",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:T,items:lines().map(l=>({k:l.x.k,q:l.q})),form:fd,coupon:CPSEL||""})}).then(r=>r.json());
    if(!r.ok)throw new Error(r.error||"送出失敗");
    CPSEL="";try{const me2=await fetch("/shop/me?t="+encodeURIComponent(T)).then(r=>r.json());if(me2.ok){ME.coupons=me2.coupons;ME.camp=me2.camp}}catch(_){}
    cart={};save();bar();document.querySelectorAll(".qty").forEach(el=>{const c=el.closest(".card");if(c)el.outerHTML=qtyBox(byK(c.dataset.k),0)});
    $("#panel").innerHTML='<div class="done"><div style="font-size:44px">✅</div><h3>訂單已送出</h3><div>訂單編號 <b>'+esc(r.id)+'</b><br>共 '+r.qty+' 件　'+(r.discount?'（已折抵 '+fmt(r.discount)+'）':'')+'合計 <b>'+fmt(r.total)+'</b></div>'+(r.earned?'<div class="camp" style="margin-top:10px">🎁 恭喜！這張訂單付款後會送你 <b>NT$'+r.earned+' 折抵券</b>，下次訂購就能用（在「🎟 我的優惠券」查看）</div>':'')+
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
  { k: "動漫角色", w: ["鬼滅", "咒術", "排球", "航海王", "七龍珠", "柯南", "鋼彈", "膽大黨", "火影", "kamio 動漫", "偶像夢幻祭", "五等分的新娘", "藍色監獄", "鏈鋸人", "數碼寶貝", "銀魂", "東京卍", "黑子的籃球", "我推的孩子", "葬送的芙莉蓮", "遊戲王", "jojo", "新世紀福音戰士", "初音未來", "獵人", "迷宮禁區", "家庭教師"], subs: [
    ["鬼滅之刃", ["鬼滅"]], ["咒術回戰", ["咒術"]], ["排球少年", ["排球"]], ["航海王", ["航海王", "ワンピース"]],
    ["七龍珠", ["七龍珠", "ドラゴンボール"]], ["名偵探柯南", ["柯南", "コナン"]], ["鋼彈", ["鋼彈", "ガンダム"]], ["膽大黨", ["膽大黨", "ダンダダン"]]] },
  { k: "塔麻可吉", w: ["塔麻可吉", "拓麻歌子", "たまごっち", "tamagotchi"] },
  { k: "嚕嚕米", w: ["嚕嚕米", "姆明", "ムーミン", "moomin"] },
  { k: "捏捏療癒小物", w: ["捏捏", "スクイーズ", "squeeze"] },
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
  const note = [packN(it) ? `整盒 ${packN(it)} 個・只能整盒訂` : tier !== "none" ? `會員 ${mq} 件起` : `${mq} 件起（會員 ${minQty({ box: packN(it), moq: moqOf(it) }, "vip")} 件起）`, /庫存較少|洽詢/.test(it.st || "") ? (it.st || "").replace(/^.*・/, "") : ""].filter(Boolean).join("｜");
  const body = [
    { type: "text", text: (it.b || "").slice(0, 40), size: "xxs", color: "#888888" },
    { type: "text", text: it.n.slice(0, 80), size: "sm", weight: "bold", wrap: true, maxLines: 3 },
    { type: "text", text: price + (packN(it) ? " ／個" : ""), size: "lg", weight: "bold", color: "#9E1B1B", margin: "sm" },
    { type: "text", text: sub, size: "xxs", color: "#888888" },
  ];
  const dlt = dlLabel(it);
  body.push({ type: "text", text: "⏰ " + dlt, size: "xs", weight: "bold", color: /今天|明天/.test(dlt) ? "#D0021B" : "#161616", margin: "sm", wrap: true });
  const shp = it._alt && !it.hid ? "這個價格需等待向日本訂貨" : shipLabel(it);
  if (shp) body.push({ type: "text", text: "📦 " + shp, size: "xxs", color: "#555555" });
  if (note) body.push({ type: "text", text: note.slice(0, 60), size: "xxs", color: "#9E1B1B", wrap: true });
  const A = it._alt && !it.hid ? it._alt : null;
  if (A) body.push({ type: "text", text: `⚡ 也有日本現貨：${tier === "vip" ? "VIP NT$" + A.v : "NT$" + A.g}（不用等，馬上出貨）`, size: "xs", weight: "bold", color: "#1D7A46", wrap: true, margin: "sm" });
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
  const raw = await Promise.all(ids.map((id) => env.SESSIONS.get("o:" + id))); // 同時讀，不要一筆一筆等
  for (const r of raw) { const o = JSON.parse(r || "null"); if (o) out.push(o); }
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
// 改單後重算折抵券：①這張用的券（未達門檻就退回）②活動送的券（依新金額增加／減少／取消）
export async function reconcileCoupons(env, o, opt = {}) {
  const notes = [], sub = o.lines.reduce((a, l) => a + l.price * l.q, 0);
  let cps = null; const load = async () => (cps = cps || (await getCoupons(env, o.uid)));
  o.subtotal = sub; o.total = sub;
  if (o.coupon) {
    const c = (await load()).find((x) => x.id === o.coupon.id);
    const min = c ? c.min : 0;
    if (sub < min) { if (c && c.used === o.id) c.used = ""; notes.push(`🎟 金額未達 NT$${min.toLocaleString()}，原本使用的 NT$${o.coupon.amt} 折抵券已退回（可下次使用）`); delete o.coupon; delete o.subtotal; }
    else o.total = sub - o.coupon.amt;
  } else delete o.subtotal;
  const day = String(o.at || "").slice(0, 10), camp = CAMPAIGNS.find((c) => (o.earned && c.name === o.earned.camp) || (day >= c.from && day <= c.to));
  if (camp && (opt.keepEarned || (o.merged || []).length)) {
    if (!opt.keepEarned && o.earnedList && o.earnedList.length) notes.push("ℹ️ 這張是合併訂單，活動回饋券照原本各張訂單結算，不會因改數量自動增減，需要調整請人工處理");
  } else if (camp) {
    for (const l of o.lines) if (!l.c || !l.c.length) l.c = catsOf({ n: l.n, b: l.b });
    const earn = campaignEarn(o.lines.map((l) => ({ ...l, sub: l.price * l.q })), camp), old = o.earned ? o.earned.amt : 0;
    if (earn.amt !== old) {
      const L = await load(), c = o.earned ? L.find((x) => x.id === o.earned.id) : null;
      if (c && c.used) notes.push(`⚠️ 活動回饋券（NT$${old}）已在 ${c.used} 用掉，無法再調整，請人工確認`);
      else if (!earn.amt) { if (c) L.splice(L.indexOf(c), 1); delete o.earned; notes.push(`🎁 活動金額未達 NT$${camp.tiers[camp.tiers.length - 1][0].toLocaleString()}，原本要送的 NT$${old} 折抵券取消`); }
      else if (c) { c.amt = earn.amt; c.min = earn.amt * camp.minX; o.earned.amt = earn.amt; o.earned.base = earn.base; notes.push(`🎁 活動回饋券 NT$${old} → NT$${earn.amt}（${earn.amt > old ? "增加" : "減少"}）`); }
      else { const id = "CP" + Math.random().toString(36).slice(2, 8).toUpperCase(), today = twDay(); L.unshift({ id, amt: earn.amt, min: earn.amt * camp.minX, name: camp.name, src: o.id, at: today, exp: addDays(today, camp.days), used: "" }); o.earned = { id, amt: earn.amt, base: earn.base, camp: camp.name }; notes.push(`🎁 達到活動門檻，加送 NT$${earn.amt} 折抵券（付款後生效）`); }
    }
  }
  if (cps) await saveCoupons(env, o.uid, cps);
  return notes.length ? "\n" + notes.join("\n") : "";
}
function payDiff(o) {
  if (!["已付款", "已出貨"].includes(o.status)) return "";
  const paid = (o.payInfo && o.payInfo.amount) || 0;
  if (!paid || paid === o.total || o.diffDone === o.total) return "";
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
// ---------- 合併同一位客人的訂單（還沒向日本叫貨、還沒出貨的才可以）----------
const MERGE_ST = ["待付款", "已回報匯款", "待確認", "已付款"];
export function canMerge(o) { return o && MERGE_ST.includes(o.status) && !Object.keys(o.po || {}).length && !Object.keys(o.sh || {}).length && !Object.keys(o.arr || {}).length; }
export async function mergeOrders(env, deps, ids) {
  const os = (await Promise.all(ids.map((id) => env.SESSIONS.get("o:" + id)))).map((x) => JSON.parse(x || "null"));
  if (os.some((o) => !o)) return "找不到其中一張訂單";
  if (new Set(os.map((o) => o.uid)).size > 1) return "不同客人的訂單不能合併";
  const bad = os.filter((o) => !canMerge(o));
  if (bad.length) return `這些訂單不能合併（已取消／已出貨／已向日本叫貨）：${bad.map((o) => o.id + "「" + o.status + "」").join("、")}`;
  os.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const t = os[0], rest = os.slice(1), paidOf = (o) => (o.status === "已付款" ? (o.payInfo && o.payInfo.amount) || o.total : 0);
  let paid = paidOf(t), anyPaid = t.status === "已付款";
  for (const o of rest) {
    for (const l of o.lines) { const ex = t.lines.find((x) => x.k === l.k && x.price === l.price); if (ex) ex.q += l.q; else t.lines.push(l); }
    if (o.status === "已付款") { paid += paidOf(o); if (!anyPaid || String(o.paidAt) < String(t.paidAt || "9")) t.paidAt = t.paidAt && anyPaid ? (String(o.paidAt) < String(t.paidAt) ? o.paidAt : t.paidAt) : o.paidAt; anyPaid = true; }
    if (o.coupon && !t.coupon) t.coupon = o.coupon; else if (o.coupon) { try { const cps = await getCoupons(env, o.uid); const cc = cps.find((x) => x.id === o.coupon.id && x.used === o.id); if (cc) { cc.used = ""; await saveCoupons(env, o.uid, cps); } } catch (e) {} }
    if (o.memo) t.memo = [t.memo, o.memo].filter(Boolean).join("；");
    if (o.form && o.form.note) t.form.note = [t.form.note, o.form.note].filter(Boolean).join("；");
    if (o.memUntil && !t.memUntil) t.memUntil = o.memUntil;
  }
  recalc(t);
  { const L = await getCoupons(env, t.uid); let ch = false; for (const c of L) if (rest.some((o) => o.id === c.src)) { c.src = t.id; ch = true; } if (ch) await saveCoupons(env, t.uid, L); }
  // 活動回饋券以「原本每一張訂單」各自結算：合併不重算、不加送，各張原本的券照樣保留
  t.earnedList = [...(t.earnedList || (t.earned ? [t.earned] : [])), ...rest.flatMap((o) => o.earnedList || (o.earned ? [o.earned] : []))];
  if (t.earnedList.length) { t.earned = t.earnedList[0]; t.earned = { ...t.earnedList[0], amt: t.earnedList.reduce((a, e) => a + e.amt, 0) }; }
  const mcn = await reconcileCoupons(env, t, { keepEarned: true }) + (t.earnedList.length ? `\n🎁 活動回饋券照原本各張訂單結算（共 NT$${t.earnedList.reduce((a, e) => a + e.amt, 0)}），合併不另外加送` : "");
  if (anyPaid) { t.status = "已付款"; t.payInfo = Object.assign({}, t.payInfo || {}, { amount: paid }); }
  t.merged = [...(t.merged || []), ...rest.map((o) => o.id)];
  await saveOrder(env, t);
  // 被合併的訂單直接移除（不退會員等級）
  const idx = JSON.parse((await env.SESSIONS.get("orders")) || "[]").filter((x) => !rest.some((o) => o.id === x));
  await env.SESSIONS.put("orders", JSON.stringify(idx));
  const mine = JSON.parse((await env.SESSIONS.get("ou:" + t.uid)) || "[]").filter((x) => !rest.some((o) => o.id === x));
  await env.SESSIONS.put("ou:" + t.uid, JSON.stringify(mine));
  for (const o of rest) await env.SESSIONS.delete("o:" + o.id);
  try { await computePools(env, {}); } catch (e) {}
  const diff = payDiff(t), unpaidPart = !anyPaid ? "" : "";
  if (deps.lineApi) await deps.lineApi(env, "/v2/bot/message/push", { to: t.uid, messages: [{ type: "text", text: `您的訂單已幫您合併成一張：${t.id}\n（原本的 ${rest.map((o) => o.id).join("、")} 已併入）\n共 ${t.qty} 件　合計 NT$${t.total.toLocaleString()}${mcn}${diff}\n\n合併後一起湊單、一起出貨，運費只算一次～` }] }).catch(() => {});
  return `好👌 已合併成 ${t.id}（併入 ${rest.map((o) => o.id).join("、")}）\n共 ${t.qty} 件　合計 NT$${t.total.toLocaleString()}　狀態：${t.status}${mcn}${diff}${unpaidPart}\n已通知客人`;
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
  const all = await allOrders(env), CF = await costFactors(env);
  const items = {}; let rev = 0, profit = 0, n = 0, pcs = 0, pend = 0, pendAmt = 0;
  const mem = { vip: { q: 0, amt: 0 }, member: { q: 0, amt: 0 } };
  for (const o of all) {
    const d = (o.paidAt || o.at).slice(0, 10);
    const inRange = to ? d.startsWith(to) : d >= from;
    if (!inRange) continue;
    if (o.status === "已付款" || o.status === "已出貨") {
      n++; rev += o.total;
      for (const l of o.lines) {
        const c = lineCostReal(o, l, CF); profit += (l.price - c) * l.q;
        if (l.mem && mem[l.mem]) { mem[l.mem].q += l.q; mem[l.mem].amt += l.sub; continue; }
        pcs += l.q;
        const k = l.n; items[k] = items[k] || { q: 0, amt: 0 }; items[k].q += l.q; items[k].amt += l.sub;
      }
    } else if (OPEN.includes(o.status)) { pend++; pendAmt += o.total; }
  }
  const act = await memberCounts(env);
  const memTxt = `\n\n👑 會員方案\nVIP NT$1,000：賣出 ${mem.vip.q} 份 NT$${mem.vip.amt.toLocaleString()}\n一般 NT$100：賣出 ${mem.member.q} 份 NT$${mem.member.amt.toLocaleString()}\n目前有效會員：VIP ${act.vip} 位｜一般 ${act.member} 位`;
  const top = Object.entries(items).sort((a, b) => b[1].q - a[1].q).slice(0, 15).map(([k, v], i) => `${i + 1}. ${k}　×${v.q}　NT$${v.amt.toLocaleString()}`);
  return `📈 銷售狀況｜${label}\n\n已付款訂單：${n} 筆\n銷售件數：${pcs} 件（${Object.keys(items).length} 個品項）\n銷售額：NT$${rev.toLocaleString()}\n淨利：NT$${Math.round(profit).toLocaleString()}${rev ? `（毛利率 ${Math.round((profit / rev) * 100)}%）` : ""}\n\n🏆 品項銷量${top.length ? "\n" + top.join("\n") : "：還沒有"}${memTxt}\n\n⏳ 未付款訂單：${pend} 筆 NT$${pendAmt.toLocaleString()}（不算進銷售額）\n\n※ 淨利＝售價－成本（成本用報價公式算），還沒扣運費、匯款手續費等其他支出；會員費全額算淨利\n可以傳「銷售狀況 今天／本週／9月／累計」`;
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
  if (/^(已付款|已出貨|取消|分批出貨|國際運費)(\s|$)/.test(cmd)) return null; // 交給狀態指令
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
  const find = (kw) => { const ix = String(kw).match(/^#(\d+)$/); if (ix) { const l = o.lines[Number(ix[1]) - 1]; return l ? [l] : []; } const ex = o.lines.filter((l) => l.n === kw); return ex.length ? ex : o.lines.filter((l) => l.n.includes(kw) || l.jan === kw); };
  // 刪除品項：「ZO… 刪 小八」
  x = cmd.match(/^(?:刪除?|拿掉|移除)\s*(.+)$/);
  if (x) {
    const hit = find(x[1].trim());
    if (!hit.length) return `${id} 裡找不到「${x[1]}」`;
    if (hit.length > 1) return `「${x[1]}」對到好幾款，請打更完整的名稱：\n` + hit.map((l) => "・" + l.n).join("\n");
    o.lines = o.lines.filter((l) => l !== hit[0]);
    if (!o.lines.length) { await deleteOrder(env, id); return `🗑️ ${id} 品項都刪完了，整張訂單已刪除`; }
    recalc(o); const cn = await reconcileCoupons(env, o); await saveOrder(env, o);
    await notifyCustomer(env, deps, o, `您的訂單 ${id} 已更新：移除「${hit[0].n}」\n新的合計 NT$${o.total.toLocaleString()}${cn}`);
    return `好👌 ${id} 已移除「${hit[0].n}」\n新合計 NT$${o.total.toLocaleString()}（已通知客人）${cn}${payDiff(o)}`;
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
    if (ex) ex.q += q; else o.lines.push({ k: it.k, img: it.img || "", n: it.n, b: it.b, jan: it.jan, q, price, cost: it.mem ? 0 : it.g - 80, sub: 0, box: it.box, moq: it.moq, mem: it.mem || "" });
    recalc(o); const cn = await reconcileCoupons(env, o); await saveOrder(env, o);
    await notifyCustomer(env, deps, o, `您的訂單 ${id} 已更新：加入「${it.n}」×${q}\n新的合計 NT$${o.total.toLocaleString()}${cn}`);
    return `好👌 ${id} 已加入「${it.n}」×${q}\n新合計 NT$${o.total.toLocaleString()}（已通知客人）${cn}${payDiff(o)}`;
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
    recalc(o); const cn = await reconcileCoupons(env, o); await saveOrder(env, o);
    await notifyCustomer(env, deps, o, `您的訂單 ${id} 已更新：「${hit[0].n}」數量改為 ${q}\n新的合計 NT$${o.total.toLocaleString()}${cn}`);
    return `好👌 ${id}「${hit[0].n}」改成 ${q} 個\n新合計 NT$${o.total.toLocaleString()}（已通知客人）${cn}${payDiff(o)}`;
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
  const seen = new Set();
  const list = items.map((it) => (it && it.hid && it._alt ? it._alt : it)).filter((it) => it && it.img && !it.hid && !seen.has(it) && seen.add(it));
  const bubbles = list.slice(0, 12).map((it) => bubble(it, tier, link));
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
    memBubble("👑 VIP 會員", "NT$1,000／月", ["每月 10 張國內＋10 張國際運費券", "全館 VIP 價，每件比一般價便宜 NT$30", "真正少量叫貨：每款照商品起批數（很多款 2～3 件），沒有總件數限制（依廠商湊單、需等待）", "新品優先通知"], RAW_IMG + "member_vip.jpg?v=2", "加入 VIP 會員", link, true),
    memBubble("一般會員", "NT$100／月", ["每月 5 張國內運費券", "每款照商品起批數（很多款 2～3 件），不同款混批 21 件", "商品用一般價"], RAW_IMG + "member_gen.jpg?v=2", "加入一般會員", link, false),
  ];
  const mi = await memberInfo(env, uid);
  const exp = mi.until ? `有效到 ${fmtDay(mi.until)}（還有 ${mi.days} 天）` : "";
  const head = tier === "vip" ? `您已經是 VIP 會員囉👑 ${exp}\n要續約可以點下面直接下單，會從到期日往後延長～` : tier === "member" ? `您目前是一般會員，${exp}\n升級 VIP 每月 10 張國內＋10 張國際運費券、每件再便宜 NT$30、沒有總件數限制👇` : "ZOARÉ 批發會員方案👇 付款完成會自動開通，效期 1 個月";
  const out = [{ type: "flex", altText: head, contents: { type: "carousel", contents: bubbles } }];
  if (tier !== "none") out.unshift({ type: "text", text: head });
  return out;
}

// ---------- 新朋友加入的歡迎訊息 ----------
const INTRO_V = "20261026";
export const introVideoMsg = () => ({ type: "video", originalContentUrl: SHOP_BASE + "/m/intro.mp4?v=" + INTRO_V, previewImageUrl: SHOP_BASE + "/m/intro.jpg?v=" + INTRO_V });
export async function welcomeMessages(env, uid, name) {
  const link = await shopLink(env, uid);
  const hi = name ? `${name} 您好～` : "您好～";
  const text = `${hi}歡迎加入 ZOARÉ 🎉（下面有 2 分鐘影片，從選單一步一步教您怎麼買👇）
我們是日本角色商品批發，吉伊卡哇、三麗鷗、寶可夢、史努比、角落生物…上千款日本正版商品，集單預購、批發價直送台灣🇯🇵
日本廠商要湊滿一定金額才接單，我們幫大家依廠商合併湊單，商城每個商品下面都看得到湊單進度

━━ 怎麼買？3 個步驟 ━━
① 找商品：直接在這裡打角色名字，例如「吉伊卡哇」「酷洛米」，馬上傳商品卡片給您
② 看清楚：每張卡片都有價格、起批數、結單日
③ 下單：按卡片上的「我要訂購」，或打開您的專屬商城👇
${link}
（這是您專用的連結，價格會自動套用您的會員價，請不要轉傳）
付款可以轉帳或 LINE Pay，付完在這裡傳後五碼＋截圖，系統自動對帳

━━ 查報價小技巧 ━━
・找特定款式：加細項，例如「吉伊卡哇 相框」「小八 S娃」
・手上有照片或條碼：直接傳圖片、JAN 條碼或商品編號（圖片限我們官方 LINE／社群發佈過的商品）
・慢慢逛：點下方選單「批發商城」，或「熱賣推薦」看大家都在買的
・看新品、快結單的商品：點「新品上線」
・查訂單：點「訂單查詢」`;
  const text2 = `━━ 起批數怎麼算？ ━━
・非會員：每款 21 件起（照商品起批數的倍數，例如起批 3 件→21 件、2 件→22 件）
・一般會員：每款照商品起批數（很多款 2～3 件），不同款混批合計 21 件
・VIP 會員：每款照商品起批數就能少量下單，沒有總件數限制
・所有訂單都依廠商湊單：同一廠商所有客人已付款的訂單湊滿約 NT$30,000 就向日本叫貨，先付款先寄
・湊滿叫貨後約 2～3 週到貨
・湊滿時會用 LINE 問您要這批出貨還是順延（想等其他廠商一起寄可以選順延）
・一張訂單有多家廠商時，哪家先到貨就先寄哪家

━━ 運費 ━━
・每次出貨國內運費 NT$60，國際運費依物流公司報價（約每公斤 NT$220）
・會員每月送運費券，出貨時自動折抵
👉 想少量多樣進貨，加入會員最划算

━━ 會員方案 ━━
👑 VIP 會員 NT$1,000／月（推薦）
・每月 10 張國內＋10 張國際運費券
・全館 VIP 價，每件再便宜 NT$30
・真正少量叫貨，沒有總件數限制
・新品優先通知
🔹 一般會員 NT$100／月：每月 5 張國內運費券，不同款混批 21 件

💡 幫您算：每月進貨 34 件以上，VIP 每件省的 NT$30 就把月費賺回來了，還有 20 張運費券！
點下面卡片就能直接加入，付款完成自動開通👇`;
  const qrs = [["🔥 熱賣推薦", "熱賣推薦"], ["吉伊卡哇", "吉伊卡哇"], ["三麗鷗", "三麗鷗"], ["✨ 新品上線", "新品上線"], ["加入 VIP", "會員方案"]];
  const cards = await membershipCards(env, uid);
  cards[0].quickReply = { items: qrs.map(([l, t]) => ({ type: "action", action: { type: "message", label: l, text: t } })) };
  const video = introVideoMsg();
  return [{ type: "text", text }, video, { type: "text", text: text2 }, ...cards];
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

// ---------- 圖文選單：新品上線／熱賣推薦 的商品卡片 ----------
const okItem = (it, isExpired) => it && it.img && !it.hid && !isExpired(it) && !/缺貨|停售|截止/.test(it.st || "") && cleanName(it);
const famKey = (it) => { const t = String(it.n || "").split(/[/／]/)[0].trim().split(/\s+/); return (it.b || "") + "|" + t.slice(0, Math.max(1, Math.min(2, t.length - 1))).join(" "); };
const cleanName = (it) => !/[\u30a0-\u30ff\u3040-\u309f]{2}/.test(String(it.n || ""));
function mixBrands(list, n) { // 輪流從不同品牌挑，避免全部同一家
  const g = new Map(); for (const it of list) { const b = it.b || ""; if (!g.has(b)) g.set(b, []); g.get(b).push(it); }
  const lists = [...g.values()].map((l) => diverse(l, n)), out = [];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) for (const l of lists) { if (l[i]) out.push(l[i]); if (out.length >= n) break; }
  return out;
}
function diverse(list, n) {
  const seen = new Set(), out = [];
  for (const it of list) { const k = famKey(it); if (seen.has(k)) continue; seen.add(k); out.push(it); if (out.length >= n) break; }
  return out;
}
// 同一款商品有「預購」和「日本現貨」兩種來源：把兩邊互相連起來（LINE 卡片一起顯示兩種價格）
export function linkAlts(items) {
  const m = new Map(items.map((it) => [keyOf(it), it]));
  for (const it of items) if (it.alt) { const p = m.get(it.alt); if (p) Object.defineProperty(it, "_alt", { value: p, enumerable: false, configurable: true, writable: true }); }
}
export function newPicks(items, isExpired, n = 10) {
  return mixBrands(items.filter((it) => okItem(it, isExpired)).sort((a, b) => String(b.ad || "").localeCompare(String(a.ad || ""))).slice(0, 1500), n);
}
export async function hotPicks(env, items, isExpired, n = 10) {
  const by = new Map(items.map((it) => [keyOf(it), it]));
  const cnt = new Map();
  try {
    for (const o of await allOrders(env, 300)) {
      if (o.status === "已取消") continue;
      for (const l of o.lines || []) if (!l.mem && by.has(l.k)) cnt.set(l.k, (cnt.get(l.k) || 0) + (l.q || 1));
    }
  } catch (e) {}
  const ranked = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => by.get(k)).filter((it) => okItem(it, isExpired));
  const HOT = /吉伊卡哇|ちいかわ|三麗鷗|サンリオ|Hello Kitty|酷洛米|大耳狗|寶可夢|史努比|蠟筆小新|拉拉熊|角落生物/i;
  const fill = items.filter((it) => okItem(it, isExpired) && HOT.test((it.n || "") + (it.b || "")) && /現貨|◎|○|有貨/.test(it.st || ""))
    .sort((a, b) => { const P = /絨毛|娃娃|吊飾|鑰匙圈|公仔|收納包|斜背包/; return (P.test(b.n) - P.test(a.n)) || String(b.ad || "").localeCompare(String(a.ad || "")); });
  const top = diverse(ranked, n);
  return diverse([...top, ...mixBrands(fill.slice(0, 600), n)], n);
}

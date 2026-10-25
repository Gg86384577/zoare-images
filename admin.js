// ZOARÉ 商家後台：老闆在 LINE 傳「後台」取得專屬連結（只有綁定的老闆帳號能開）
import { canMerge, fillLineImgs, listBatches, arrivalState, orderMfrs, computePools, mfrOf, mfrStatusSync, cartList, TIER_NAME, sign, allOrders, lineCost, situation, OPEN, payDiff, shopOwnerCommand, SHOP_BASE, setMembership, fmtDay } from "./shop.js";

export async function adminLink(env, uid) {
  return `${SHOP_BASE}/admin?t=${uid}.${await sign(env, "admin:" + uid)}`;
}
async function isOwner(env, t) {
  const [uid, sig] = String(t || "").split(".");
  if (!uid || !sig) return false;
  const owner = await env.SESSIONS.get("owner");
  return uid === owner && sig === (await sign(env, "admin:" + uid));
}
const tw = () => new Date(Date.now() + 8 * 3600e3);

async function poolData(env, deps, orders) {
  const P = await computePools(env, {});
  let imgs = new Map();
  try { imgs = new Map((await deps.loadCatalog(env)).map((x) => [String(x.jan || ""), x.img || ""]).filter((a) => a[0])); } catch (e) {}
  const byId = new Map(orders.map((o) => [o.id, o]));
  const list = Object.entries(P.pools).map(([m, p]) => {
    const items = {};
    for (const id of p.orders) {
      const o = byId.get(id); if (!o) continue;
      for (const l of o.lines || []) {
        if (l.mem || (l.m || mfrOf(l.b)) !== m) continue;
        const k = l.jan || l.k || l.n, it = (items[k] = items[k] || { n: l.n, jan: l.jan || "", q: 0, img: imgs.get(String(l.jan || "")) || "", ids: [] });
        it.q += l.q; if (!it.ids.includes(id)) it.ids.push(id);
      }
    }
    const ords = p.orders.map((id) => byId.get(id)).filter(Boolean).map((o) => ({ id: o.id, name: o.lineName, tier: TIER_NAME[o.tier] || "非會員", at: o.paidAt || o.at, ans: o.ask && o.ask[m] ? o.ask[m].ans || "未回覆" : "" }));
    return { m, nt: p.nt, pct: p.pct, ready: p.nt >= P.need, since: p.since, orders: ords, items: Object.values(items).sort((a, b) => b.q - a.q) };
  }).sort((a, b) => b.nt - a.nt);
  const waiting = [];
  for (const o of orders) if (o.status === "已付款") for (const x of mfrStatusSync(o, P.pools, P.need)) if (x.k === "po") waiting.push({ id: o.id, name: o.lineName, m: x.m, at: o.po[x.m].at, paid: o.paidAt || o.at, items: o.lines.filter((l) => !l.mem && (l.m || mfrOf(l.b)) === x.m).map((l) => ({ n: l.n, q: l.q })) });
  waiting.sort((x, y) => (x.m + x.paid).localeCompare(y.m + y.paid));
  const batches = (await listBatches(env, 40)).map((b) => ({ ...b, n: b.orders.length }));
  const ready = [], hold = [];
  for (const o of orders) {
    if (o.status !== "已付款") continue;
    const st = arrivalState(o);
    if (!st.arrived.length) continue;
    const row = { id: o.id, name: o.lineName, tier: TIER_NAME[o.tier] || "非會員", arrived: st.arrived, waiting: st.waiting, choice: st.choice, paid: o.paidAt || o.at, items: o.lines.filter((l) => !l.mem && st.arrived.includes(l.m || mfrOf(l.b))).map((l) => ({ n: l.n, q: l.q, jan: l.jan || "", img: imgs.get(String(l.jan || "")) || "" })) };
    (st.ready ? ready : hold).push(row);
  }
  ready.sort((x, y) => String(x.paid).localeCompare(String(y.paid)));
  return { need: P.need, rate: P.rate, list, waiting, P: P.pools, batches, ready, hold };
}
async function buildData(env, deps = {}) {
  const orders = await allOrders(env, 200);
  await fillLineImgs(env, deps, orders).catch(() => {});
  const mgroups = {}; for (const o of orders) if (canMerge(o)) (mgroups[o.uid] = mgroups[o.uid] || []).push(o.id);
  const today = tw().toISOString().slice(0, 10), month = today.slice(0, 7);
  const wk = new Date(tw()); wk.setUTCDate(wk.getUTCDate() - ((wk.getUTCDay() + 6) % 7)); const week = wk.toISOString().slice(0, 10);
  const Z = () => ({ n: 0, rev: 0, profit: 0, pcs: 0 });
  const st = { today: Z(), week: Z(), month: Z(), all: Z() };
  const daily = {}, items = {}, cust = {};
  const mem = { vip: { q: 0, amt: 0, m: 0, mamt: 0 }, member: { q: 0, amt: 0, m: 0, mamt: 0 } };
  for (let i = 13; i >= 0; i--) { const d = new Date(tw()); d.setUTCDate(d.getUTCDate() - i); daily[d.toISOString().slice(0, 10)] = 0; }
  const counts = { 待付款: 0, 已回報匯款: 0, 待確認: 0, 已付款: 0, 已出貨: 0, 已取消: 0 };
  for (const o of orders) {
    counts[o.status] = (counts[o.status] || 0) + 1;
    const c = (cust[o.uid] = cust[o.uid] || { uid: o.uid, name: o.lineName, orders: 0, spent: 0, last: o.at });
    c.orders++;
    if (o.status === "已付款" || o.status === "已出貨") {
      c.spent += o.total;
      const d = (o.paidAt || o.at).slice(0, 10);
      const profit = o.lines.reduce((a, l) => a + (l.price - lineCost(o, l)) * l.q, 0), pcs = o.lines.reduce((a, l) => a + l.q, 0);
      const add = (x) => { x.n++; x.rev += o.total; x.profit += profit; x.pcs += pcs; };
      add(st.all); if (d.startsWith(month)) add(st.month); if (d >= week) add(st.week); if (d === today) add(st.today);
      if (d in daily) daily[d] += o.total;
      for (const l of o.lines) if (l.mem && mem[l.mem]) { mem[l.mem].q += l.q; mem[l.mem].amt += l.sub; if (d.startsWith(month)) { mem[l.mem].m += l.q; mem[l.mem].mamt += l.sub; } }
      if (d.startsWith(month)) for (const l of o.lines) { const it = (items[l.n] = items[l.n] || { n: l.n, q: 0, amt: 0 }); it.q += l.q; it.amt += l.sub; }
    }
  }
  // 客人名單：下過單的＋傳過訊息的
  // 全部同時讀（以前一筆一筆讀，客人一多後台就很慢）
  const [nameKeys, owner, bank, linepay, news] = await Promise.all([env.SESSIONS.list({ prefix: "n:" }), env.SESSIONS.get("owner"), env.SESSIONS.get("bank"), env.SESSIONS.get("linepay"), env.SESSIONS.get("news")]);
  const names = nameKeys.keys.slice(0, 300);
  const uids = await Promise.all(names.map((k) => env.SESSIONS.get(k.name)));
  names.forEach((k, i) => { const uid = uids[i]; if (uid && !cust[uid]) cust[uid] = { uid, name: k.name.slice(2), orders: 0, spent: 0, last: "" }; });
  const cs = Object.values(cust).filter((c) => c.uid !== owner);
  const tinfo = await Promise.all(cs.map((c) => Promise.all([env.SESSIONS.get("tier:" + c.uid), env.SESSIONS.get("tx:" + c.uid)])));
  const custList = cs.map((c, i) => { c.tier = tinfo[i][0] || "none"; const tx = Number(tinfo[i][1]) || 0; if (tx && tx < Date.now()) c.tier = "none"; c.until = c.tier !== "none" && tx ? fmtDay(tx) : ""; return c; });
  custList.sort((a, b) => b.spent - a.spent || (b.last || "").localeCompare(a.last || ""));
  const carts = await cartList(env);
  const pools = await poolData(env, deps, orders).catch((e) => ({ need: 20000, list: [], err: String(e) }));
  return {
    carts, pools, stats: st, daily, counts,
    members: { ...mem, active: { vip: custList.filter((c) => c.tier === "vip").length, member: custList.filter((c) => c.tier === "member").length } },
    top: Object.values(items).sort((a, b) => b.q - a.q).slice(0, 20),
    orders: orders.map((o) => ({ id: o.id, uid: o.uid, name: o.lineName, at: o.at, status: o.status, situation: situation(o), memo: o.memo || "",
      total: o.total, qty: o.qty, pay: o.form.pay || "轉帳", paid5: o.paid5 || "", track: o.track || "", tier: TIER_NAME[o.tier], diff: payDiff(o).trim(), mst: mfrStatusSync(o, (pools && pools.P) || {}, pools && pools.need), shipDue: o.shipDue || 0, intlPend: Object.values(o.sh || {}).some((v) => v.fee && v.fee.intl === null),
      mergeWith: canMerge(o) && (mgroups[o.uid] || []).length > 1 ? mgroups[o.uid] : [], lines: o.lines.map((l) => ({ n: l.n, q: l.q, price: l.price, sub: l.sub, jan: l.jan, img: l.img || "", sh: !!(o.sh && o.sh[l.m || mfrOf(l.b)]) })), form: o.form, notes: o.notes || [] })),
    customers: custList,
    settings: { bank: bank || "", linepay: linepay || "", news: JSON.parse(news || "[]") },
  };
}

export async function handleAdmin(request, env, ctx, deps) {
  const url = new URL(request.url);
  if (url.pathname === "/admin" || url.pathname === "/admin/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const t = request.headers.get("x-admin") || url.searchParams.get("t");
  if (!(await isOwner(env, t))) return Response.json({ ok: false, error: "沒有權限，請在 LINE 傳「後台」重新取得連結" }, { status: 401 });
  if (url.pathname === "/admin/api/data") return Response.json({ ok: true, ...(await buildData(env, deps)) });
  if (request.method === "POST" && url.pathname === "/admin/api/cmd") {
    const { text } = await request.json();
    const r = await shopOwnerCommand(env, String(text || "").slice(0, 2000), deps);
    return Response.json({ ok: !!r, result: Array.isArray(r) ? r.join("\n\n") : r || "指令沒有執行" });
  }
  if (request.method === "POST" && url.pathname === "/admin/api/tier") {
    const { uid, tier } = await request.json();
    if (!/^U[0-9a-f]{32}$/.test(uid || "")) return Response.json({ ok: false });
    const r = await setMembership(env, uid, tier === "vip" || tier === "member" ? tier : "none", { months: 1 }, false);
    return Response.json({ ok: true, result: `已設定為 ${TIER_NAME[r.tier] || "非會員"}${r.until ? `，有效到 ${fmtDay(r.until)}` : ""}` });
  }
  return new Response("Not found", { status: 404 });
}

const PAGE = String.raw`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ZOARÉ 商家後台</title>
<style>
:root{--bg:#eceef0;--ink:#161616;--sub:#6b6f75;--line:#dcdfe3;--red:#9e1b1b;--green:#1f6b33}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}[hidden]{display:none!important}
body{font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:var(--bg);color:var(--ink);padding-bottom:84px}
header{position:sticky;top:0;z-index:5;background:#161616;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:Georgia,serif;letter-spacing:5px;font-size:20px;color:#d5d8dc}.logo small{font-family:inherit;letter-spacing:1px;font-size:12px;color:#9a9da1;margin-left:8px}
.rf{border:0;background:#2a2c30;color:#fff;border-radius:10px;padding:7px 12px;font-size:13px}
nav{position:fixed;left:0;right:0;bottom:0;z-index:6;background:#161616;display:flex;padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;border:0;background:none;color:#8d9096;padding:10px 0 12px;font-size:12px;display:flex;flex-direction:column;align-items:center;gap:3px}
nav button b{font-size:19px;font-weight:400}nav button.on{color:#fff}
main{padding:12px;max-width:900px;margin:0 auto}
.k{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}@media(min-width:640px){.k{grid-template-columns:repeat(4,1fr)}}
.kc{background:#fff;border-radius:14px;padding:12px}.kc small{color:var(--sub);font-size:12px}.kc b{display:block;font-size:22px;margin-top:2px}.kc i{font-style:normal;font-size:12px;color:var(--green)}
.card{background:#fff;border-radius:14px;padding:14px;margin-top:12px}.card h3{font-size:15px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.seg{display:flex;gap:6px;flex-wrap:wrap}.seg button{border:1px solid var(--line);background:#fff;border-radius:16px;padding:6px 12px;font-size:13px;color:var(--ink)}.seg button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.bars{display:flex;align-items:flex-end;gap:4px;height:120px}.bar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}.bar div{width:100%;background:#2a2c30;border-radius:4px 4px 0 0;min-height:2px}.bar span{font-size:9px;color:var(--sub);margin-top:3px}
.row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid #f0f1f2;font-size:13.5px}.row:first-of-type{border-top:0}
.chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}.chips::-webkit-scrollbar{display:none}
.chip{flex:none;border:1px solid var(--line);background:#fff;border-radius:16px;padding:6px 12px;font-size:13px}.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
input.f,textarea.f,select.f{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:16px;font-family:inherit;background:#fff;color:var(--ink)}
.o{background:#fff;border-radius:14px;padding:12px 14px;margin-top:10px}
.o .hd{display:flex;justify-content:space-between;align-items:center;gap:8px}.o .hd b{font-size:15px}
.st{border-radius:10px;padding:2px 9px;font-size:12px;font-weight:600;background:#eee;white-space:nowrap}
.s-待付款,.s-待確認{background:#fff1d6;color:#8a5a00}.s-已回報匯款,.s-已付款{background:#e3effc;color:#1d4f8f}.s-已出貨{background:#e2f4e6;color:#1f6b33}.s-已取消{background:#eee;color:#888}
.meta{font-size:12.5px;color:var(--sub);margin-top:3px}.sit{font-size:13px;margin-top:6px}.memo{font-size:13px;background:#fff9e6;border-radius:8px;padding:6px 9px;margin-top:6px}
.diff{font-size:13px;color:var(--red);margin-top:4px}
.it{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px dashed #eee;font-size:13px}.it .n{flex:1}.it input{width:64px;padding:6px;font-size:15px;border:1px solid var(--line);border-radius:8px;text-align:center}
.btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.btns button,.btn{border:0;border-radius:10px;padding:9px 12px;font-size:13.5px;background:#f0f1f2;color:var(--ink)}
.btn.dark,.btns .dark{background:var(--ink);color:#fff}.btns .del{background:#fff0f0;color:var(--red)}
details summary{font-size:13px;color:var(--sub);margin-top:8px}
.toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:#161616;color:#fff;padding:10px 16px;border-radius:12px;font-size:13.5px;z-index:20;max-width:90%;white-space:pre-wrap}
.cu{display:flex;align-items:center;gap:10px;background:#fff;border-radius:14px;padding:12px 14px;margin-top:8px}.cu .n{flex:1}.cu .n small{display:block;color:var(--sub);font-size:12px}.cu select{width:auto;padding:6px 8px;font-size:14px}
.err{padding:60px 20px;text-align:center;color:var(--sub);line-height:1.8}
label.l{display:block;font-size:12.5px;color:var(--sub);margin:10px 0 4px}
</style></head><body>
<header><div class="logo">ZOARÉ<small>商家後台</small></div><button class="rf" id="rf">↻ 更新</button></header>
<main id="m"><div class="err">載入中…</div></main>
<nav id="nav"><button data-v="home" class="on"><b>◫</b>總覽</button><button data-v="orders"><b>☰</b>訂單</button><button data-v="cust"><b>☺</b>客人</button><button data-v="pools"><b>📦</b>叫貨</button><button data-v="carts"><b>🛒</b>購物車</button><button data-v="sales"><b>↗</b>銷售</button><button data-v="set"><b>⚙</b>設定</button></nav>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=n=>"NT$"+Number(n||0).toLocaleString();
let D=null,V="home",OF="進行中",OQ="",SP="month";
async function api(p,body){const r=await fetch(p,{method:body?"POST":"GET",headers:{"x-admin":T,"content-type":"application/json"},body:body?JSON.stringify(body):undefined});return r.json()}
function toast(t){const d=document.createElement("div");d.className="toast";d.textContent=t;document.body.appendChild(d);setTimeout(()=>d.remove(),3500)}
async function load(){const r=await api("/admin/api/data");if(!r.ok){$("#m").innerHTML='<div class="err">'+esc(r.error)+'</div>';$("#nav").hidden=true;return}D=r;render()}
async function cmd(text,reload=true){const r=await api("/admin/api/cmd",{text});toast(r.result||"完成");if(reload)await load();return r}
$("#rf").onclick=load;
$("#nav").onclick=e=>{const b=e.target.closest("button");if(!b)return;V=b.dataset.v;document.querySelectorAll("nav button").forEach(x=>x.classList.toggle("on",x===b));render();scrollTo(0,0)};
function render(){({home,orders,cust,sales,set,carts,pools})[V]()}
function ago(t){const m=Math.floor((Date.now()-t)/6e4);return m<60?m+" 分鐘前":m<1440?Math.floor(m/60)+" 小時前":Math.floor(m/1440)+" 天前"}
function pools(){const P=D.pools||{list:[]},L=P.list||[],R=L.filter(p=>p.ready);
  $("#m").innerHTML='<div class="card"><h3>廠商叫貨進度（門檻 NT$'+(P.need||20000).toLocaleString()+'）</h3><p class="meta">只算「已付款」還沒向日本叫貨的訂單，以進價計算（人民幣 4,000 元換算，最低 NT$20,000，匯率高時跟著調高）。同一廠商不同 IP／系列、不同客人的訂單都合併計算，先付款先寄。滿門檻會自動 LINE 通知你；叫完貨按「標記已叫貨」，這批訂單會變成一個「批次」（NT$20,000 一個單位），貨備好再到下面按「這批到貨了」。</p>'+(R.length?'<p style="margin:8px 0 0"><b style="color:#b8954a">✅ 可以叫貨：'+R.map(p=>esc(p.m)).join("、")+'</b></p>':'<p class="meta" style="margin-top:8px">目前沒有廠商湊滿</p>')+'</div>'+
  (L.length?L.map(p=>'<div class="card"><div class="row" style="cursor:default"><span><b>'+esc(p.m)+'</b>　<small class="meta">'+p.orders.length+' 筆訂單</small></span><b style="color:'+(p.ready?'#b8954a':'inherit')+'">NT$'+p.nt.toLocaleString()+'／'+(P.need||20000).toLocaleString()+'</b></div><div style="height:8px;border-radius:4px;background:#eee;overflow:hidden;margin:6px 0"><div style="height:100%;width:'+Math.min(100,p.pct)+'%;background:'+(p.ready?'#b8954a':'#999')+'"></div></div><div class="meta">'+(p.ready?'已湊滿，可以叫貨':'湊單中 '+p.pct+'%，還差 NT$'+Math.max(0,(P.need||20000)-p.nt).toLocaleString())+'</div>'+
  '<details style="margin-top:8px"'+(p.ready?' open':'')+'><summary class="meta" style="cursor:pointer">要出貨的訂單（'+p.orders.length+'，依付款先後）／商品（'+p.items.length+' 款）</summary><div style="margin:6px 0">'+p.orders.map((o,i)=>'<div class="meta" style="padding:2px 0">'+(i+1)+'. <b>'+esc(o.id)+'</b>　'+esc(o.name||"")+'　'+esc(o.tier)+'　'+esc((o.at||"").slice(5,16).replace("T"," "))+(o.ans?'　<b style="color:'+(o.ans==="出貨"?'#1f6b33':o.ans==="順延"?'#9e1b1b':'#8a5a00')+'">'+(o.ans==="出貨"?'✅ 確認出貨':o.ans==="順延"?'⏸ 順延':'⏳ 未回覆')+'</b>':'')+'</div>').join("")+'</div>'+
  p.items.map(i=>'<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid #eee">'+(i.img?'<img src="'+esc(i.img)+'" style="width:44px;height:44px;object-fit:cover;border-radius:6px">':'<span style="width:44px"></span>')+'<span style="flex:1;font-size:13px">'+esc(i.n)+'<br><small class="meta">JAN '+esc(i.jan||"—")+'</small></span><b>×'+i.q+'</b></div>').join("")+'</details>'+
  (!p.ready?'<button class="btn" style="margin-top:8px" onclick="invite(\''+esc(p.m).replace(/'/g,"")+'\')">📣 提醒買家一起湊</button>':'')+(p.ready?'<button class="btn" style="margin-top:8px" onclick="poDone(\''+esc(p.m).replace(/'/g,"")+'\')">標記已叫貨</button>':'')+'</div>').join(""):'<div class="card"><p class="meta">目前沒有已付款待叫貨的訂單</p></div>')+
  '<div class="card"><h3>📦 批次（每批＝同廠商湊滿 NT$'+(P.need||20000).toLocaleString()+' 叫的一次貨）</h3><p class="meta">貨備好／到貨就按「這批到貨了」。訂單只有這家的商品、或其他廠商也都到了 → 直接進「待出貨」；還有其他廠商沒到 → 系統 LINE 問客人要先寄（付一次 $60）還是等齊再寄。</p></div>'+
  ((P.batches||[]).filter(b=>b.status!=="已到貨").map(b=>'<div class="card"><div class="row" style="cursor:default"><span><b>'+esc(b.m)+'</b>　<small class="meta">'+esc(b.id)+'・叫貨 '+esc((b.at||"").slice(5,10))+'・'+b.n+' 筆・NT$'+(b.nt||0).toLocaleString()+'</small></span><button class="btn" style="background:#161616;color:#fff" onclick="arrB(\''+esc(b.id)+'\')">📦 這批到貨了</button></div></div>').join("")||'<div class="card"><p class="meta">目前沒有等到貨的批次</p></div>')+
  '<div class="card"><h3>🚚 待出貨（'+(P.ready||[]).length+'）</h3><p class="meta">已到貨的商品，依付款先後。按「出貨」會把這張訂單已到貨的商品一次寄出（算一次運費），寄出的商品會在訂單裡劃掉。</p></div>'+
  (P.ready||[]).map(r=>'<div class="card"><div class="row" style="cursor:default"><span><b>'+esc(r.name||"")+'</b>　<small class="meta">'+esc(r.id)+'・'+esc(r.tier)+(r.waiting.length?'・客人選先寄（還在等 '+esc(r.waiting.join("、"))+'）':'')+'</small></span><button class="btn" style="background:#161616;color:#fff" onclick="shipM(\''+r.id+'\',\'已到貨\')">🚚 出貨</button></div><div class="meta">寄：'+esc(r.arrived.join("、"))+'</div>'+r.items.map(i=>'<div style="display:flex;gap:8px;align-items:center;padding:3px 0;border-top:1px solid #eee">'+(i.img?'<img src="'+esc(i.img)+'" style="width:36px;height:36px;object-fit:cover;border-radius:6px">':'')+'<span style="flex:1;font-size:13px">'+esc(i.n)+'</span><b>×'+i.q+'</b></div>').join("")+'</div>').join("")+
  ((P.hold||[]).length?'<div class="card"><h3>⏳ 已到貨、留著等齊（'+P.hold.length+'）</h3>'+P.hold.map(r=>'<div class="meta" style="padding:4px 0;border-top:1px solid #eee"><b>'+esc(r.id)+'</b>　'+esc(r.name||"")+'<br>已到：'+esc(r.arrived.join("、"))+'　還在等：'+esc(r.waiting.join("、"))+'　'+(r.choice==="等齊"?'<b>客人選等齊再寄</b>':'<b style="color:#8a5a00">等客人回覆</b>')+' <button class="btn" style="padding:4px 8px;font-size:12px" onclick="shipM(\''+r.id+'\',\'已到貨\')">還是先寄</button></div>').join("")+'</div>':'')}
window.arrB=async b=>{if(!confirm("確定批次 "+b+" 的貨已經備好／到貨？\n會通知需要的客人"))return;await cmd("到貨 "+b)};
window.invite=async m=>{if(!confirm("發 LINE 給全部買家，邀請一起湊 "+m+" ？"))return;await cmd("湊單提醒 "+m)};
window.cartAll=async()=>{if(!confirm("發 LINE 提醒全部購物車客人結帳？"))return;await cmd("購物車提醒 全部")};
window.cartOne=async u=>{await cmd("購物車提醒 "+u)};
window.mergeO=async ids=>{if(!confirm("把這些訂單合併成一張？\n"+ids.replace(/ /g,"、")+"\n\n會併入最早的那張、通知客人，被併入的訂單會移除"))return;await cmd("合併 "+ids)};
window.poDone=
async m=>{if(!confirm("確定 "+m+" 已向日本叫貨？這些訂單會標記為已叫貨"))return;await cmd("叫貨 "+m+" 完成")};
function carts(){const L=D.carts||[];
  $("#m").innerHTML='<div class="card"><h3>購物車還沒結帳（'+L.length+' 位）</h3>'+(L.length?'<button class="btn" style="background:#161616;color:#fff;margin:6px 0 8px" onclick="cartAll()">📣 全部發結帳提醒</button>':'')+'<p class="meta">只記錄用專屬連結進商城的客人。放超過 6 小時沒結帳，機器人會在 11:00～21:00 自動提醒一次（LINE 傳「購物車提醒 關」可以關掉）。</p></div>'+
  (L.length?L.map(c=>'<div class="card"><div class="row" style="cursor:default"><span><b>'+esc(c.name||"（未知）")+'</b>　<small class="meta">'+esc(c.tier==="vip"?"VIP":c.tier==="member"?"一般會員":"非會員")+'・'+ago(c.at)+'更新'+(c.reminded?'・已提醒':'')+'</small></span><b>'+fmt(c.total)+'</b></div>'+c.lines.map(l=>'<div class="meta" style="padding:2px 0">・'+esc(l.n)+' ×'+l.q+'　'+fmt(l.price*l.q)+'</div>').join("")+'<div class="meta" style="margin-top:6px">共 '+c.lines.length+' 款 '+c.qty+' 件</div><button class="btn" style="margin-top:8px" onclick="cartOne(\''+c.uid+'\')">📣 提醒他結帳</button></div>').join(""):'<div class="card"><p class="meta">目前沒有客人的購物車有東西</p></div>')}
function kc(t,v,s){return '<div class="kc"><small>'+t+'</small><b>'+v+'</b>'+(s?'<i>'+s+'</i>':'')+'</div>'}
function home(){const s=D.stats,c=D.counts;const max=Math.max(1,...Object.values(D.daily));
  $("#m").innerHTML='<div class="k">'+kc("今日銷售額",fmt(s.today.rev),"淨利 "+fmt(s.today.profit))+kc("本月銷售額",fmt(s.month.rev),"淨利 "+fmt(s.month.profit))+kc("本月訂單",s.month.n+" 筆",s.month.pcs+" 件")+kc("待處理",(c["待付款"]+c["已回報匯款"]+c["待確認"]+c["已付款"])+" 筆","待出貨 "+c["已付款"]+" 筆")+'</div>'+
  '<div class="card"><h3>近 14 天銷售額</h3><div class="bars">'+Object.entries(D.daily).map(([d,v])=>'<div class="bar" title="'+d+' '+fmt(v)+'"><div style="height:'+Math.round(v/max*100)+'%"></div><span>'+d.slice(8)+'</span></div>').join("")+'</div></div>'+
  '<div class="card"><h3>需要處理</h3>'+[["待確認","付款截圖對不上，要人工確認"],["已付款","已付款，等出貨"],["待付款","等客人付款"],["已回報匯款","客人回報後五碼，等截圖"]].map(([k,t])=>'<div class="row" onclick="goOrders(\''+k+'\')"><span>'+t+'</span><b>'+(c[k]||0)+' 筆 ›</b></div>').join("")+'</div>'}
window.goOrders=f=>{OF=f;V="orders";document.querySelectorAll("nav button").forEach(x=>x.classList.toggle("on",x.dataset.v==="orders"));render()};
const FILTERS=["進行中","待付款","待確認","已付款","已出貨","已取消","全部"];
function orders(){
  const list=D.orders.filter(o=>(OF==="全部"||(OF==="進行中"?["待付款","已回報匯款","待確認","已付款"].includes(o.status):o.status===OF))&&(!OQ||(o.id+o.name+o.form.name+o.form.phone+o.lines.map(l=>l.n).join("")).toLowerCase().includes(OQ.toLowerCase())));
  $("#m").innerHTML='<input class="f" id="oq" placeholder="搜尋客人、訂單編號、商品" value="'+esc(OQ)+'"><div class="chips" style="margin-top:8px">'+FILTERS.map(f=>'<button class="chip'+(f===OF?" on":"")+'" data-f="'+f+'">'+f+'</button>').join("")+'</div>'+
  '<div class="meta" style="margin-top:8px">共 '+list.length+' 筆　'+fmt(list.reduce((a,o)=>a+o.total,0))+'</div>'+(list.map(ocard).join("")||'<div class="err">沒有訂單</div>');
  $("#oq").oninput=e=>{OQ=e.target.value;clearTimeout(window._t);window._t=setTimeout(()=>{orders();const i=$("#oq");i.focus();i.setSelectionRange(i.value.length,i.value.length)},400)};
  document.querySelectorAll(".chip[data-f]").forEach(b=>b.onclick=()=>{OF=b.dataset.f;orders()});
}
function ocard(o){return '<div class="o" data-id="'+o.id+'"><div class="hd"><b>'+esc(o.name)+'</b><span class="st s-'+esc(o.status)+'">'+esc(o.status)+'</span></div>'+
  '<div class="meta">'+o.id+'｜'+esc(o.at)+'｜'+o.qty+' 件｜'+esc(o.pay)+'｜'+esc(o.tier)+'價</div><div style="font-size:18px;font-weight:700;margin-top:4px">'+fmt(o.total)+'</div>'+
  ((o.mergeWith||[]).length>1?'<div style="margin-top:8px;background:#fff6db;border:1px solid #f0d58a;border-radius:10px;padding:8px 10px;font-size:13px;display:flex;align-items:center;gap:8px"><span style="flex:1">🔗 這位客人有 <b>'+o.mergeWith.length+' 張</b>還沒出貨的訂單（'+o.mergeWith.map(esc).join("、")+'），要合併嗎？</span><button class="btn" style="background:#161616;color:#fff;padding:6px 10px" onclick="mergeO(\''+o.mergeWith.join(" ")+'\')">合併</button></div>':'')+
  '<div class="sit">狀況：'+esc(o.situation.split("\n")[0])+'</div>'+((o.mst||[]).length&&o.status!=="已取消"?'<div style="margin-top:6px">'+o.mst.map(z=>'<div class="meta" style="display:flex;gap:6px;align-items:center;padding:3px 0"><span style="flex:1">🏭 <b>'+esc(z.m)+'</b>：'+esc(z.s)+'</span>'+(z.k!=="sh"&&o.status==="已付款"?'<button class="btn" style="padding:5px 9px;font-size:12px" onclick="shipM(\''+o.id+'\',\''+esc(z.m).replace(/'/g,"")+'\')">🚚 這家已出貨</button>':'')+'</div>').join("")+'</div>':'')+(o.shipDue||o.intlPend?'<div class="memo">🚚 已出貨運費要收 NT$'+o.shipDue.toLocaleString()+(o.intlPend?'　<b style="color:#9e1b1b">國際運費待填</b> <button class="btn" style="padding:4px 8px;font-size:12px" onclick="intlFee(\''+o.id+'\')">填國際運費</button>':'')+'</div>':'')+(o.memo?'<div class="memo">📝 '+esc(o.memo)+'</div>':'')+(o.diff?'<div class="diff">'+esc(o.diff)+'</div>':'')+
  '<details><summary>品項・收件資料・修改</summary>'+o.lines.map((l,i)=>'<div class="it">'+(l.img?'<img src="'+esc(l.img)+'" loading="lazy" style="width:52px;height:52px;object-fit:cover;border-radius:8px;flex:none">':'')+'<span class="n"'+(l.sh?' style="color:#999"':'')+'>'+(l.sh?'✅ <s>'+esc(l.n)+'</s> 已出貨':esc(l.n))+'<br><small style="color:#888">'+fmt(l.price)+' × '+l.q+' = '+fmt(l.sub)+'</small></span><input type="number" min="0" value="'+l.q+'" data-i="'+i+'"><button class="btn" onclick="setQ(\''+o.id+'\','+i+',this)">改</button></div>').join("")+
  '<div class="meta" style="margin-top:8px;color:#333">收件人：'+esc(o.form.name)+'　'+esc(o.form.phone)+'<br>寄送：'+esc(o.form.ship)+'　'+esc(o.form.addr)+(o.form.note?'<br>備註：'+esc(o.form.note):'')+(o.paid5?'<br>後五碼：'+esc(o.paid5):'')+(o.track?'<br>物流單號：'+esc(o.track):'')+'</div>'+
  (o.notes.length?'<div class="meta" style="color:#8c2a1f;margin-top:6px">'+o.notes.map(esc).join("<br>")+'</div>':'')+
  '<div class="btns"><button onclick="addItem(\''+o.id+'\')">＋ 加商品</button><button onclick="memo(\''+o.id+'\')">📝 備註</button><button class="del" onclick="delO(\''+o.id+'\')">🗑 刪除訂單</button></div></details>'+
  '<div class="btns">'+(o.status!=="已取消"&&o.status!=="已出貨"?'<button onclick="editO(\''+o.id+'\')">✏️ 改數量</button>':'')+(["待付款","已回報匯款","待確認"].includes(o.status)?'<button class="dark" onclick="st(\''+o.id+'\',\'已付款\')">✓ 確認已付款</button>':'')+(o.status==="已付款"?'<button class="dark" onclick="ship(\''+o.id+'\')">🚚 出貨</button>':'')+(o.status!=="已取消"&&o.status!=="已出貨"?'<button onclick="st(\''+o.id+'\',\'取消\')">取消訂單</button>':'')+'</div></div>'}
const ord=id=>D.orders.find(o=>o.id===id);
window.st=async(id,s)=>{if(s==="取消"&&!confirm("確定取消 "+id+"？會通知客人"))return;await cmd(id+" "+s)};
window.shipM=async(id,m)=>{const t=prompt(m+" 的商品已出貨\n物流單號（可空白）","");if(t===null)return;const v=prompt("這次國際運費要收多少？（NT$，約每公斤 $220）\n客人有國際運費券會自動折抵；還不知道可空白，之後再填","");if(v===null)return;await cmd(id+" 分批出貨 "+m+(t?" "+t:"")+(v&&Number(v)>0?" 國際"+Math.round(Number(v)):""))};
window.intlFee=async id=>{const v=prompt("國際運費金額（NT$）","");if(!v||!(Number(v)>=0))return;await cmd(id+" 國際運費 "+Math.round(Number(v)))};
window.ship=async id=>shipM(id,"全部");
window.memo=async id=>{const t=prompt("備註（空白＝清除）",ord(id).memo||"");if(t===null)return;await cmd(id+" 備註 "+t)};
window.delO=async id=>{if(!confirm("確定刪除訂單 "+id+"？刪除後無法復原"))return;await cmd("刪除 "+id)};
window.setQ=async(id,i,btn)=>{const q=Math.floor(Number(btn.previousElementSibling.value));if(!(q>=0))return;const l=ord(id).lines[i];if(q===l.q)return toast("數量沒有變");if(q===0&&!confirm("數量 0 會把「"+l.n+"」從訂單移除，確定？"))return;await cmd(id+" #"+(i+1)+" 改 "+q)};
window.editO=id=>{const d=document.querySelector('.o[data-id="'+id+'"] details');if(d){d.open=true;d.scrollIntoView({behavior:"smooth",block:"start"})}};
window.addItem=async id=>{const k=prompt("輸入 JAN 碼或商品名稱");if(!k)return;const q=prompt("數量","1");if(!q)return;await cmd(id+" 加 "+k+" "+q)};
function cust(){const L=D.customers;
  $("#m").innerHTML='<input class="f" id="cq" placeholder="搜尋客人">'+'<div id="cl"></div>';
  const draw=q=>{$("#cl").innerHTML=L.filter(c=>!q||c.name.includes(q)).slice(0,200).map(c=>'<div class="cu"><div class="n"><b>'+esc(c.name)+'</b><small>'+c.orders+' 筆訂單｜消費 '+fmt(c.spent)+(c.last?'｜最近 '+esc(c.last.slice(0,10)):'')+(c.until?'｜會員到 '+esc(c.until):'')+'</small></div><select data-u="'+c.uid+'">'+[["none","非會員"],["member","一般會員"],["vip","VIP 會員"]].map(([v,t])=>'<option value="'+v+'"'+(c.tier===v?" selected":"")+'>'+t+'</option>').join("")+'</select></div>').join("")||'<div class="err">還沒有客人</div>';
    document.querySelectorAll("select[data-u]").forEach(s=>s.onchange=async()=>{const r=await api("/admin/api/tier",{uid:s.dataset.u,tier:s.value});toast(r.result||"完成");const c=L.find(x=>x.uid===s.dataset.u);if(c)c.tier=s.value})};
  draw("");$("#cq").oninput=e=>draw(e.target.value.trim())}
function sales(){const P={today:"今天",week:"本週",month:"本月",all:"累計"};const s=D.stats[SP];
  $("#m").innerHTML='<div class="seg">'+Object.entries(P).map(([k,t])=>'<button class="'+(k===SP?"on":"")+'" data-p="'+k+'">'+t+'</button>').join("")+'</div>'+
  '<div class="k" style="margin-top:12px">'+kc("銷售額",fmt(s.rev))+kc("淨利",fmt(s.profit),s.rev?"毛利率 "+Math.round(s.profit/s.rev*100)+"%":"")+kc("已付款訂單",s.n+" 筆")+kc("銷售件數",s.pcs+" 件")+'</div>'+
  (D.members?'<div class="card"><h3>👑 會員方案</h3><div class="row"><span>VIP NT$1,000｜本月 '+D.members.vip.m+' 份</span><b>'+fmt(D.members.vip.mamt)+'</b></div><div class="row"><span>一般 NT$100｜本月 '+D.members.member.m+' 份</span><b>'+fmt(D.members.member.mamt)+'</b></div><div class="row"><span>累計賣出 VIP '+D.members.vip.q+' 份・一般 '+D.members.member.q+' 份</span><b>'+fmt(D.members.vip.amt+D.members.member.amt)+'</b></div><div class="row"><span>目前有效會員</span><b>VIP '+D.members.active.vip+'｜一般 '+D.members.active.member+'</b></div></div>':'')+
  '<div class="card"><h3>本月品項銷量</h3>'+(D.top.map((t,i)=>'<div class="row"><span>'+(i+1)+'. '+esc(t.n)+'</span><b style="white-space:nowrap">×'+t.q+'　'+fmt(t.amt)+'</b></div>').join("")||'<div class="meta">還沒有銷售</div>')+'</div>'+
  '<p class="meta" style="margin-top:10px">淨利＝售價－成本（報價公式），未扣運費、匯款手續費；會員費全額算淨利。只統計已付款／已出貨的線上訂單。</p>';
  document.querySelectorAll("[data-p]").forEach(b=>b.onclick=()=>{SP=b.dataset.p;sales()})}
function set(){const S=D.settings;
  $("#m").innerHTML='<div class="card"><h3>🏦 轉帳資料</h3><textarea class="f" id="bank" rows="4">'+esc(S.bank)+'</textarea><button class="btn dark" style="margin-top:8px" id="sb">儲存</button></div>'+
  '<div class="card"><h3>💚 LINE Pay 資料</h3><textarea class="f" id="lp" rows="3">'+esc(S.linepay)+'</textarea><button class="btn dark" style="margin-top:8px" id="sl">儲存</button></div>'+
  '<div class="card"><h3>📢 公告（客人點「商品動態」會看到）</h3>'+(S.news.map((n,i)=>'<div class="row"><span>'+esc(n.d)+'　'+esc(n.t)+'</span><button class="btn" onclick="delNews('+(i+1)+')">刪</button></div>').join("")||'<div class="meta">目前沒有公告</div>')+
  '<textarea class="f" id="nw" rows="2" placeholder="新增公告內容" style="margin-top:8px"></textarea><button class="btn dark" style="margin-top:8px" id="sn">發布公告</button></div>';
  $("#sb").onclick=()=>cmd("轉帳資料\n"+$("#bank").value);$("#sl").onclick=()=>cmd("LINE Pay資料\n"+$("#lp").value);
  $("#sn").onclick=()=>{const v=$("#nw").value.trim();if(v)cmd("公告 "+v)}}
window.delNews=n=>{if(confirm("刪除這則公告？"))cmd("刪除公告 "+n)};
if(!T)$("#m").innerHTML='<div class="err">請在 LINE 傳「後台」取得專屬連結</div>';else load();
</script></body></html>`;

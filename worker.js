// ZOARÉ LINE 批發客服機器人（Cloudflare Worker）
// 客人在 LINE 傳文字或照片 → 從《ZOARÉ 日本商品目錄》找商品 → Claude 依客服規則回覆
//
// 需要在 Cloudflare 設定的變數（Settings → Variables and Secrets）：
//   LINE_CHANNEL_SECRET        （Secret）LINE Developers 的 Channel secret
//   LINE_CHANNEL_ACCESS_TOKEN  （Secret）LINE Developers 的 Channel access token
//   ANTHROPIC_API_KEY          （Secret）Anthropic Console 的 API Key
//   CATALOG_URL                （Text）  catalog.json 的公開網址
//   MODEL                      （Text，可不填）預設 claude-haiku-5-5
// 可選：綁定一個 KV namespace，名稱叫 SESSIONS（記住對話與「真人客服」狀態）

import { handleAdmin, adminLink } from "./admin.js";
import { handleShop, shopLink, shopOwnerCommand, handlePayment, customerOrders, customerOrderDetail, newsReply, catalogMenu, verifyPaymentImage, productCards, keywordBrowse } from "./shop.js";
const SHOP = "{訂購連結}"; // 已不使用樂賣，回覆時自動換成客人的專屬訂購網址
const VIP = "{會員連結}";
const GENERAL = "{會員連結}";
const DEFAULT_MODEL = "claude-haiku-5-5";
const CATALOG_VERSION = "20261015-0130";
// 真人接手後，客人超過 15 分鐘沒再傳訊息，機器人才重新接手
const HANDOFF_MINUTES = 15;
// 報價後客人 30 分鐘沒動靜，自動傳一句「請問有興趣嗎～」（只傳一次）
const FOLLOWUP_MINUTES = 30;
const BURST_WAIT_MS = 6000; // 連續訊息合併等待時間
const FOLLOWUP_TEXT = "請問有興趣嗎～";

// ---------- 圖文選單：固定回覆（不經過 AI） ----------
const askIp = (flag, name, ex) =>
  `{name} 您好，感謝您詢問 ZOARÉ ${name} ${flag}\n請問您想找哪個 IP 或商品呢？\n（例如：${ex}）\n\n直接告訴我 IP／商品名稱，或傳商品圖片給我也可以喔！`;
const MENU = {
  "韓國批發": askIp("🇰🇷", "韓國批發", "韓國文具、飾品、服飾、生活小物"),
  "日本批發": askIp("🇯🇵", "日本批發", "三麗鷗、吉伊卡哇、史努比、角落生物；娃娃、吊飾、鑰匙圈"),
  "中國批發": askIp("🇨🇳", "中國批發", "IP 周邊、盲盒、生活雜貨、服飾"),
  "訂單查詢": `{name} 您好，請點這裡查詢訂單喔！\n{shop}&v=orders`,
  "商品查詢": `請給我商品名稱或 JAN 碼供系統查詢喔！\n🛒 線上訂購：{shop}`,
};
const ORDER_WORDS = ["訂購", "下單", "我要訂購", "我要下單", "線上訂購", "訂購網站", "訂購連結", "購物車"];
const HUMAN_WORDS = ["真人客服", "真人", "找客服", "轉真人"];

// ---------- 客服規則（給 Claude 的系統指令） ----------
const RULES = `你是 ZOARÉ 的 LINE 批發客服。ZOARÉ 提供韓國、日本、中國商品批發給網拍、擺攤、娃娃機台主等賣家，不提供個人代購。

【資料來源】
- 日本商品的名稱、價格、規格、最低訂購量、狀態、截止、下單網址，只能用「候選商品」裡的資料。不可以猜、不可以上網查、不可以編造。
- 價格直接用候選商品的「一般」和「VIP」價格，不可以自己計算或打折，也不可以透露成本或加價方式。可以說「VIP 每件比一般價便宜 NT$30」。
- 候選商品裡沒有符合的：回答「這個商品目前不在我們的目錄裡，我幫您轉給專人確認喔！」並把 handoff 設為 true。
- 韓國、中國商品沒有目錄，不可以報價：請客人提供商品圖片或連結、型號、數量，告知會由專人報價，handoff 設為 true。

【相同／相似商品】
- 從候選商品挑出相同或最相似的商品，編號列出讓客人選。比對順序：JAN／原廠編號／舊商品編號（例如 272655-S）相同；舊商品編號對到多款時，全部列出讓客人選 → 名稱相同 → 同 IP／角色＋同商品種類（例如同角色不同尺寸）→ 同 IP 不同種類或同種類不同角色。
- 客人傳照片：最多列 3 款；打字查詢：最多列 5 款。只有一款完全符合時直接報那一款。
- 狀態是「缺貨/停售」的不要列成選項，可以在最後備註「○○ 目前缺貨」。
- 狀態是「已截止（不可下單）」的不要報價、不要列成選項，告訴客人「這款已經截止收單囉，下次開團會再通知您！」，有其他同系列還沒截止的可以推薦。
- 沒把握是哪一款時，請客人確認，不要硬報價。
- 每一款格式：
{編號}️⃣ {中文名}（{日文名}）
　款式：{款式}（有才寫）
　價格：NT\${一般}｜VIP：NT\${VIP}
　最低訂購量：{最低訂購量}
　截止：{截止}（有才寫）
　下單：{下單網址}
- 下單那一行一定要原封不動照抄候選商品資料裡的「下單網址」（例如 {訂購連結:4970381929411}），系統會自動換成直接打開該商品的專屬網址；不可以改寫、不可自己編其他網址。
- 列完後說「請回覆編號告訴我您要哪一款，以及需要的數量～」，最後加「※ 日本批發、集單預購」和「💡 VIP 會員每件便宜 NT$30：${VIP}」。
- 客人回覆編號（例如「2號」）時，從「上一次列給客人的商品」找到那一款，報出完整資料並詢問數量。

【批發規則】
- 非會員：單款 21 件起批。
- 會員（NT$100／NT$1,000）：可不同款混批 21 件（每款 3 件起），但需依貿易商最低起批數（目錄的最低訂購量）為準。不可以說「加入會員後全部一件起」。
- 客人問 FuRyu（フリュー）的商品（常見是三麗鷗景品絨毛、公仔）：目錄沒有就不要報價，回「FuRyu 是廠商配貨制喔 我們可以幫您下單 但會依實際配貨數量出貨 沒配到的部分全額退款～ 我請專人跟您確認款式跟數量」，並加 #HANDOFF。目錄有同角色的其他三麗鷗商品，可以順便列出 1～3 款給客人參考。
- 商品資料若有「訂購方式：整箱…不拆箱不混款」，這款不論是否會員都只能單款整箱訂（每款 1 箱起），報價時要講清楚每箱幾個、整箱價（單價×每箱數量），以及截單時間。

【會員】
- 預設只推薦 VIP 會員：NT$1,000／月，國際＋國內運費全免、更優惠的批發價、部分商品 VIP 專屬價、新品優先通知。入會：${VIP}
- 只有客人問 NT$100、問更便宜的方案、或說 VIP 太貴時，才介紹一般會員：NT$100／月，只免國際運費。入會：${GENERAL}

【其他】
- 訂單查詢：請客人點選單的「訂單查詢」，或傳「我的訂單」。
- 付款方式：線上訂購網站結帳時可以選「銀行轉帳」或「LINE Pay」，付款後在 LINE 傳後五碼和付款截圖，系統會自動對帳。
- 運費細節、退換貨、改單、取消訂單、客訴，或任何從上面規則和候選商品裡找不到答案的問題：不要硬回答，直接加上 #HANDOFF（系統會自動跟客人說請專人回覆，你的文字不會送出）。
- 客人一直問同一件事、你只能重複前面講過的話時，也加上 #HANDOFF。
- 會員取消：下個月不繼續繳費就等於取消，不用另外申請。已下的訂單一律以下單當時的金額、數量為準。
- 不能挑款的原因：貿易商那邊也沒辦法挑款，盲盒也不確定會出哪一款，可以老實跟客人說明。

【說話風格（模仿老闆本人）】
- 像老闆本人在 LINE 上聊天：口語、簡短、直接，一則通常一兩句就好，不要長篇大論、不要官腔。
- 不要每則都打招呼。只有對話的第一則可以用「{客人名稱} 您好」，之後直接回答問題。
- 句子常用空格代替逗號，例如「好的👌 您可以比看看價格 合適的話再跟我說」。
- 句尾常用「喔」「囉」「～」；常用表情 👌 😂，偶爾用就好，不要每句都加。
- 回應客人時先順著他的話，例如「好的」「好👌沒事」「原來」，再說明原因或下一步。
- 說明原因要老實、具體，例如「因為我們貿易商那邊也沒辦法挑款給我」。
- 結尾常給客人一個簡單的下一步，例如「如果要加購可以再跟我們說喔」「合適的話再跟我說」。
- 先理解客人真正想問什麼（例如「繼續跟取消都可以再更動嗎」是在問會員可不可以隨時停），能從規則回答的就直接回答，真的不知道才轉專人。
- 不要說「我沒有確定的資料」「不想給您不正確的說明」這種客套話；不知道就加 #HANDOFF。
- 客人用日文問可以用日文回。
- 不要使用 Markdown（不要用 **、#、表格），LINE 不會顯示。

【輸出格式】
直接寫要傳給客人的文字（不要用 JSON、不要用程式碼格式）。
回覆盡量精簡，每款商品只列必要欄位。
最後另起一行加上控制指令（客人看不到）。只要回覆裡有列出商品，就一定要用 #SHOW 附上那幾款的圖片：
#SHOW 要附上商品卡片的候選編號，用逗號分隔，回覆裡列出幾款就寫幾款，最多 10 個（例如：#SHOW 1,2,3；不需要就寫 #SHOW 0）
有 #SHOW 時系統只會傳商品卡片（卡片上已經有圖、名稱、價格、最低訂購量、下單按鈕），所以文字只要一句簡短的話（例如「有的喔 這幾款給您參考👇」），不要再逐款列出名稱、價格、連結。
需要轉真人客服時，再另起一行寫：#HANDOFF`;

// ---------- 中日文對照與簡繁轉換（搜尋用） ----------
const ALIASES = [
  ["酷洛米", "クロミ", "kuromi"], ["美樂蒂", "美乐蒂", "マイメロディ", "マイメロ", "melody"],
  ["凱蒂貓", "凯蒂猫", "kitty", "キティ", "ハローキティ"], ["大耳狗", "喜拿", "シナモロール", "シナモン", "cinnamoroll"],
  ["布丁狗", "ポムポムプリン", "pompompurin"], ["帕恰狗", "ポチャッコ", "pochacco"],
  ["人魚漢頓", "ハンギョドン", "hangyodon"], ["酷企鵝", "ばつ丸", "バッドばつ丸"], ["大眼蛙", "けろっぴ"],
  ["雙星仙子", "キキララ", "kikilala"], ["蛋黃哥", "ぐでたま", "gudetama"], ["三麗鷗", "サンリオ", "sanrio"],
  ["史努比", "スヌーピー", "snoopy"], ["糊塗塌客", "ウッドストック", "woodstock"], ["拉拉熊", "リラックマ", "rilakkuma"],
  ["角落生物", "すみっコぐらし", "すみっこ", "sumikko"], ["吉伊卡哇", "ちいかわ", "chiikawa", "吉伊"],
  ["小八", "ハチワレ", "hachiware"], ["烏薩奇", "乌萨奇", "うさぎ", "兔兔", "usagi"], ["飛鼠", "小桃", "モモンガ"],
  ["塔麻可吉", "たまごっち", "tamagotchi", "電子雞"], ["蠟筆小新", "クレヨンしんちゃん", "小新"],
  ["寶可夢", "ポケモン", "pokemon", "皮卡丘", "ピカチュウ"], ["米飛兔", "ミッフィー", "miffy"],
  ["smiski", "スミスキー"], ["mofusand", "貓福珊迪"], ["小熊維尼", "プー", "pooh"],
  ["娃娃", "玩偶", "絨毛", "ぬいぐるみ", "plush", "s娃", "m娃", "l娃", "蓬鬆", "ほわほわ", "hughug", "fuwakuta", "軟糯", "もちもち"], ["吊飾", "マスコット", "掛飾"],
  ["鑰匙圈", "钥匙圈", "キーホルダー", "キーチェーン"], ["相框", "フォトフレーム"], ["拼圖", "パズル"],
  ["杯", "マグ", "カップ", "タンブラー"], ["便當盒", "ランチボックス", "弁当"], ["包", "バッグ", "ポーチ"],
  ["貼紙", "ステッカー", "シール"], ["盲盒", "扭蛋", "ガチャ", "ブラインド"], ["鏡子", "ミラー"],
  ["毛巾", "タオル"], ["抱枕", "クッション"], ["髮夾", "ヘアクリップ", "クリップ"], ["文件夾", "ファイル"],
  ["電影", "映画"], ["人魚", "人魚の島"],
];
const S2T = { 发: "發", 国: "國", 绒: "絨", 软: "軟", 钥: "鑰", 挂: "掛", 饰: "飾", 头: "頭", 门: "門", 电: "電",
  鱼: "魚", 岛: "島", 秘: "祕", 乐: "樂", 蒂: "蒂", 猫: "貓", 马: "馬", 贴: "貼", 纸: "紙", 镜: "鏡", 包: "包",
  圆: "圓", 盒: "盒", 卡: "卡", 爱: "愛", 夹: "夾", 发夹: "髮夾", 系: "系", 列: "列", 款: "款", 黄: "黃", 蓝: "藍",
  红: "紅", 绿: "綠", 粉: "粉", 白: "白", 黑: "黑", 号: "號", 数: "數", 车: "車", 鸟: "鳥", 龙: "龍", 杂: "雜",
  货: "貨", 拼: "拼", 图: "圖", 灯: "燈", 钟: "鐘", 书: "書", 笔: "筆", 记: "記", 袋: "袋", 帽: "帽", 鞋: "鞋",
  萨: "薩", 乌: "烏", 宝: "寶", 梦: "夢", 冲: "衝", 兔: "兔", 熊: "熊", 狗: "狗" };

function norm(s) {
  s = (s || "").normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of s) out += S2T[ch] || ch;
  return out.replace(/[\s・·、，,。．.()（）\[\]「」『』\/_\-ー〜~!！?？:：|｜+＋&]/g, "");
}

// ---------- 目錄 ----------
let CATALOG = null;
async function loadCatalog(env) {
  if (CATALOG) return CATALOG;
  // 每次更新商品目錄就改 CATALOG_VERSION，讓新價格馬上生效
  const u = env.CATALOG_URL + (env.CATALOG_URL.includes("?") ? "&" : "?") + "v=" + CATALOG_VERSION;
  const res = await fetch(u, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error("catalog " + res.status);
  const items = await res.json();
  for (const it of items) it._t = it.t || norm([it.n, it.ja, it.b, it.s, it.code, it.jan].join(" "));
  CATALOG = items;
  return items;
}

const ALIAS_NORM = ALIASES.map((g) => g.map(norm));

function search(items, query, limit = 8) {
  const q = norm(query);
  if (!q) return [];
  // 編號／JAN／樂賣商品編號（例如 272655-S、K-9416-S）完全符合 → 直接回傳
  const words = (query.match(/[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*/g) || []).filter((d) => d.length >= 4).map((d) => d.toLowerCase());
  const lmHits = words.length ? items.filter((it) => it.lm && words.includes(it.lm.toLowerCase())) : [];
  if (lmHits.length) return lmHits.slice(0, Math.max(limit, 12));
  const digits = words.filter((d) => /\d{3,}/.test(d));
  if (digits.length) {
    const keys = new Set(digits.flatMap((d) => [d, d.replace(/-s$/, "")]));
    const exact = items.filter((it) => keys.has((it.jan || "").toLowerCase()) || keys.has((it.code || "").toLowerCase()));
    if (exact.length) return exact.slice(0, limit);
  }
  // 命中的中日文詞組
  let rest = q;
  const groups = [];
  for (const g of ALIAS_NORM) {
    const hit = g.find((w) => w && q.includes(w));
    if (hit) { groups.push(g); rest = rest.split(hit).join(" "); }
  }
  const grams = [];
  for (const part of rest.split(" ")) {
    if (part.length === 1) grams.push(part);
    for (let i = 0; i + 1 < part.length; i++) grams.push(part.slice(i, i + 2));
  }
  const scored = [];
  for (const it of items) {
    let sc = 0, groupHits = 0;
    for (const g of groups) if (g.some((w) => it._t.includes(w))) { sc += 10; groupHits++; }
    if (groups.length && !groupHits) continue;
    for (const gr of grams) if (it._t.includes(gr)) sc += gr.length === 1 ? 0.5 : 2;
    if (sc > 0) scored.push([sc - ((it.st && it.st.includes("缺貨")) || isExpired(it) ? 3 : 0), it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const best = scored.length ? scored[0][0] : 0;
  return scored.filter((x) => x[0] >= best * 0.45).slice(0, limit).map((x) => x[1]);
}


// 截止判斷：dl 格式「2026-10-12 23:59（…）」，以台灣時間計算
function isExpired(it) {
  const m = (it.dl || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return false;
  const end = Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59) - 8 * 3600 * 1000;
  return Date.now() > end;
}
function itemLine(i, it) {
  const f = [`[${i}] ${it.n}`, `日文：${it.ja || ""}`, `品牌：${it.b || ""}`];
  if (it.s) f.push(`款式：${it.s}`);
  f.push(`價格：一般 NT$${it.g}｜VIP NT$${it.v}`);
  if (it.spec) f.push(`規格：${it.spec}`);
  if (it.moq) f.push(`最低訂購量：${it.moq}`);
  if (it.pack && it.pack.includes("整箱")) f.push(`訂購方式：${it.pack}`);
  if (isExpired(it)) f.push(`狀態：已截止（不可下單）`);
  else if (it.st) f.push(`狀態：${it.st}`);
  if (it.ship) f.push(`發售出貨：${it.ship}`);
  if (it.dl) f.push(`截止：${it.dl}`);
  if (it.code) f.push(`編號：${it.code}`);
  if (it.lm) f.push(`舊商品編號：${it.lm}`);
  if (it.jan && it.jan !== it.code) f.push(`JAN：${it.jan}`);
  f.push(`下單網址：{訂購連結:${it.jan || it.code || it.n.slice(0, 30)}}`);
  return f.join("｜");
}

// ---------- LINE ----------
async function verifySignature(secret, body, signature) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}
async function lineApi(env, path, payload, host = "api.line.me") {
  return fetch(`https://${host}${path}`, {
    method: payload ? "POST" : "GET",
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}
async function reply(env, token, messages) {
  let r = await lineApi(env, "/v2/bot/message/reply", { replyToken: token, messages: messages.slice(0, 5) });
  if (!r.ok) {
    const err = await r.text();
    console.log("reply failed", r.status, err);
    if (env.SESSIONS) await env.SESSIONS.put("lasterr", new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16) + " " + r.status + " " + err.slice(0, 600), { expirationTtl: 30 * 86400 });
    // 卡片格式有問題時，改用純文字再送一次，至少讓客人收到回覆
    const plain = messages.filter((m) => m.type === "text");
    if (plain.length === messages.length || !plain.length) return;
    r = await lineApi(env, "/v2/bot/message/reply", { replyToken: token, messages: plain.slice(0, 5) });
    if (!r.ok) return;
  }
  // 記住機器人自己傳出的訊息 ID，用來分辨客人引用的是機器人還是老闆的訊息
  try {
    const j = await r.json();
    if (env.SESSIONS) for (const m of j.sentMessages || []) await env.SESSIONS.put("b:" + m.id, "1", { expirationTtl: 7 * 86400 });
  } catch (e) {}
}
async function displayName(env, userId) {
  try {
    const r = await lineApi(env, `/v2/bot/profile/${userId}`);
    if (r.ok) return (await r.json()).displayName || "老闆";
  } catch (e) {}
  return "老闆";
}
async function imageBase64(env, messageId) {
  const r = await lineApi(env, `/v2/bot/message/${messageId}/content`, null, "api-data.line.me");
  if (!r.ok) throw new Error("image " + r.status);
  const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { type, data: btoa(bin) };
}

// ---------- Claude ----------
async function claude(env, system, messages, maxTokens = 2500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.MODEL || DEFAULT_MODEL, max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()));
  const data = await r.json();
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}
function parseJson(text) {
  // 新格式：純文字 + 最後的 #SHOW / #HANDOFF 控制行
  let t = (text || "").trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  // 舊格式相容：如果模型還是回了 JSON，就把 reply 欄位取出來
  if (t.startsWith("{")) {
    try { const j = JSON.parse(t.match(/\{[\s\S]*\}/)[0]); return { reply: j.reply || "", show: j.show || [], handoff: !!j.handoff }; } catch (e) {}
    const m = t.match(/"reply"\s*:\s*"([\s\S]*)/);
    if (m) t = m[1].replace(/"\s*,\s*"show"[\s\S]*$/, "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  let show = [], handoff = false;
  const lines = t.split("\n").filter((ln) => {
    const x = ln.trim();
    if (/^#SHOW/i.test(x)) { show = (x.match(/\d+/g) || []).map(Number).filter((n) => n > 0); return false; }
    if (/^#HANDOFF/i.test(x)) { handoff = true; return false; }
    return true;
  });
  return { reply: lines.join("\n").trim(), show, handoff };
}

// 照片 → 搜尋關鍵字
async function describePhoto(env, img) {
  const out = await claude(env,
    "你是商品辨識助手。看照片判斷商品，只輸出 JSON：{\"query\":\"角色或IP的中文名 日文名 商品種類（例：酷洛米 クロミ 娃娃 ぬいぐるみ）以及照片上看得到的商品名稱\",\"jan\":\"照片上看得到的 JAN 條碼或型號，沒有就空字串\",\"is_product\":true}",
    [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text: "這是什麼商品？" }] }],
    300);
  try { return JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch (e) { return { query: out.slice(0, 80), jan: "" }; }
}

// ---------- 對話記憶（有綁 KV 才會啟用） ----------
async function getSession(env, uid) {
  if (!env.SESSIONS) return { history: [], last: [] };
  return (await env.SESSIONS.get("s:" + uid, "json")) || { history: [], last: [] };
}
async function saveSession(env, uid, s) {
  if (!env.SESSIONS) return;
  s.history = s.history.slice(-8);
  await env.SESSIONS.put("s:" + uid, JSON.stringify(s), { expirationTtl: 86400 });
}
async function inHandoff(env, uid) { return env.SESSIONS ? !!(await env.SESSIONS.get("h:" + uid)) : false; }
async function setHandoff(env, uid) {
  if (env.SESSIONS) await env.SESSIONS.put("h:" + uid, "1", { expirationTtl: HANDOFF_MINUTES * 60 });
}


// 判斷兩段回覆是不是差不多（用來抓「一直回同樣的話」）
function similar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const grams = (t) => { const g = new Set(); for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2)); return g; };
  const A = grams(x), B = grams(y); let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.max(1, Math.min(A.size, B.size)) > 0.75;
}

// 轉真人時傳 LINE 通知給老闆
async function notifyOwner(env, uid, lastText) {
  try {
    if (!env.SESSIONS) return;
    const owner = await env.SESSIONS.get("owner");
    if (!owner || owner === uid) return;
    const name = await displayName(env, uid);
    await lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text",
      text: `🔔 有客人要轉真人\n客人：${name}\n最後訊息：${(lastText || "").slice(0, 200)}\n\n機器人已暫停回覆這位客人，客人 15 分鐘沒訊息後才會恢復。` }] });
  } catch (e) { console.log("notify failed", e); }
}

// 記住客人的 LINE 名稱 → userId，讓老闆可以用名字下指令
async function rememberName(env, uid) {
  const name = await displayName(env, uid);
  if (env.SESSIONS && name && name !== "老闆") {
    const key = "n:" + name;
    if ((await env.SESSIONS.get(key)) !== uid) await env.SESSIONS.put(key, uid);
  }
  return name;
}
// 圖文選單：用 API 建立並設為預設（優先於 LINE 官方帳號後台設定的選單）
const RICHMENU_IMG = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/richmenu_v2.jpg";
const RICHMENU_OWNER_IMG = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/richmenu_owner.jpg";
async function createMenu(env, imgUrl, name, actions) {
  const W = 2500, H = 1686, cw = [0, 833, 1667, 2500], top = 938;
  const areas = actions.map((a, i) => ({ bounds: { x: cw[i % 3], y: i < 3 ? 0 : top, width: cw[i % 3 + 1] - cw[i % 3], height: i < 3 ? top : H - top }, action: a }));
  const cr = await lineApi(env, "/v2/bot/richmenu", { size: { width: W, height: H }, selected: true, name, chatBarText: "選單", areas });
  if (!cr.ok) throw new Error("建立選單失敗：" + (await cr.text()).slice(0, 200));
  const { richMenuId } = await cr.json();
  const img = await fetch(imgUrl + "?v=" + Date.now());
  if (!img.ok) throw new Error("讀不到選單圖片：" + img.status);
  const up = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, { method: "POST",
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "image/jpeg" }, body: await img.arrayBuffer() });
  if (!up.ok) throw new Error("上傳選單圖片失敗：" + (await up.text()).slice(0, 200));
  return richMenuId;
}
async function setupRichMenu(env) {
  const msg = (t) => ({ type: "message", label: t, text: t });
  const base = ["韓國批發", "日本批發", "中國批發", "商品目錄", "商品動態"].map(msg);
  const auth = { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  try {
    const id = await createMenu(env, RICHMENU_IMG, "ZOARE v2", [...base, msg("訂單查詢")]);
    const df = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${id}`, { method: "POST", headers: auth });
    if (!df.ok) return "設定預設選單失敗：" + (await df.text()).slice(0, 200);
    const keep = [id];
    // 老闆專用選單：右下角換成「商家後台」，直接打開後台
    const owner = await env.SESSIONS.get("owner");
    let ownerNote = "";
    if (owner) {
      const oid = await createMenu(env, RICHMENU_OWNER_IMG, "ZOARE owner", [...base, { type: "uri", label: "商家後台", uri: await adminLink(env, owner) }]);
      const lk = await fetch(`https://api.line.me/v2/bot/user/${owner}/richmenu/${oid}`, { method: "POST", headers: auth });
      if (lk.ok) { keep.push(oid); ownerNote = "\n你的選單右下角是「商家後台」（只有你看得到），點了直接打開後台👌"; }
    }
    try {
      const list = await (await lineApi(env, "/v2/bot/richmenu/list")).json();
      for (const m of list.richmenus || []) if (!keep.includes(m.richMenuId) && /^ZOARE/.test(m.name))
        await fetch(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: "DELETE", headers: auth });
    } catch (e) {}
    return "好👌 圖文選單已經更新囉（客人看到：韓國／日本／中國批發、商品目錄、商品動態、訂單查詢）" + ownerNote + "\n關掉聊天室再打開就會看到";
  } catch (e) { return String(e.message || e); }
}
async function findUid(env, who) {
  const target = who.replace(/[「」"']/g, "").trim();
  let uid = await env.SESSIONS.get("n:" + target);
  if (uid) return { uid, name: target };
  const keys = (await env.SESSIONS.list({ prefix: "n:" })).keys.map((k) => k.name.slice(2));
  const hits = keys.filter((k) => k.includes(target) || target.includes(k));
  if (hits.length === 1) return { uid: await env.SESSIONS.get("n:" + hits[0]), name: hits[0] };
  if (hits.length > 1) return { error: `有好幾位名字很像：${hits.join("、")}\n請打完整的名字喔` };
  return { error: `找不到「${target}」這位客人😂 要對方先傳過訊息給官方帳號，我才認得喔` };
}
async function ownerCommand(env, text) {
  const t = text.replace(/\s+/g, " ").trim();
  if (/^(暫停名單|停止名單|名單)$/.test(t)) {
    const list = (await env.SESSIONS.list({ prefix: "h:" })).keys.map((k) => k.name.slice(2));
    if (!list.length) return "目前沒有停止回覆的客人👌";
    const byUid = {};
    for (const k of (await env.SESSIONS.list({ prefix: "n:" })).keys) byUid[await env.SESSIONS.get(k.name)] = k.name.slice(2);
    const names = list.map((u) => byUid[u] || "（未知名稱）");
    return "目前停止回覆的客人：\n" + names.map((n) => "・" + n).join("\n");
  }
  if (/^#?更新選單$/.test(text.trim())) return await setupRichMenu(env);
  if (/^#?(錯誤|錯誤紀錄)$/.test(text.trim())) return (await env.SESSIONS.get("lasterr")) || "最近沒有傳送失敗的紀錄👌";
  if (/^#?(後台|商家後台|管理後台)$/.test(text.trim())) return `🔐 ZOARÉ 商家後台（只有你的帳號能用，請不要轉傳）：\n${await adminLink(env, (await env.SESSIONS.get("owner")))}\n\n💡 傳「#更新選單」後，你的圖文選單右下角會變成「商家後台」按鈕，之後點一下就能開`;
  const shopR = await shopOwnerCommand(env, text.trim(), { lineApi, loadCatalog, isExpired, claude });
  if (shopR) return shopR;
  // 會員等級：「小美 VIP」「小美 會員」「小美 非會員」
  const tm = t.match(/^(.+?)\s*(VIP|vip|VIP會員|會員|一般會員|非會員|一般)$/);
  if (tm) {
    const r = await findUid(env, tm[1]);
    if (r.error) return r.error;
    const tier = /vip/i.test(tm[2]) ? "vip" : /^(會員|一般會員)$/.test(tm[2]) ? "member" : "none";
    if (tier === "none") await env.SESSIONS.delete("tier:" + r.uid); else await env.SESSIONS.put("tier:" + r.uid, tier);
    return `好👌 「${r.name}」設定為${{ vip: "VIP 會員", member: "一般會員（NT$100）", none: "非會員" }[tier]}，訂購網站會自動套用對應價格與規則`;
  }
  const m = t.match(/^(.+?)\s*(停止回覆|開始回覆)$/) || t.match(/^(停止回覆|開始回覆)\s*(.+)$/);
  if (!m) return null;
  const [action, who] = m[2] === "停止回覆" || m[2] === "開始回覆" ? [m[2], m[1]] : [m[1], m[2]];
  const fr = await findUid(env, who);
  if (fr.error) return fr.error;
  const uid = fr.uid, target = fr.name;
  if (action === "停止回覆") { await setHandoff(env, uid); return `好👌 已停止回覆「${target}」，對方 15 分鐘沒傳訊息後我會自動恢復`; }
  await env.SESSIONS.delete("h:" + uid);
  return `好👌 「${target}」我開始回覆囉`;
}
// ---------- 主流程 ----------
async function handleEvent(env, ev) {
  if (ev.type !== "message" || !ev.replyToken) return;
  const uid = ev.source && ev.source.userId;
  const msg = ev.message;
  const text = msg.type === "text" ? msg.text.trim() : "";
  // 客人有再傳訊息 → 取消之前排好的「請問有興趣嗎」
  if (uid && env.SESSIONS) await env.SESSIONS.delete("f:" + uid);

  // 老闆綁定通知：第一個傳「#我是老闆」的帳號會被記成老闆（只能綁一次）
  if (text === "#我是老闆" && uid && env.SESSIONS) {
    const owner = await env.SESSIONS.get("owner");
    if (!owner || owner === uid) {
      await env.SESSIONS.put("owner", uid);
      return reply(env, ev.replyToken, [{ type: "text", text: "綁定完成👌 之後有客人要轉真人，我會傳通知到這裡給你" }]);
    }
  }
  // 老闆指令：「小美 停止回覆」（客人 15 分鐘沒訊息自動恢復）、「小美 開始回覆」（馬上恢復）、「名單」
  if (uid && env.SESSIONS && text && uid === (await env.SESSIONS.get("owner"))) {
    const r = await ownerCommand(env, text);
    if (r) return reply(env, ev.replyToken, (Array.isArray(r) ? r : [r]).map((x) => ({ type: "text", text: x })));
  }
  // 匯款後五碼回報
  if (uid && env.SESSIONS && text) {
    const pr = await handlePayment(env, { lineApi }, uid, text);
    if (pr) return reply(env, ev.replyToken, [{ type: "text", text: pr }]);
  }
  // 查自己的訂單：「訂單查詢」「我的訂單」或直接傳訂單編號
  if (uid && env.SESSIONS && /^(訂單查詢|我的訂單|查訂單|訂單)$/.test(text)) {
    return reply(env, ev.replyToken, [{ type: "text", text: await customerOrders(env, uid, await shopLink(env, uid)) }]);
  }
  if (uid && env.SESSIONS && /^ZO\w{10}$/i.test(text)) {
    const d = await customerOrderDetail(env, uid, text.toUpperCase());
    if (d) return reply(env, ev.replyToken, [{ type: "text", text: d }]);
  }
  // 商品目錄：選系列 → 選角色 → 傳商品圖片卡
  if (uid && text) {
    const cm = await catalogMenu(env, { loadCatalog, isExpired }, uid, text);
    if (cm) return reply(env, ev.replyToken, cm);
    // 只打品牌／角色名稱 → 直接傳全部商品卡片
    const kb = await keywordBrowse(env, { loadCatalog, isExpired }, uid, text);
    if (kb) return reply(env, ev.replyToken, kb);
  }
  // 商品動態
  if (uid && /^(商品動態|最新動態|動態|新品)$/.test(text)) {
    return reply(env, ev.replyToken, [{ type: "text", text: await newsReply(env, { loadCatalog, isExpired }, await shopLink(env, uid)) }]);
  }
  // 加入會員
  if (uid && /^(加入會員|會員|入會|VIP|加入VIP|會員方案)$/i.test(text)) {
    return reply(env, ev.replyToken, [{ type: "text", text: `ZOARÉ 批發會員方案👇\n\n👑 VIP 會員 NT$1,000／月\n國際＋國內運費全免・更優惠的批發價・VIP 專屬價・新品優先通知\n\n🔹 一般會員 NT$100／月（只免國際運費）\n\n會員可以不同款混批 21 件（每款 3 件起）\n點這裡加入，付款完成會自動開通：\n${await shopLink(env, uid)}&q=${encodeURIComponent("會員方案")}` }]);
  }
  // 要訂購連結
  if (uid && ORDER_WORDS.includes(text)) {
    await rememberName(env, uid);
    return reply(env, ev.replyToken, [{ type: "text", text: `這是您的專屬訂購網站🛒\n${await shopLink(env, uid)}\n\n可以直接挑商品、填數量、送出訂單 價格會自動套用您的會員等級喔～\n（這個連結是您專用的 請不要轉傳給別人）` }]);
  }
  if (HUMAN_WORDS.some((w) => text === w || text.includes("真人客服"))) {
    await notifyOwner(env, uid, text);
    await setHandoff(env, uid);
    return reply(env, ev.replyToken, [{ type: "text", text: "好的 我請專人來回覆您喔 請稍等一下～" }]);
  }
  // 客人「回覆／引用」了一則不是機器人傳的訊息 → 代表老闆正在親自回 → 機器人暫停
  if (uid && env.SESSIONS && msg.quotedMessageId && !(await env.SESSIONS.get("b:" + msg.quotedMessageId))) {
    await setHandoff(env, uid); return;
  }
  // 真人處理中：機器人不插話，並把 15 分鐘重新計時
  if (uid && (await inHandoff(env, uid))) { await setHandoff(env, uid); return; }
  // 有待付款訂單的客人傳圖片 → 先看是不是付款截圖，是的話自動對帳
  if (uid && env.SESSIONS && msg.type === "image") {
    try {
      const img = await imageBase64(env, msg.id);
      const pr = await verifyPaymentImage(env, { claude, lineApi }, uid, img);
      if (pr) return reply(env, ev.replyToken, [{ type: "text", text: pr }]);
    } catch (e) { console.log("payment check failed", e); }
  }
  // 貼圖、語音等不是文字／照片的訊息：不回（避免客人傳「收到」貼圖也被回）
  if (msg.type !== "text" && msg.type !== "image") return;

  // 客人連續傳好幾則（例如一次傳很多照片＋一句話）→ 等幾秒，只由「最後一則」統一回一次
  let burst = [];
  if (uid && env.SESSIONS && !MENU[text]) {
    await env.SESSIONS.put(`pm:${uid}:${Date.now()}-${msg.id}`, JSON.stringify({ id: msg.id, type: msg.type, text }), { expirationTtl: 120 });
    await env.SESSIONS.put("last:" + uid, msg.id, { expirationTtl: 120 });
    await new Promise((r) => setTimeout(r, BURST_WAIT_MS));
    if ((await env.SESSIONS.get("last:" + uid)) !== msg.id) return; // 後面還有新訊息，交給最後一則回
    const keys = (await env.SESSIONS.list({ prefix: `pm:${uid}:` })).keys;
    for (const k of keys) {
      const v = await env.SESSIONS.get(k.name);
      if (v) burst.push(JSON.parse(v));
      await env.SESSIONS.delete(k.name);
    }
    burst = burst.filter((b) => b.id !== msg.id);
    if (await inHandoff(env, uid)) return; // 等待期間已轉真人 → 不插話
  }

  const name = uid ? await rememberName(env, uid) : "老闆";
  if (MENU[text]) return reply(env, ev.replyToken, [{ type: "text", text: MENU[text].replaceAll("{name}", name).replaceAll("{shop}", uid ? await shopLink(env, uid) : "") }]);

  if (uid) lineApi(env, "/v2/bot/chat/loading/start", { chatId: uid, loadingSeconds: 20 }).catch(() => {});

  try {
    const items = await loadCatalog(env);
    const session = await getSession(env, uid);
    let userContent, query = text, img = null;
    // 同一波連續訊息：把前面的文字一起考慮；照片只取最後一張辨識
    const earlierText = burst.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
    const earlierImgs = burst.filter((b) => b.type === "image");
    if (msg.type === "text" && !text.match(/^\s*(第\s*)?[1-5一二三四五]\s*(號|个|個|款)?\s*$/) && earlierImgs.length) {
      img = await imageBase64(env, earlierImgs[earlierImgs.length - 1].id);
      const d = await describePhoto(env, img);
      query = [d.jan, d.query, text].filter(Boolean).join(" ");
    }

    if (msg.type === "image") {
      img = await imageBase64(env, msg.id);
      const d = await describePhoto(env, img);
      query = [d.jan, d.query].filter(Boolean).join(" ");
    }
    // 回覆編號（例如「2號」）時沿用上次列出的商品
    const pickedNumber = /^\s*(第\s*)?[1-5一二三四五]\s*(號|个|個|款)?\s*$|[1-5]\s*號/.test(text);
    let cands = pickedNumber && session.last.length ? session.last.map((j) => items[j]).filter(Boolean) : search(items, query);
    if (!cands.length && session.last.length) cands = session.last.map((j) => items[j]).filter(Boolean);

    const candText = cands.length ? cands.map((it, i) => itemLine(i + 1, it)).join("\n") : "（目錄裡沒有找到相關商品）";
    const lastText = session.last.length
      ? session.last.map((j, i) => (items[j] ? `${i + 1}. ${items[j].n}` : "")).join("\n") : "（無）";
    const burstNote = burst.length ? `（客人剛剛連續傳了 ${burst.length + 1} 則訊息${earlierImgs.length ? `，其中 ${earlierImgs.length + (msg.type === "image" ? 1 : 0)} 張照片` : ""}${earlierText ? "，前面的文字：" + earlierText : ""}；請合併成一則回覆）\n` : "";
    const prompt = `客人名稱：${name}${session.history.length ? "（對話進行中，不要再打招呼）" : "（這是對話第一則，可以打招呼）"}\n${burstNote}客人${img ? (text ? "傳了照片並說：" + text + "（照片辨識結果：" + query + "）" : "傳了一張照片（照片辨識結果：" + query + "）") : "說：" + text}\n\n候選商品（依相關度排序）：\n${candText}\n\n上一次列給客人的商品：\n${lastText}`;
    userContent = img
      ? [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text: prompt }]
      : prompt;

    const messages = [...session.history, { role: "user", content: userContent }];
    const out = parseJson(await claude(env, RULES.replaceAll("{客人名稱}", name), messages));

    // 回答不出來、或跟前兩次回覆差不多（一直鬼打牆）→ 轉真人，機器人先不回
    const prevBot = session.history.filter((h) => h.role === "assistant").slice(-2).map((h) => h.content);
    if (!pickedNumber && prevBot.some((t) => similar(t, out.reply))) out.handoff = true;
    if (uid && (await inHandoff(env, uid))) return; // 回覆前再確認一次：已轉真人就不插話
    if (out.handoff) {
      await reply(env, ev.replyToken, [{ type: "text", text: "這個我請專人來回覆您喔 請稍等一下～" }]);
      session.history.push({ role: "user", content: (earlierText ? earlierText + "\n" : "") + (img ? "（傳了照片：" + query + "）" + (msg.type === "text" ? text : "") : text) });
      session.history.push({ role: "assistant", content: "（已轉給專人）" });
      await saveSession(env, uid, session);
      await setHandoff(env, uid);
      await notifyOwner(env, uid, img ? "（傳了一張照片）" : text);
      return;
    }
    const shown = (out.show || []).map((n) => cands[n - 1]).filter((it) => it && it.img).slice(0, 10);
    const lineMsgs = [];
    const cardMsg = uid && shown.length ? await productCards(env, uid, shown, `商品報價（${shown.length} 款）`) : null;
    if (cardMsg) lineMsgs.push(cardMsg);
    else for (const it of shown.slice(0, 3)) lineMsgs.push({ type: "image", originalContentUrl: it.img, previewImageUrl: it.img });
    const myLink = uid ? await shopLink(env, uid) : "";
    let replyText = (out.reply || "我幫您轉給專人確認喔！").replace(/(樂賣商城\s*)?\{訂購連結[:：]([^}]+)\}/g, (_, __, k) => `${myLink}&q=${encodeURIComponent(k.trim())}`).replaceAll("樂賣商城 {訂購連結}", myLink).replaceAll("{訂購連結}", myLink).replaceAll("{會員連結}", myLink + "&q=" + encodeURIComponent("會員方案"));
    if (/NT\$\s*\d/.test(replyText) && !replyText.includes(myLink)) replyText += `\n\n🛒 線上訂購：${myLink}`;
    // 有商品卡片時只傳卡片，不附文字；沒有卡片才傳文字報價
    if (!cardMsg) lineMsgs.push({ type: "text", text: replyText.slice(0, 4900) });
    await reply(env, ev.replyToken, lineMsgs);
    // 這則有報價（有附商品或出現價格）且客人不是說已經下單 → 30 分鐘後追蹤
    const quoted = shown.length > 0 || /NT\$\s*\d/.test(out.reply || "");
    const ordered = /下單了|已下單|訂好了|已訂|買了|付款了|匯款了/.test(text);
    if (uid && env.SESSIONS && quoted && !ordered)
      await env.SESSIONS.put("f:" + uid, String(Date.now() + FOLLOWUP_MINUTES * 60000), { expirationTtl: 86400 });

    session.history.push({ role: "user", content: (earlierText ? earlierText + "\n" : "") + (img ? "（傳了照片：" + query + "）" + (msg.type === "text" ? text : "") : text) });
    session.history.push({ role: "assistant", content: out.reply || "" });
    if (!pickedNumber && cands.length) session.last = cands.map((it) => items.indexOf(it));
    await saveSession(env, uid, session);
  } catch (e) {
    console.log("error", e && e.stack || e);
    await reply(env, ev.replyToken, [{ type: "text", text: "系統忙碌中，我先幫您轉給專人，請稍候～" }]);
  }
}


// 每 5 分鐘檢查一次要追蹤的客人
async function runFollowups(env) {
  if (!env.SESSIONS) return;
  const hourTW = (new Date().getUTCHours() + 8) % 24;
  if (hourTW < 9 || hourTW >= 22) return; // 晚上 10 點到早上 9 點不打擾，早上 9 點後再補傳
  const keys = (await env.SESSIONS.list({ prefix: "f:" })).keys;
  for (const k of keys) {
    const uid = k.name.slice(2);
    const due = Number(await env.SESSIONS.get(k.name));
    if (!due || Date.now() < due) continue;
    await env.SESSIONS.delete(k.name);
    if (await env.SESSIONS.get("h:" + uid)) continue; // 真人處理中就不傳
    const r = await lineApi(env, "/v2/bot/message/push", { to: uid, messages: [{ type: "text", text: FOLLOWUP_TEXT }] });
    if (!r.ok) console.log("followup failed", r.status, await r.text());
  }
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFollowups(env));
  },
  async fetch(request, env, ctx) {
    // 去掉金鑰前後不小心多貼的空白或換行
    for (const k of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "ANTHROPIC_API_KEY", "CATALOG_URL", "MODEL"])
      if (typeof env[k] === "string") env[k] = env[k].trim();
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/check") {
      // 只回報設定「有沒有填、長度對不對」，不會顯示金鑰內容
      const s = env.LINE_CHANNEL_SECRET || "", t = env.LINE_CHANNEL_ACCESS_TOKEN || "", a = env.ANTHROPIC_API_KEY || "";
      return Response.json({
        LINE_CHANNEL_SECRET: s ? { length: s.length, looks_ok: /^[0-9a-f]{32}$/i.test(s) } : "missing",
        LINE_CHANNEL_ACCESS_TOKEN: t ? { length: t.length, looks_ok: t.length > 100 } : "missing",
        ANTHROPIC_API_KEY: a ? { length: a.length, looks_ok: a.startsWith("sk-ant-") } : "missing",
        CATALOG_URL: env.CATALOG_URL ? "set" : "missing",
        SESSIONS_KV: env.SESSIONS ? "bound" : "not bound",
      });
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx, { lineApi, loadCatalog, isExpired, claude });
    if (url.pathname === "/shop" || url.pathname.startsWith("/shop/")) return handleShop(request, env, ctx, { loadCatalog, isExpired, displayName, lineApi });
    if (request.method !== "POST") return new Response("ZOARÉ LINE bot is running.");
    const body = await request.text();
    const ok = await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get("x-line-signature") || "");
    if (!ok) { console.log("bad signature: check LINE_CHANNEL_SECRET"); return new Response("bad signature", { status: 401 }); }
    const events = (JSON.parse(body).events) || [];
    ctx.waitUntil(Promise.all(events.map((ev) => handleEvent(env, ev).catch((e) => console.log("event error", e)))));
    return new Response("ok");
  },
};

// 測試用
export { runFollowups, isExpired, search, norm, itemLine, RULES, MENU, verifySignature, handleEvent };

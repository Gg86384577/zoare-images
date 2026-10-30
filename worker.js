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
import { getPools, mfrOf, mfrLink, runPoolReminders, introVideoMsg, earlyShipReply, customerShipReply, computePools, runCartReminders, couponText, linkAlts, newPicks, hotPicks, handleShop, shopLink, shopOwnerCommand, handlePayment, customerOrders, customerOrderDetail, newsReply, catalogMenu, verifyPaymentImage, productCards, keywordBrowse, membershipCards, welcomeMessages, memExpiry, catsOf, allOrders, CAT_NAMES, setMembership, memberInfo, parsePeriod, fmtDay, shipLabel, dlLabel } from "./shop.js";
const SHOP = "{訂購連結}"; // 已不使用樂賣，回覆時自動換成客人的專屬訂購網址
const VIP = "{會員連結}";
const GENERAL = "{會員連結}";
const DEFAULT_MODEL = "claude-haiku-5-5";
const PHOTO_MODEL = "claude-sonnet-5-5"; // 照片辨識（要讀目錄上的小字品番）用比較強的模型
const CATALOG_VERSION = "20261030-0938";
const CATALOG_SHA = "6ec5098637bd0c3e4478ae00354458074d517ef3"; // 每次 commit catalog.json 後填入那次 commit 的 SHA，商品才會立刻生效
// 真人接手後，客人超過 15 分鐘沒再傳訊息，機器人才重新接手
const HANDOFF_MINUTES = 15;
// 報價後客人 30 分鐘沒動靜，自動傳一句「請問有興趣嗎～」（只傳一次）
const FOLLOWUP_MINUTES = 30;
const BURST_WAIT_MS = 6000;
const MAX_PHOTOS = 6; // 一次最多辨識幾張照片
const MAX_CARDS = 36; // 照片對到的商品最多列幾款（12 款一組，最多 3 組） // 連續訊息合併等待時間
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
- 客人常常誤點圖文選單（例如點了「韓國批發」卻傳日本商品）。一律以客人「最後一次」點的選單為準，而且以客人實際傳的商品為主：只要候選商品裡找得到相同或相似的商品，就直接報價、列出商品，不要因為選單是韓國／中國批發就轉真人；選單和商品不一致時，可以順口說「這款是日本商品喔」。

【相同／相似商品】
- 從候選商品挑出相同或最相似的商品，編號列出讓客人選。推薦卡片一律以角色為主：客人問的或照片上的是哪個角色，就只列那個角色的商品，不要混其他角色。比對順序：JAN／原廠編號／舊商品編號（例如 272655-S）相同；舊商品編號對到多款時，全部列出讓客人選 → 名稱相同 → 同角色＋同商品特徵（種類、造型、服裝配件、顏色、尺寸，例如同一款不同尺寸）→ 同角色＋同種類的類似款（要說明是類似款）。不同角色的商品不要推薦。
- 客人傳照片：最多列 3 款；打字查詢：最多列 5 款。只有一款完全符合時直接報那一款。
- 客人傳照片但目錄裡找不到時：說明「圖片詢價只能查 ZOARÉ 在官方 LINE、社群發佈過的商品，這款目前沒有在我們的商品裡」，可以推薦 1～3 款相似商品，並請客人提供商品名稱或 JAN；不要報價。
- 狀態是「缺貨/停售」的不要列成選項，可以在最後備註「○○ 目前缺貨」。
- 狀態是「已截止（不可下單）」的不要報價、不要列成選項，告訴客人「這款已經截止收單囉，下次開團會再通知您！」，有其他同系列還沒截止的可以推薦。
- 沒把握是哪一款時，請客人確認，不要硬報價。
- 每一款格式：
{編號}️⃣ {中文名}（{日文名}）
　款式：{款式}（有才寫）
　價格：NT\${一般}｜VIP：NT\${VIP}
　起批：{起批}
　截止：{截止}（有才寫）
　下單：{下單網址}
- 下單那一行一定要原封不動照抄候選商品資料裡的「下單網址」（例如 {訂購連結:4970381929411}），系統會自動換成直接打開該商品的專屬網址；不可以改寫、不可自己編其他網址。
- 列完後說「請回覆編號告訴我您要哪一款，以及需要的數量～」，最後加「※ 日本批發、集單預購」和「💡 VIP 會員每件便宜 NT$30：${VIP}」。
- 客人回覆編號（例如「2號」）時，從「上一次列給客人的商品」找到那一款，報出完整資料並詢問數量。

【批發規則】
- 每款商品的起批數在候選商品資料的「起批」欄位，報價時一定要照那個數字講，不要每款都說 21 件。
- 會員（VIP NT$1,000、一般會員 NT$100）：每款照商品本身的起批數（型錄沒寫的 3 件起）。一般會員整張訂單不同款混批合計 21 件起；VIP 沒有總件數限制，可以真正少量叫貨。
- 非會員：單款要買到商品起批數的倍數、至少 21 件（起批 3→21 件、2→22 件、5→25 件、6→24 件；起批本身超過 21 的照商品）。
- 廠商起批金額（三種方案都適用）：同一家廠商（製造商）所有客人已付款的訂單湊滿「約 NT$30,000」就向日本叫貨，叫貨後約 2～3 週到貨，先付款先寄。一律說「約 NT$30,000」，不要提人民幣、進價、成本、加價或利潤；實際進度以系統百分比為準（例如「湊單中 93%，還差 7%」），不要自己換算成還差多少錢，也不要保證買滿多少就一定叫貨。客人問「我買超過 3 萬怎麼還沒滿」，就說「門檻是依日本廠商的接單金額換算，跟售價不完全一樣，請以進度百分比為準，通常再湊一點就會叫貨」。客人下單不用自己湊滿，所有客人的訂單一起算；同一廠商不同 IP、系列可以合併，不同廠商不能合併，也不能補差價或補運費提早出貨。商城每個商品下面有「廠商」和湊單進度條。
- 一張訂單有多家廠商時，某家廠商的貨先到，系統會用 LINE 問客人要「先寄」已到貨的商品（這次要付一次運費 NT$60，會員可用運費券），還是「等齊再寄」（先留著，全部到齊一起寄只算一次運費）。已出貨的商品在訂單裡會被劃掉。
- 運費：依廠商分批寄出，每出貨一次國內運費 NT$60；國際運費依物流公司報價（約每公斤 NT$220，出貨時才會確定金額並通知客人）。不是會員或運費券用完的，出貨時自動加收運費。會員每月送運費券（一般會員 5 張國內；VIP 10 張國內＋10 張國際），每月 1 號重新發放，出貨時自動折抵。客人傳「優惠券」可以看本月還剩幾張。會員沒有「全免運」了，不要說運費全免。
- 一張訂單有多家廠商時，依廠商分別叫貨，哪家先到貨就先寄那家的商品（會分批寄、各有物流單號），全部寄完訂單才會變成「已出貨」。
- 客人問訂單進度：請客人傳「我的訂單」，會顯示每家廠商目前是湊單中幾 %、已湊滿準備叫貨、或已向日本叫貨。
- 一律以候選商品「起批」欄位寫的數字為準。不可以說「加入會員後全部一件起」。
- 景品（夾娃娃機獎品，品牌是「景品 FuRyu／景品 SEGA／景品 Eikoh」）：每款 3 個起批，同一系列隨機出貨、不能挑角色；同系列所有客人的訂單湊滿一箱（商品資料寫的入數）才向日本下單；本批 2027年3月日本發售的景品結單日 10/28 23:59。
- 客人問 FuRyu（フリュー）的商品（常見是三麗鷗景品絨毛、公仔）：目錄沒有就不要報價，回「FuRyu 是廠商配貨制喔 我們可以幫您下單 但會依實際配貨數量出貨 沒配到的部分全額退款～ 我請專人跟您確認款式跟數量」，並加 #HANDOFF。目錄有同角色的其他三麗鷗商品，可以順便列出 1～3 款給客人參考。
- 商品資料若有「訂購方式：整箱…不拆箱不混款」，這款不論是否會員都只能單款整箱訂（每款 1 箱起），報價時要講清楚每箱幾個、整箱價（單價×每箱數量），以及截單時間。

【會員】
- 預設只推薦 VIP 會員：NT$1,000／月，每月 10 張國內＋10 張國際運費券、更優惠的批發價（每件便宜 NT$30）、沒有總件數限制可以真正少量叫貨、新品優先通知。入會：${VIP}
- 只有客人問 NT$100、問更便宜的方案、或說 VIP 太貴時，才介紹一般會員：NT$100／月，每月 5 張國內運費券，每款照起批數、不同款混批 21 件。入會：${GENERAL}

【其他】
- 訂單查詢：請客人點選單的「訂單查詢」，或傳「我的訂單」。
- 優惠券／折抵券：請客人傳「優惠券」查看自己的券、狀態和期限；下單時在商城購物車選擇折抵券就會自動扣除。「三麗鷗・吉伊卡哇滿額回饋」活動已在 10/25 23:59 結束，之後下單不會再送活動折抵券；活動期間已經拿到的券照常可以用（付款後生效，30 天內使用，下次訂單滿券面 5 倍可折抵，一張訂單限用一張）。客人問有沒有新活動，說目前沒有進行中的滿額活動，有新活動會再通知。
- 付款方式：線上訂購網站結帳時可以選「銀行轉帳」或「LINE Pay」，付款後在 LINE 傳後五碼和付款截圖，系統會自動對帳。
- 發票／含稅：預計明年才成立公司，目前沒辦法開發票；價格就是商城標示的批發價（依日幣匯率調整，以下單當下為準）。
- 缺貨：日本廠商缺貨的商品會退款，其他有貨的照常寄出。
- 瑕疵、漏寄、運送損壞：收到貨 3 天內回報並附開箱影片，我們 7 天內處理。超過 3 天或沒有開箱影片就照實說明這個規則。
- 實拍照、影片、樣品：目前都沒有提供；可以建議客人第一次先少量下單試試（VIP 沒有總件數限制）。
- 商品圖片：可以放到 IG 等社群平台宣傳，但請勿公開貨源。
- 銷售通路／售價限制：依照我們平常的批發規則（照起批數下單、付款後依廠商湊單、湊滿約 2～3 週到貨、先付款先寄），不要自己另外承諾或限制。
- 實際國際運費金額、改單、取消訂單、客訴，或任何從上面規則和候選商品裡找不到答案的問題：不要硬回答，直接加上 #HANDOFF（系統會自動跟客人說請專人回覆，你的文字不會送出）。
- 客人一直問同一件事、你只能重複前面講過的話時，也加上 #HANDOFF。
- 會員效期一般是 1 個月，到期自動停止；客人問自己的會員到期日，請他傳「會員期限」。續約會從到期日往後延長。
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
需要轉真人客服時，再另起一行寫：#HANDOFF
客人問到購買流程或制度（怎麼下單、怎麼用商城、湊單／進度條是什麼、起批規則、會員差別、付款回報、什麼時候到貨、運費／運費券、先寄或等齊、怎麼查訂單、已出貨劃掉）時：先用 2～4 句直接回答他的問題，再說「附上教學影片，第 X 步（約 m:ss）就是在講這個，看完就知道〇〇」（〇〇＝這段影片幫他解決什麼問題），最後另起一行寫：#VIDEO
教學影片段落：第1步 0:05 加入好友、點選單「批發商城」；第2步 0:16 首頁新品、商品下方的廠商湊單進度（湊滿約 NT$30,000 叫貨）；第3步 0:25 選擇規格、放大儲存照片；第4步 0:32 選款式按加入、數量是起批數倍數；第5步 0:41 查看購物車；第6步 0:48 購物車提醒每家廠商還差多少、方案件數規則；第7步 0:57 填資料送出訂單、轉帳或 LINE Pay；第8步 1:05 付款後傳後五碼＋截圖自動對帳；第9步 1:14 傳「我的訂單」查湊單進度；第10步 1:22 同廠商湊滿約 NT$30,000 叫貨，湊滿後約 2～3 週到貨；第11步 1:32 到貨時選先寄（運費 $60）或等齊；第12步 1:41 出貨通知、物流單號、運費券折抵；第13步 1:49 已出貨商品劃掉；第14步 1:56 三種會員方案比較。
到貨時間一律說「湊滿後約 2～3 週到貨」（從湊滿叫貨才開始算，不是從下單算）。
商品標籤（都不是台灣現貨，貨都從日本叫）：「日本現貨」＝日本廠商有庫存，湊單達標就能馬上向日本叫貨（湊滿後約 2～3 週到貨）；「日本預購」＝現在就能先下單叫貨，但要到商品標示的預計時間日本才會出貨，到貨時間以標示時間為準（不是湊滿後 2～3 週）。客人問某商品什麼時候到，先看它是現貨還是預購再回答。`;

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
let CATALOG = null, RAW_CATALOG = null, PRICED_WITH = "", LIVE_DAY = "";
// ---------- 每日匯率自動計價 ----------
// 每款商品的 pb 記錄計價基準：日幣商品＝日幣未稅價 y × 1.1 × 折扣 d（或已含稅折扣後金額 a）；人民幣商品＝稅後人民幣 a（盲盒再除以每盒 n 個）
// 成本＝外幣金額 × 當天台銀匯率（日圓現金賣出、人民幣即期賣出），無條件進位；一般價＝成本＋80、VIP＝成本＋50
function priceItem(it, r) {
  const pb = it.pb;
  if (!pb || !r) return;
  const a = pb.a != null ? pb.a : pb.y * 1.1 * pb.d;
  const rate = pb.c === "CNY" ? r.CNY : r.JPY;
  if (!rate) return;
  const cost = Math.ceil((a * rate) / (pb.n || 1) - 1e-9);
  it.g = cost + 80; it.v = cost + 50;
}
async function getRates(env) {
  try { return env.SESSIONS ? JSON.parse((await env.SESSIONS.get("rates")) || "null") : null; } catch (e) { return null; }
}
async function fetchBotRates() {
  const r = await fetch("https://rate.bot.com.tw/xrt/flcsv/0/day", { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("台銀匯率 " + r.status);
  const txt = await r.text();
  const pick = (cur) => {
    const row = txt.split(/\r?\n/).find((l) => l.startsWith(cur));
    if (!row) return null;
    const c = row.split(",").map((x) => x.trim());
    const i = c.indexOf("本行賣出");
    return i > 0 ? { cash: Number(c[i + 1]), spot: Number(c[i + 2]) } : null;
  };
  const jp = pick("JPY"), cn = pick("CNY");
  if (!jp || !(jp.cash > 0)) throw new Error("讀不到日圓匯率");
  return { JPY: jp.cash, CNY: cn && cn.spot > 0 ? cn.spot : null };
}
async function updateRates(env, notify = true) {
  const old = (await getRates(env)) || {};
  const nr = await fetchBotRates();
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const rates = { JPY: nr.JPY, CNY: nr.CNY || old.CNY || 4.804, date: today, at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ") };
  await env.SESSIONS.put("rates", JSON.stringify(rates));
  CATALOG = null; // 下次讀目錄時用新匯率重算
  if (notify) {
    const owner = await env.SESSIONS.get("owner");
    const arrow = (n, o) => (o ? (n > o ? `↑（前次 ${o}）` : n < o ? `↓（前次 ${o}）` : "（持平）") : "");
    if (owner) await lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text",
      text: `📈 今日匯率已自動更新（台銀 ${rates.at}）\n日圓 現金賣出：${rates.JPY} ${arrow(rates.JPY, old.JPY)}\n人民幣 即期賣出：${rates.CNY} ${arrow(rates.CNY, old.CNY)}\n\n所有商品的一般價／VIP 價已用今天的匯率重新計算（每款折扣照各自型錄），客人看到的都是最新價格👌\n已成立的訂單維持下單時的價格。` }] });
  }
  return rates;
}
// 商城商品清單的快取鑰匙：目錄版本＋匯率＋結單規則＋小時（任何一個變了就重算）
async function catStamp(env) {
  const r = await freshRates(env), rules = await getDlRules(env);
  return [CATALOG_VERSION, r ? r.JPY + "|" + r.CNY : "", JSON.stringify(rules), new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13)].join("|");
}
// 結單日規則（老闆用「結單 品牌 日期」設定）：KV dlrules = { "*": 預設, "<品牌或關鍵字>": 日期或文字 }
async function getDlRules(env) {
  try { return env.SESSIONS ? JSON.parse((await env.SESSIONS.get("dlrules")) || "{}") : {}; } catch (e) { return {}; }
}
function applyDl(it, rules, keys) {
  if (it.dl && !isExpired(it)) { it.dlx = ""; return; } // 型錄本身有結單日就照型錄
  const h = (it.b || "") + " " + (it.n || "");
  const k = keys.find((k) => h.includes(k));
  const passed = (v) => { const m = (v || "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})/); return m && Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]) < Date.now(); };
  let v = k ? rules[k] : "";
  if (!v || passed(v)) v = rules["*"] || "";
  it.dlx = passed(v) ? "" : v;
}
// 匯率：KV（機器人 9:15 自動抓）和 GitHub 的 rates.json（每日維護寫入）哪個日期新就用哪個，避免其中一邊沒更新到
let REPO_RATES = null, REPO_RATES_AT = 0;
async function freshRates(env) {
  let kv = await getRates(env);
  if (CATALOG_SHA && Date.now() - REPO_RATES_AT > 10 * 60e3) {
    try { const r = await fetch(`https://raw.githubusercontent.com/Gg86384577/zoare-images/${CATALOG_SHA}/rates.json`, { cf: { cacheTtl: 300 } }); if (r.ok) REPO_RATES = await r.json(); } catch (e) {}
    REPO_RATES_AT = Date.now();
  }
  const rp = REPO_RATES;
  if (rp && rp.JPY && (!kv || String(rp.date || "") > String(kv.date || ""))) {
    kv = { JPY: rp.JPY, CNY: rp.CNY || (kv && kv.CNY) || 4.804, date: rp.date, at: rp.at || rp.date };
    if (env.SESSIONS) { try { await env.SESSIONS.put("rates", JSON.stringify(kv)); } catch (e) {} }
  }
  return kv;
}
async function loadCatalog(env) {
  const rates = await freshRates(env), rules = await getDlRules(env);
  const keys = Object.keys(rules).filter((k) => k !== "*").sort((a, b) => b.length - a.length);
  const stamp = (rates ? `${rates.JPY}|${rates.CNY}` : "") + "|" + JSON.stringify(rules);
  // 每小時重新篩一次，剛過結單時間的商品馬上下架
  if (CATALOG && PRICED_WITH === stamp && LIVE_DAY === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13)) return CATALOG;
  if (RAW_CATALOG) {
    for (const it of RAW_CATALOG) { if (rates) priceItem(it, rates); applyDl(it, rules, keys); }
    CATALOG = RAW_CATALOG.filter((it) => !isExpired(it)); PRICED_WITH = stamp; // 過了結單日的商品直接移除
    LIVE_DAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13);
    return CATALOG;
  }
  // 每次更新商品目錄就改 CATALOG_VERSION，讓新價格馬上生效
  // 用「固定的 commit 版本」網址抓目錄：GitHub 的 main 網址會被 CDN 快取好幾分鐘，剛更新的商品可能抓到舊的
  const u = CATALOG_SHA ? `https://raw.githubusercontent.com/Gg86384577/zoare-images/${CATALOG_SHA}/catalog.json`
    : env.CATALOG_URL + (env.CATALOG_URL.includes("?") ? "&" : "?") + "v=" + CATALOG_VERSION;
  const res = await fetch(u, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error("catalog " + res.status);
  const items = await res.json();
  for (const it of items) { it._t = it.t || norm([it.n, it.ja, it.b, it.s, it.code, it.jan].join(" ")); if (rates) priceItem(it, rates); applyDl(it, rules, keys); }
  try { linkAlts(items); } catch (e) {}
  RAW_CATALOG = items; CATALOG = items.filter((it) => !isExpired(it)); PRICED_WITH = stamp;
  LIVE_DAY = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13);
  return CATALOG;
}

const ALIAS_NORM = ALIASES.map((g) => g.map(norm));
// 商品種類：客人問「娃娃」就優先給娃娃，不要給同角色的袋子、文具
const TYPE_NORM = [["娃娃", "玩偶", "ぬいぐるみ", "ヌイグルミ", "布偶", "絨毛娃娃"], ["吊飾", "掛件", "マスコット", "鑰匙圈", "キーホルダー", "チャーム", "鑰匙扣"], ["包", "袋", "バッグ", "ポーチ", "トート"], ["貼紙", "シール", "ステッカー"], ["杯", "マグ", "コップ"], ["筆", "ペン", "文具"], ["公仔", "フィギュア"], ["抱枕", "クッション"]].map((g) => g.map(norm));

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
    if (hit) { groups.push(g); for (const x of g) if (x) rest = rest.split(x).join(" "); } // 同一組的中日文名稱都拿掉，避免日文名稱重複加分
  }
  const grams = [];
  for (const part of rest.split(" ")) {
    if (part.length === 1) grams.push(part);
    for (let i = 0; i + 1 < part.length; i++) grams.push(part.slice(i, i + 2));
  }
  const types = TYPE_NORM.filter((g) => g.some((w) => q.includes(w)));
  // 角色優先：問題裡有角色名，就只給這個角色的商品（不同角色不列）
  const TW = new Set(TYPE_NORM.flat());
  const charGroups = groups.filter((g) => !g.some((w) => TW.has(w)));
  const scored = [];
  for (const it of items) {
    let sc = 0, groupHits = 0;
    if (types.length) for (const g of TYPE_NORM) if (g.some((w) => it._t.includes(w))) sc += types.includes(g) ? 8 : -6;
    for (const g of groups) if (g.some((w) => it._t.includes(w))) { sc += 10; groupHits++; }
    if (groups.length && !groupHits) continue;
    if (charGroups.length && !charGroups.some((g) => g.some((w) => it._t.includes(w)))) continue;
    for (const gr of grams) if (it._t.includes(gr)) sc += gr.length === 1 ? 0.5 : 2;
    if (sc > 0) scored.push([sc - ((it.st && it.st.includes("缺貨")) || isExpired(it) ? 3 : 0) - (it._t.length / 400), it]); // 同分時名稱越精簡（越接近基本款）越前面
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
  { const bm = (it.pack || "").match(/(?:整盒|整箱)\s*(\d+)\s*個/), box = bm ? +bm[1] : 0, own = box || Number(it.moq) || (/盲盒/.test(it.pack || "") ? 0 : Number(((it.pack || "").match(/\d+/) || [0])[0]));
    const u = own || 3, non = u >= 21 ? u : Math.ceil(21 / u) * u;
    f.push(`起批（單款）：會員 ${u} 件、非會員 ${non} 件${box ? `（整盒 ${box} 個倍數）` : ""}`); }
  if (it.pack && it.pack.includes("整箱")) f.push(`訂購方式：${it.pack}`);
  if (isExpired(it)) f.push(`狀態：已截止（不可下單）`);
  else if (it.st) f.push(`狀態：${it.st}`);
  if (it.ship) f.push(`發售出貨：${shipLabel(it) || it.ship}`);
  f.push(`結單：${dlLabel(it)}`);
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
async function reply(env, token, messages, to) {
  let r = await lineApi(env, "/v2/bot/message/reply", { replyToken: token, messages: messages.slice(0, 5) });
  if (!r.ok) {
    const err = await r.text();
    // 照片辨識比較久，回覆權杖可能過期 → 改用推播送出，不讓客人等了半天沒回應
    if (to && /reply ?token/i.test(err)) {
      r = await lineApi(env, "/v2/bot/message/push", { to, messages: messages.slice(0, 5) });
      if (r.ok) return;
    }
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
async function claude(env, system, messages, maxTokens = 2500, model) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: model || env.MODEL || DEFAULT_MODEL, max_tokens: maxTokens, system, messages }),
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
  let show = [], handoff = false, video = false;
  const lines = t.split("\n").filter((ln) => {
    const x = ln.trim();
    if (/^#SHOW/i.test(x)) { show = (x.match(/\d+/g) || []).map(Number).filter((n) => n > 0); return false; }
    if (/^#HANDOFF/i.test(x)) { handoff = true; return false; }
    if (/^#VIDEO/i.test(x)) { video = true; return false; }
    return true;
  });
  return { reply: lines.join("\n").trim(), show, handoff, video };
}

// 照片 → 搜尋關鍵字
async function describePhoto(env, img) {
  const ask = (model) => claude(env,
    "你是商品辨識助手。看照片判斷商品，只輸出一個 JSON（不要加 ``` 或其他文字）：{\"query\":\"角色或IP的中文名 日文名 商品種類（例：酷洛米 クロミ 娃娃 ぬいぐるみ）\",\"ja_text\":\"照片上印的日文商品名稱和系列名，照抄（例：サンリオキャラクターズ お出かけもこもこスタイル ミニトート）\",\"jan\":\"照片上看得到的一個 JAN 條碼數字或型號，沒有就空字串\",\"codes\":[\"照片上看得到的所有品番／型號（例：SAOM-MT-KT、SAOM-MT）和 13 碼 JAN 數字，最多 12 個\"],\"character\":\"照片上商品的角色中文名（例：美樂蒂），多個用空格分開\",\"features\":\"外觀特徵的中文關鍵字，例如：標準款 坐姿 和服 蓬鬆 迷你 吊飾 粉紅（沒有就空字串）\",\"is_product\":true}\n照片常常是廠商目錄的一整頁，上面有好幾款商品：請把標題的商品名、系列名，以及每一款旁邊的「品番」、條碼下方的數字都抄下來；看不清楚的不要猜。",
    [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text: "這是什麼商品？" }] }],
    900, model);
  let out;
  try { out = await ask(env.PHOTO_MODEL || PHOTO_MODEL); } catch (e) { console.log("photo model failed", e); out = await ask(); } // 強模型失敗就退回預設模型
  let d;
  try { d = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch (e) { d = { query: out.replace(/[{}"\[\]]/g, " ").slice(0, 160), jan: "" }; }
  // JSON 壞掉或被截斷時，也從原文把品番、JAN 撈出來
  const extra = (out.match(/\b[A-Z][A-Z0-9]{1,5}-[A-Z0-9]{1,5}(?:-[A-Z0-9]{1,4})?\b|\b49\d{11}\b/g) || []);
  d.codes = [...new Set([...(Array.isArray(d.codes) ? d.codes : []), ...extra])].slice(0, 16);
  d.query = [d.character, d.ja_text, d.query, d.features].filter(Boolean).join(" ");
  if (env.SESSIONS) await env.SESSIONS.put("lastphoto", new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16) + "\n" + JSON.stringify(d).slice(0, 900), { expirationTtl: 7 * 86400 }).catch(() => {});
  return d;
}

// 照片上抄到的品番／JAN → 直接對目錄（一整頁目錄照片會有好幾款）
function photoHits(items, d) {
  const fz = (c) => String(c || "").toUpperCase().replace(/\s+/g, "").replace(/[–—－]/g, "-").replace(/0/g, "O"); // 品番常把 O 和 0 看錯
  const raw = [...(Array.isArray(d && d.codes) ? d.codes : []), (d && d.jan) || ""].map((c) => String(c || "").trim().toUpperCase().replace(/\s+/g, "")).filter((c) => c.length >= 4);
  const out = [], seen = new Set();
  const add = (it) => { if (!seen.has(it)) { seen.add(it); out.push(it); } };
  for (const c of raw) {
    const hit = items.filter((it) => fz(it.code) === fz(c) || (it.jan || "") === c);
    if (hit.length) { hit.forEach(add); continue; }
    if (/^[A-Z0-9]+-[A-Z0-9]+$/.test(c)) items.filter((it) => fz(it.code).startsWith(fz(c) + "-")).slice(0, 12).forEach(add); // 只看到系列品番（例：SAOM-MT）
  }
  // 照片上抄到好幾個品番（多半是一整頁目錄）→ 同系列的其他款也一起列出（有些品番可能沒抄完整）
  if (raw.length >= 2 && out.length) {
    const pre = new Set(out.map((it) => fz(it.code).replace(/-[^-]+$/, "")).filter((x) => x.includes("-")));
    for (const p of pre) items.filter((it) => fz(it.code).startsWith(p + "-")).forEach(add);
  }
  return out.slice(0, 12);
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
// 轉真人有兩種：
// "1"＝真人真的在處理（老闆停止回覆、客人要求真人、老闆親自回）→ 機器人完全安靜
// "auto"＝機器人自己找不到答案先轉給老闆 → 客人再問「目錄裡有的商品」機器人照樣跳卡片，其他問題才安靜
async function inHandoff(env, uid) { return env.SESSIONS ? (await env.SESSIONS.get("h:" + uid)) === "1" : false; }
async function inAutoHandoff(env, uid) { return env.SESSIONS ? (await env.SESSIONS.get("h:" + uid)) === "auto" : false; }
async function setHandoff(env, uid, kind = "1") {
  if (!env.SESSIONS) return;
  if (kind === "auto" && (await env.SESSIONS.get("h:" + uid)) === "1") kind = "1"; // 已經是真人處理就維持
  await env.SESSIONS.put("h:" + uid, kind, { expirationTtl: HANDOFF_MINUTES * 60 });
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
const RICHMENU_IMG = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/richmenu_v11.jpg";
const RICHMENU_VER = "v11-20261021"; // 改選單時換這個，排程會自動重建選單
const RICHMENU_OWNER_IMG = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/richmenu_owner_v11.jpg";
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
  const base = ["批發商城", "新品上線", "熱賣推薦", "圖片詢價", "聯絡客服"].map(msg);
  const auth = { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
  try {
    const id = await createMenu(env, RICHMENU_IMG, "ZOARE v3", [...base, msg("訂單查詢")]);
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
    if (env.SESSIONS) await env.SESSIONS.put("menuver", RICHMENU_VER);
    return "好👌 圖文選單已經更新囉（客人看到：批發商城、新品上線、熱賣推薦、圖片詢價、聯絡客服、訂單查詢）" + ownerNote + "\n關掉聊天室再打開就會看到";
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
  const dm = text.trim().match(/^#?結單(?:日)?(?:\s+(.+?))?(?:\s+(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})(?:\s+(\d{1,2}:\d{2}))?|\s+(每.+|長期接單|清除|刪除))?$/);
  if (dm && env.SESSIONS) {
    const rules = await getDlRules(env);
    const who = (dm[1] || "").trim(), key = !who || /^(全部|預設|全館)$/.test(who) ? "*" : who;
    if (!dm[2] && !dm[4]) {
      const list = Object.entries(rules).map(([k, v]) => `・${k === "*" ? "全部（預設）" : k}：${v}`);
      return `⏰ 結單日設定${list.length ? "\n" + list.join("\n") : "：還沒設定（沒寫結單日的商品顯示「長期接單」）"}\n\n設定方式：\n・結單 全部 每週日 23:59\n・結單 309 三麗鷗 10/31\n・結單 吉伊卡哇 2026-11-05 18:00\n・結單 Nakajima 清除\n品牌或商品名稱有包含關鍵字的都會套用；型錄本身有寫結單日的照型錄`;
    }
    if (dm[4] && /清除|刪除/.test(dm[4])) { delete rules[key]; }
    else if (dm[4]) { rules[key] = dm[4] === "長期接單" ? "" : dm[4]; if (!rules[key]) delete rules[key]; }
    else {
      const tw = new Date(Date.now() + 8 * 3600e3);
      const p = dm[2].split(/[-/]/).map(Number);
      const [y, mo, d] = p.length === 3 ? p : [tw.getUTCFullYear() + (p[0] < tw.getUTCMonth() + 1 - 6 ? 1 : 0), p[0], p[1]];
      rules[key] = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${dm[3] || "23:59"}`;
    }
    await env.SESSIONS.put("dlrules", JSON.stringify(rules));
    CATALOG = null;
    const items = await loadCatalog(env);
    const n = key === "*" ? items.length : items.filter((it) => ((it.b || "") + " " + (it.n || "")).includes(key)).length;
    return rules[key] ? `好👌 ${key === "*" ? "全部商品（沒另外設定的）" : `「${key}」${n} 款商品`}結單日設為：${rules[key]}\n商品卡片和訂購網站都會顯示，日期過了會自動改回預設` : `好👌 已清除「${key === "*" ? "全部" : key}」的結單日設定`;
  }
  const iqr = env.SESSIONS ? await inquiryCommand(env, text.replace(/\s+/g, " ").trim()) : null;
  if (iqr) return iqr;
  const bcr = env.SESSIONS ? await broadcastCommand(env, text.trim()) : null;
  if (bcr) return bcr;
  // 補發關懷：功能上線前聯絡過、還沒下單的舊客人
  const bm = text.trim().match(/^#?補發關懷\s*(確認)?$/);
  if (bm && env.SESSIONS) {
    const owner = await env.SESSIONS.get("owner");
    const seen = new Set(), list = [];
    let cursor;
    do {
      const r = await env.SESSIONS.list({ prefix: "n:", cursor });
      for (const k of r.keys) {
        const uid = await env.SESSIONS.get(k.name);
        if (!uid || uid === owner || seen.has(uid)) continue;
        seen.add(uid);
        let c = null; try { c = JSON.parse((await env.SESSIONS.get("c3:" + uid)) || "null"); } catch (e) {}
        if (c && c.at && Date.now() - c.at < CARE_MS) continue; // 3 小時內有聯絡，交給自動關懷
        if (await orderedSince(env, uid, Date.now() - CARE_MS)) continue; // 最近 3 小時有下單
        if (await env.SESSIONS.get("care:done:" + uid)) continue; // 已補發過
        list.push({ uid, name: k.name.slice(2), c });
      }
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
    if (!list.length) return "目前沒有需要補發的客人👌（最近 3 小時有聯絡或有下單的都會跳過）";
    if (!bm[1]) return `💌 可以補發關懷的客人共 ${list.length} 位：\n${list.slice(0, 40).map((x) => "・" + x.name).join("\n")}${list.length > 40 ? `\n…還有 ${list.length - 40} 位` : ""}\n\n這些是之前聯絡過、最近 3 小時沒聯絡也沒下單的客人。系統沒有記錄他們以前問過哪些商品，會傳「問想找什麼商品」的溫暖版本\n會用掉 ${list.length} 則 LINE 推播額度\n\n確定要傳，請回「補發關懷 確認」`;
    let ok = 0, fail = 0;
    for (const x of list.slice(0, 100)) {
      const msgs = await careMessages(env, x.uid, x.c || {});
      const r = await lineApi(env, "/v2/bot/message/push", { to: x.uid, messages: msgs });
      if (r.ok) { ok++; await env.SESSIONS.put("care:done:" + x.uid, "1", { expirationTtl: 30 * 86400 }); await env.SESSIONS.delete("c3:" + x.uid); } else fail++;
    }
    return `💌 已補發關懷訊息給 ${ok} 位客人${fail ? `（${fail} 位沒送出，可能已封鎖）` : ""}${list.length > 100 ? `\n一次最多 100 位，還有 ${list.length - 100} 位，再傳一次「補發關懷 確認」` : ""}`;
  }
  if (/^#?(關懷訊息|關懷)\s*(關|關閉|停止|開|開啟)?$/.test(text.trim())) {
    const m = text.trim().match(/(關|關閉|停止|開|開啟)$/);
    if (m) { if (/開/.test(m[1])) await env.SESSIONS.delete("care:off"); else await env.SESSIONS.put("care:off", "1"); }
    const off = (await env.SESSIONS.get("care:off")) === "1";
    return `💌 3 小時關懷訊息：${off ? "已關閉" : "開啟中"}\n客人聯絡後 3 小時沒下單，會在 11:00～21:00 自動傳一則溫暖的問候，附上他上次問的商品（沒問過商品就問他想找什麼）\n每次聯絡只會傳一次\n\n傳「關懷 關」可以關閉、「關懷 開」重新開啟`;
  }
  if (/^#?(匯率|今日匯率)$/.test(text.trim())) {
    const r = await getRates(env);
    return r ? `目前計價匯率（台銀 ${r.at}）\n日圓 現金賣出：${r.JPY}\n人民幣 即期賣出：${r.CNY}\n\n每天早上 9:15 後自動更新，要馬上更新請傳「更新匯率」` : "還沒抓過匯率，傳「更新匯率」可以馬上抓";
  }
  if (/^#?(更新匯率|重抓匯率)$/.test(text.trim())) {
    try { const r = await updateRates(env, false); return `好👌 已更新為台銀最新匯率（${r.at}）\n日圓 ${r.JPY}｜人民幣 ${r.CNY}\n全部商品價格已重新計算`; } catch (e) { return "抓匯率失敗：" + e.message; }
  }
  if (/^#?(錯誤|錯誤紀錄)$/.test(text.trim())) return (await env.SESSIONS.get("lasterr")) || "最近沒有傳送失敗的紀錄👌";
  if (/^#?(照片辨識|辨識紀錄)$/.test(text.trim())) return "📷 最近一次照片辨識結果：\n" + ((await env.SESSIONS.get("lastphoto")) || "（還沒有紀錄）");
  if (/^#?(後台|商家後台|管理後台)$/.test(text.trim())) return `🔐 ZOARÉ 商家後台（只有你的帳號能用，請不要轉傳）：\n${await adminLink(env, (await env.SESSIONS.get("owner")))}\n\n💡 傳「#更新選單」後，你的圖文選單右下角會變成「商家後台」按鈕，之後點一下就能開`;
  const shopR = await shopOwnerCommand(env, text.trim(), { lineApi, loadCatalog, isExpired, claude });
  if (shopR) return shopR;
  if (/^#?(會員名單|會員列表|所有會員|會員清單)$/.test(t)) {
    const rows = [];
    let cursor;
    do {
      const r = await env.SESSIONS.list({ prefix: "tier:", cursor });
      for (const k of r.keys) {
        const uid = k.name.slice(5), tier = await env.SESSIONS.get(k.name);
        if (tier !== "vip" && tier !== "member") continue;
        const until = Number(await env.SESSIONS.get("tx:" + uid)) || 0;
        if (until && until < Date.now()) continue;
        rows.push({ tier, until, name: await nameOf(env, uid) });
      }
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
    if (!rows.length) return "目前沒有有效的會員";
    rows.sort((a, b) => (a.tier === b.tier ? (a.until || 9e15) - (b.until || 9e15) : a.tier === "vip" ? -1 : 1));
    const line = (x) => `・${x.name}　${x.until ? `到 ${fmtDay(x.until)}（剩 ${Math.ceil((x.until - Date.now()) / 86400e3)} 天）` : "未設期限"}`;
    const vip = rows.filter((x) => x.tier === "vip"), gen = rows.filter((x) => x.tier === "member");
    return `📅 有效會員共 ${rows.length} 位\n\n👑 VIP 會員（${vip.length}）\n${vip.map(line).join("\n") || "・無"}\n\n🔹 一般會員（${gen.length}）\n${gen.map(line).join("\n") || "・無"}\n\n改期限：「名字 VIP 3個月」「名字 會員 到12/31」`;
  }
  // 會員等級：「小美 VIP」「芊芊 改為VIP會員 期限2個月」「小美 會員 到12/31」「小美 非會員」（沒寫期限＝1 個月）
  const dm2 = t.match(/^(.*?)\s*(?:[,，、]?\s*(?:期限|效期|有效|為期|共)?\s*(\d+\s*(?:個多月|個月|月|天|日|週|周|年)|(?:到|至)\s*[\d/.-]+))\s*$/);
  const body = dm2 && dm2[2] ? dm2[1] : t;
  const tm = body.match(/^(.+?)\s*(?:改為|改成|設為|設定為|升級為|升級成|開通|設定)?\s*(VIP會員|VIP|vip|一般會員|會員|非會員|一般)$/);
  if (tm) {
    const r = await findUid(env, tm[1]);
    if (r.error) return r.error;
    const tier = /vip/i.test(tm[2]) ? "vip" : /^(會員|一般會員)$/.test(tm[2]) ? "member" : "none";
    const period = (dm2 && dm2[2] && parsePeriod(dm2[2])) || { months: 1 };
    const res = await setMembership(env, r.uid, tier, period, false);
    if (tier === "none") return `好👌 「${r.name}」已改為非會員`;
    return `好👌 「${r.name}」設定為${{ vip: "VIP 會員", member: "一般會員（NT$100）" }[tier]}\n📅 有效到 ${fmtDay(res.until)}（${Math.ceil((res.until - Date.now()) / 86400e3)} 天）\n到期會自動停止，到期前 3 天會提醒客人續約；客人傳「會員期限」可以看到自己的到期日`;
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
  // 新朋友加入（或解除封鎖）→ 歡迎訊息：商城連結、LINE 查報價教學、會員制度＋VIP 方案卡片
  if (ev.type === "follow" && ev.replyToken && ev.source && ev.source.userId) {
    const uid = ev.source.userId;
    let name = "";
    try { name = await displayName(env, uid); if (name === "老闆") name = ""; } catch (e) {}
    try { await rememberName(env, uid); } catch (e) {}
    return reply(env, ev.replyToken, await welcomeMessages(env, uid, name));
  }
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
    // 預覽新好友歡迎訊息
    if (/^#?(歡迎訊息|測試歡迎|歡迎文案)$/.test(text)) {
      let name = ""; try { name = await displayName(env, uid); if (name === "老闆") name = ""; } catch (e) {}
      return reply(env, ev.replyToken, await welcomeMessages(env, uid, name));
    }
    if (/threads\.(?:com|net)\/@[\w.]+\/post\//.test(text)) {
      const lr = await threadsFromLink(env, text);
      if (lr) return lr.msgs ? reply(env, ev.replyToken, lr.msgs) : reply(env, ev.replyToken, [{ type: "text", text: lr }]);
    }
    if (/^#?(海巡|開始海巡|海巡示範|海巡發送|海巡改|海巡跳過|海巡關鍵字|海巡結果)/.test(text.trim())) {
      const hr = await threadsOwnerCmd(env, text);
      if (hr !== undefined) return hr && hr.msgs ? reply(env, ev.replyToken, hr.msgs) : hr ? reply(env, ev.replyToken, [{ type: "text", text: hr }]) : undefined;
    }
    if (/^#?(系統錯誤|錯誤紀錄)$/.test(text.trim())) {
      const se = await env.SESSIONS.get("shoperr"), le = await env.SESSIONS.get("lasterr");
      return reply(env, ev.replyToken, [{ type: "text", text: "🛠 最近錯誤紀錄\n\n商城：" + (se || "沒有") + "\n\nLINE：" + (le || "沒有") }]);
    }
    const ht = text.trim().match(/^#?(?:海巡測試|threads測試|Threads測試)\s*(.*)$/i);
    if (ht) return reply(env, ev.replyToken, [{ type: "text", text: await threadsTest(env, ht[1] || "三麗鷗") }]);
    const r = await ownerCommand(env, text);
    if (r) return reply(env, ev.replyToken, (Array.isArray(r) ? r : [r]).map((x) => ({ type: "text", text: x })));
  }
  // 管理員自由切換自己的會員等級（測試價格用）：「切換 VIP」「切換 一般會員」「切換 非會員」
  const sw = text.replace(/\s/g, "").match(/^#?(?:切換|切換成|切換為|改成|改為|設為)(VIP會員|VIP|vip|一般會員|會員|一般|非會員)$/);
  if (uid && env.SESSIONS && sw) {
    let admins = []; try { admins = JSON.parse((await env.SESSIONS.get("admins")) || "[]"); } catch (e) {}
    let isAdmin = uid === (await env.SESSIONS.get("owner")) || admins.includes(uid);
    if (!isAdmin) { const dn = await displayName(env, uid); if (ADMIN_NAMES.some((a) => dn.replace(/\s/g, "").startsWith(a.replace(/[\s🦁]/gu, "")))) { isAdmin = true; admins.push(uid); await env.SESSIONS.put("admins", JSON.stringify(admins)); } }
    if (isAdmin) {
      const tier = /vip/i.test(sw[1]) ? "vip" : /^(一般會員|會員|一般)$/.test(sw[1]) ? "member" : "none";
      if (tier === "none") { await env.SESSIONS.delete("tier:" + uid); await env.SESSIONS.delete("tx:" + uid); }
      else { await env.SESSIONS.put("tier:" + uid, tier); await env.SESSIONS.delete("tx:" + uid); } // 管理員不設期限
      const nm = { vip: "👑 VIP 會員", member: "一般會員", none: "非會員" }[tier];
      return reply(env, ev.replyToken, [{ type: "text", text: `🔧 管理員模式：已切換為 ${nm}\n商品卡片、訂購網站都會用這個等級的價格和起批規則（網站重新整理就會更新）\n管理員沒有期限，不會被自動停止`,
        quickReply: { items: [["切換 VIP", "切換 VIP"], ["切換 一般會員", "切換 一般會員"], ["切換 非會員", "切換 非會員"]].map(([l, t]) => ({ type: "action", action: { type: "message", label: l, text: t } })) } }]);
    }
  }
  // 記錄客人聯絡時間（3 小時沒下單 → 關懷訊息）
  const isOwnerUser = uid && env.SESSIONS && uid === (await env.SESSIONS.get("owner"));
  if (uid && !isOwnerUser) {
    await noteContact(env, uid, null);
    await logInquiry(env, uid, msg.type === "text" ? text : msg.type === "image" ? "（傳了圖片）" : msg.type === "sticker" ? "（貼圖）" : "");
  }
  // 到貨時客人回覆「先寄／等齊再寄」
  if (uid && env.SESSIONS && /^(先寄|等齊再寄)\s+ZO/i.test(text || "")) {
    const er = await earlyShipReply(env, uid, text, { lineApi });
    if (er) return reply(env, ev.replyToken, [{ type: "text", text: er }]);
  }
  // 湊滿時客人回覆「這次出貨／順延」
  if (uid && env.SESSIONS && /^(這次出貨|順延)\s+ZO/i.test(text || "")) {
    const sr = await customerShipReply(env, uid, text, { lineApi });
    if (sr) return reply(env, ev.replyToken, [{ type: "text", text: sr }]);
  }
  // 匯款後五碼回報
  if (uid && env.SESSIONS && text) {
    const pr = await handlePayment(env, { lineApi }, uid, text);
    if (pr) return reply(env, ev.replyToken, [{ type: "text", text: pr }]);
  }
  // 群發連結「/go/湊單 廠商名」→ 回覆專屬連結，直接打開該廠商的商品
  { const gm = String(text || "").match(/^(?:湊單|廠商)\s+(.+)$/);
    if (uid && env.SESSIONS && gm && !/^提醒/.test(gm[1])) {
      const P = await getPools(env), key = gm[1].trim().toLowerCase();
      const names = [...new Set([...Object.keys(P.pools || {}), ...(await loadCatalog(env)).map((x) => mfrOf(x.b))])];
      const m = names.find((n) => n.toLowerCase() === key) || names.find((n) => n.toLowerCase().includes(key));
      if (m) { const p = (P.pools || {})[m], pct = p ? p.pct : 0;
        return reply(env, ev.replyToken, [{ type: "text", text: `📦 ${m} 目前湊單 ${pct}%${pct < 100 ? `，還差 ${100 - pct}%` : "，已湊滿準備叫貨"}\n（同一家廠商湊滿約 NT$30,000 就叫貨，商品都能一起湊，湊滿後約 2～3 週到貨）\n\n👉 點這裡直接看 ${m} 的所有商品：\n${await mfrLink(env, uid, m)}` }]); }
    } }
  // 教學影片
  if (uid && /^(教學|教學影片|使用教學|怎麼買|怎麼下單|如何下單|購買流程|下單流程|操作流程|影片)[？?]?$/.test(text || "")) {
    return reply(env, ev.replyToken, [{ type: "text", text: "這是 ZOARÉ 批發商城的使用教學影片👇\n從 LINE 選單點「批發商城」開始，一步一步帶您：選規格、加入購物車、送出訂單、付款回報、查湊單進度，到貨後選先寄或等齊、出貨通知和運費券。\n\n⏱ 提醒：同一廠商湊滿約 NT$30,000 就向日本叫貨，湊滿後約 2～3 週到貨～" }, introVideoMsg()]);
  }
  // 查自己的折抵券
  if (uid && env.SESSIONS && /^(我的)?(優惠券|優惠卷|折抵券|折抵卷|折價券)$/.test(text)) {
    return reply(env, ev.replyToken, [{ type: "text", text: await couponText(env, uid, await shopLink(env, uid)) }]);
  }
  // 查自己的訂單：「訂單查詢」「我的訂單」或直接傳訂單編號
  if (uid && env.SESSIONS && /^(訂單查詢|我的訂單|查訂單|訂單)$/.test(text)) {
    return reply(env, ev.replyToken, [{ type: "text", text: await customerOrders(env, uid, await shopLink(env, uid)) }]);
  }
  if (uid && env.SESSIONS && /^ZO\w{10}$/i.test(text)) {
    const d = await customerOrderDetail(env, uid, text.toUpperCase());
    if (d) return reply(env, ev.replyToken, [{ type: "text", text: d }]);
  }
  // ---------- 新版圖文選單 ----------
  const qrMsg = (list) => ({ items: list.map(([l, t]) => ({ type: "action", action: { type: "message", label: l, text: t } })) });
  const IPQR = [["吉伊卡哇", "吉伊卡哇"], ["三麗鷗", "三麗鷗"], ["寶可夢", "寶可夢"], ["史努比", "史努比"], ["蠟筆小新", "蠟筆小新"], ["角落生物", "角落生物"]];
  if (uid && /^(批發商城|商城)$/.test(text)) {
    await rememberName(env, uid);
    return reply(env, ev.replyToken, [{ type: "text", text: `這是您的專屬批發商城🛒\n${await shopLink(env, uid)}\n\n可以搜尋角色、看價格和起批數、加入購物車直接下單，價格會自動套用您的會員等級～\n（連結是您專用的，請不要轉傳）\n\n不想打字的話，點下面按鈕直接看商品👇`,
      quickReply: qrMsg([["🔥 熱賣推薦", "熱賣推薦"], ["✨ 新品上線", "新品上線"], ...IPQR, ["📷 圖片詢價", "圖片詢價"]]) }]);
  }
  if (uid && /^(新品上線|新品|商品動態|最新動態|動態)$/.test(text)) {
    const items = await loadCatalog(env);
    const cards = await productCards(env, uid, newPicks(items, isExpired, 10), "新品上線");
    const out = [{ type: "text", text: await newsReply(env, { loadCatalog, isExpired }, await shopLink(env, uid)) }];
    if (cards) { cards.quickReply = qrMsg([["🔥 熱賣推薦", "熱賣推薦"], ["🛒 批發商城", "批發商城"], ...IPQR.slice(0, 4), ["💬 聯絡客服", "聯絡客服"]]); out.unshift({ type: "text", text: "✨ 最新上架的商品幫您挑了幾款👇 喜歡的點「我要訂購」就能下單～" }); out.splice(1, 0, cards); }
    return reply(env, ev.replyToken, out.slice(0, 5));
  }
  if (uid && /^(熱賣推薦|熱賣|熱銷|推薦)$/.test(text)) {
    const items = await loadCatalog(env);
    const cards = await productCards(env, uid, await hotPicks(env, items, isExpired, 10), "熱賣推薦");
    const msgs = [{ type: "text", text: "🔥 最近大家都在買的熱門商品👇\n卡片上有價格、起批數，點「我要訂購」就能直接下單～\n想看特定角色，點下面按鈕或直接打角色名字也可以喔！" }];
    if (cards) { cards.quickReply = qrMsg([...IPQR, ["✨ 新品上線", "新品上線"], ["🛒 批發商城", "批發商城"], ["💬 聯絡客服", "聯絡客服"]]); msgs.push(cards); }
    else msgs[0].quickReply = qrMsg([...IPQR, ["🛒 批發商城", "批發商城"]]);
    return reply(env, ev.replyToken, msgs);
  }
  if (uid && /^(圖片詢價|拍照查價|拍照詢價|圖片查價)$/.test(text)) {
    return reply(env, ev.replyToken, [{ type: "text", text: `📷 圖片詢價\n直接傳商品圖片給我，系統會自動幫您找出商品和價格（一次最多 6 張）\n\n⚠️ 只能查詢 ZOARÉ 在官方 LINE、社群上發佈過的商品\n其他地方看到的商品圖片，可能會查不到喔\n\n也可以傳商品名稱、JAN 條碼或商品編號查詢～`,
      quickReply: { items: [{ type: "action", action: { type: "cameraRoll", label: "從相簿選圖片" } }, { type: "action", action: { type: "camera", label: "拍照" } },
        { type: "action", action: { type: "message", label: "🔥 熱賣推薦", text: "熱賣推薦" } }, { type: "action", action: { type: "message", label: "🛒 批發商城", text: "批發商城" } }] } }]);
  }
  if (uid && /^(聯絡客服|客服)$/.test(text)) {
    await notifyOwner(env, uid, text);
    await setHandoff(env, uid);
    return reply(env, ev.replyToken, [{ type: "text", text: "您好～已幫您通知真人客服，請稍等一下，我們會盡快回覆您🙏\n\n想問的問題（商品、數量、運費、付款、到貨時間…）可以先直接打在這裡，客服看到會一起回覆喔！" }]);
  }
  // 商品目錄：選系列 → 選角色 → 傳商品圖片卡
  if (uid && text) {
    const cm = await catalogMenu(env, { loadCatalog, isExpired }, uid, text);
    if (cm) { if (!isOwnerUser && /^(商品目錄|目錄)\s+\S/.test(text)) await noteContact(env, uid, { topic: text.replace(/^(商品目錄|目錄)\s+/, "").replace(/\s+全部$/, "") }); return reply(env, ev.replyToken, cm); }
    // 只打品牌／角色名稱 → 直接傳全部商品卡片
    const kb = await keywordBrowse(env, { loadCatalog, isExpired }, uid, text);
    if (kb) { if (!isOwnerUser) await noteContact(env, uid, { topic: text }); return reply(env, ev.replyToken, kb); }
  }
  // 商品動態
  if (uid && /^(商品動態|最新動態|動態|新品)$/.test(text)) {
    return reply(env, ev.replyToken, [{ type: "text", text: await newsReply(env, { loadCatalog, isExpired }, await shopLink(env, uid)) }]);
  }
  // 查自己的會員期限
  if (uid && env.SESSIONS && /^(會員期限|我的會員|會員到期|到期日|會員資格|會員狀態|我是會員嗎)$/.test(text.replace(/\s/g, ""))) {
    const mi = await memberInfo(env, uid);
    if (mi.tier === "none") return reply(env, ev.replyToken, [{ type: "text", text: "您目前還不是會員喔～\n加入會員（$100 或 $1,000）每款照商品起批數就能訂（很多款 2～3 件），一般會員每款照起批數、混批 21 件；VIP 沒有總件數限制，可以真正少量叫貨👇" }, ...(await membershipCards(env, uid))]);
    const name = mi.tier === "vip" ? "👑 VIP 會員" : "一般會員";
    return reply(env, ev.replyToken, [{ type: "text", text: `您目前是 ${name}\n📅 有效到 ${fmtDay(mi.until)}（還有 ${mi.days} 天）\n\n到期會自動停止，想續約的話傳「會員方案」直接下單，會從到期日往後延長，不會浪費天數喔～`,
      quickReply: { items: [{ type: "action", action: { type: "message", label: "續約／升級", text: "會員方案" } }, { type: "action", action: { type: "message", label: "商品目錄", text: "商品目錄" } }] } }]);
  }
  // 加入會員
  if (uid && /^(加入會員|會員|入會|VIP|加入VIP|會員方案|會員制|會員制度|會員費|VIP會員|一般會員|升級VIP|怎麼加入會員|(NT)?\$?1,?000(元)?(方案|會員)?|(NT)?\$?100(元)?(方案|會員)?)$/i.test(text.replace(/\s/g, ""))) {
    return reply(env, ev.replyToken, await membershipCards(env, uid));
  }
  // 公開賣場的訪客按「用 LINE 下單」→ 傳來「下單 #代碼」→ 回他自己的下單頁，購物車自動帶入
  const gcm = text.match(/^下單\s*#\s*([A-Za-z0-9]{6})$/);
  if (uid && gcm) {
    await rememberName(env, uid);
    return reply(env, ev.replyToken, [{ type: "text", text: `幫您把購物車帶過來了🛒\n點下面的連結確認數量、填寫收件資料，就能送出訂單👇\n${await shopLink(env, uid)}&cart=${gcm[1].toUpperCase()}\n\n（價格會自動套用您的會員等級；這個連結是您專用的，請不要轉傳）` }]);
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
  // 記下客人「最後一次」點的批發選單（誤點時以最後一次為準），30 分鐘內有效
  if (uid && env.SESSIONS && /^(韓國|日本|中國)批發$/.test(text)) await env.SESSIONS.put("org:" + uid, text, { expirationTtl: 1800 });
  if (MENU[text]) return reply(env, ev.replyToken, [{ type: "text", text: MENU[text].replaceAll("{name}", name).replaceAll("{shop}", uid ? await shopLink(env, uid) : "") }]);

  if (uid) lineApi(env, "/v2/bot/chat/loading/start", { chatId: uid, loadingSeconds: 20 }).catch(() => {});

  try {
    const items = await loadCatalog(env);
    const session = await getSession(env, uid);
    let userContent, query = text, img = null, hits = [], cands0 = [];
    // 同一波連續訊息：把前面的文字一起考慮；照片全部辨識（一次最多 6 張，同時進行）
    const earlierText = burst.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
    const earlierImgs = burst.filter((b) => b.type === "image");
    const photoIds = [];
    if (msg.type === "text" && !text.match(/^\s*(第\s*)?[1-5一二三四五]\s*(號|个|個|款)?\s*$/)) photoIds.push(...earlierImgs.map((b) => b.id));
    if (msg.type === "image") photoIds.push(...earlierImgs.map((b) => b.id), msg.id);
    const ids = photoIds.slice(-MAX_PHOTOS);
    if (ids.length) {
      const res = await Promise.all(ids.map(async (id) => {
        try { const im = await imageBase64(env, id); return { im, d: await describePhoto(env, im) }; } catch (e) { console.log("photo failed", e); return null; }
      }));
      const ok = res.filter(Boolean);
      if (ok.length) {
        img = ok[ok.length - 1].im;
        const seen = new Set();
        for (const r of ok) for (const it of photoHits(items, r.d)) if (!seen.has(it)) { seen.add(it); hits.push(it); }
        hits = hits.slice(0, MAX_CARDS);
        // 有照片沒對到品番時，用每張照片的辨識文字一起搜尋
        query = [...ok.map((r) => [r.d.jan, r.d.query].filter(Boolean).join(" ")), msg.type === "text" ? text : ""].filter(Boolean).join(" ");
        if (!hits.length && ok.length > 1) {
          for (const r of ok) for (const it of search(items, [r.d.jan, r.d.query].filter(Boolean).join(" "), 4)) if (!seen.has(it)) { seen.add(it); cands0.push(it); }
        }
      }
    }
    // 回覆編號（例如「2號」）時沿用上次列出的商品
    const pickedNumber = /^\s*(第\s*)?[1-5一二三四五]\s*(號|个|個|款)?\s*$|[1-5]\s*號/.test(text);
    let cands = hits.length ? hits : cands0.length ? cands0.slice(0, 16) : pickedNumber && session.last.length ? session.last.map((j) => items[j]).filter(Boolean) : search(items, query, img ? 30 : 8);
    // 文字追問（例如「這款多少」）才沿用上次的商品；客人傳了新照片就不要拿舊商品充數，免得跳出不相干的東西
    if (!cands.length && !img && session.last.length) cands = session.last.map((j) => items[j]).filter(Boolean);

    const candText = cands.length ? cands.map((it, i) => itemLine(i + 1, it)).join("\n") : "（目錄裡沒有找到相關商品）";
    const lastText = session.last.length
      ? session.last.map((j, i) => (items[j] ? `${i + 1}. ${items[j].n}` : "")).join("\n") : "（無）";
    const burstNote = burst.length ? `（客人剛剛連續傳了 ${burst.length + 1} 則訊息${earlierImgs.length ? `，其中 ${earlierImgs.length + (msg.type === "image" ? 1 : 0)} 張照片` : ""}${earlierText ? "，前面的文字：" + earlierText : ""}；請合併成一則回覆）\n` : "";
    const lastMenu = uid && env.SESSIONS ? await env.SESSIONS.get("org:" + uid) : null;
    const prompt = `${lastMenu ? `客人最後一次點的選單：${lastMenu}（客人常常誤點，只以最後一次為準；判斷時以客人實際傳的商品為主）\n` : ""}客人名稱：${name}${session.history.length ? "（對話進行中，不要再打招呼）" : "（這是對話第一則，可以打招呼）"}\n${burstNote}客人${img ? (text ? "傳了照片並說：" + text + "（照片辨識結果：" + query + "）" : "傳了一張照片（照片辨識結果：" + query + "）") : "說：" + text}\n\n${hits.length ? `照片上抄到的品番已經對到目錄，下面 ${hits.length} 款就是客人照片上的商品，請全部列出報價（show 全部編號）\n` : ""}候選商品（依相關度排序）：\n${candText}\n\n上一次列給客人的商品：\n${lastText}`;
    // 照片沒對到品番：把候選商品的圖片一起給模型比對，找出長得一樣的那款
    const visual = img && !hits.length ? cands.slice(0, 30).filter((it) => it.th || it.img) : [];
    userContent = img
      ? [{ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }, { type: "text", text: prompt + (visual.length ? `\n\n下面是候選商品的圖片（編號對應上面的候選清單）。比對方式：①先看角色，只考慮跟照片同一個角色的商品，其他角色一律不列；②再比對這個角色商品的特徵：商品種類（娃娃／吊飾／包包…）、造型姿勢、服裝配件、顏色、材質、尺寸標示，找出跟照片一模一樣的那款，#SHOW 那些編號（同一款不同尺寸可以一起列）；③同角色但造型不一樣的不要當成同一款。都沒有一模一樣的，就說目前沒有這款，最多再列 2～3 款「同角色、同種類」的類似款並在文字裡寫清楚是類似款。` : "") },
        ...visual.flatMap((it) => [{ type: "text", text: `候選 ${cands.indexOf(it) + 1}` }, { type: "image", source: { type: "url", url: it.th || it.img } }])]
      : prompt;

    const messages = [...session.history, { role: "user", content: userContent }];
    const out = parseJson(await claude(env, RULES.replaceAll("{客人名稱}", name), messages));

    // 回答不出來、或跟前兩次回覆差不多（一直鬼打牆）→ 轉真人，機器人先不回
    const prevBot = session.history.filter((h) => h.role === "assistant").slice(-2).map((h) => h.content);
    if (!pickedNumber && prevBot.some((t) => similar(t, out.reply))) out.handoff = true;
    // 照片上的品番已經對到目錄 → 一定要跳卡片，不轉真人
    if (hits.length) { out.handoff = false; out.show = hits.map((_, i) => i + 1); if (!out.reply) out.reply = "幫您查到照片上的商品了👇"; } // 照片上的商品全部列出
    if (uid && (await inHandoff(env, uid))) return; // 回覆前再確認一次：已轉真人就不插話
    if (out.handoff && uid && (await inAutoHandoff(env, uid))) { await setHandoff(env, uid, "auto"); return; } // 已經轉給老闆了，不重複說「請專人回覆」
    if (out.handoff) {
      await reply(env, ev.replyToken, [{ type: "text", text: "這個我請專人來回覆您喔 請稍等一下～" }], uid);
      session.history.push({ role: "user", content: (earlierText ? earlierText + "\n" : "") + (img ? "（傳了照片：" + query + "）" + (msg.type === "text" ? text : "") : text) });
      session.history.push({ role: "assistant", content: "（已轉給專人）" });
      await saveSession(env, uid, session);
      await setHandoff(env, uid, "auto");
      await notifyOwner(env, uid, img ? "（傳了一張照片）" : text);
      return;
    }
    const shown = (out.show || []).map((n) => cands[n - 1]).filter((it) => it && it.img).slice(0, hits.length ? MAX_CARDS : 10);
    if (uid && env.SESSIONS && shown.length && (await inAutoHandoff(env, uid))) await env.SESSIONS.delete("h:" + uid); // 找到商品了 → 恢復正常回覆
    const lineMsgs = [];
    // 一個卡片輪播最多 12 款，超過就分成好幾組（多張照片一次問很多款）
    let cardMsg = null;
    if (uid && shown.length) for (let i = 0; i < shown.length; i += 12) {
      const cm = await productCards(env, uid, shown.slice(i, i + 12), `商品報價（${shown.length} 款${shown.length > 12 ? `・第 ${i / 12 + 1} 組` : ""}）`);
      if (cm) { lineMsgs.push(cm); cardMsg = cardMsg || cm; }
    }
    else for (const it of shown.slice(0, 3)) lineMsgs.push({ type: "image", originalContentUrl: it.img, previewImageUrl: it.img });
    const myLink = uid ? await shopLink(env, uid) : "";
    let replyText = (out.reply || "我幫您轉給專人確認喔！").replace(/(樂賣商城\s*)?\{訂購連結[:：]([^}]+)\}/g, (_, __, k) => `${myLink}&q=${encodeURIComponent(k.trim())}`).replaceAll("樂賣商城 {訂購連結}", myLink).replaceAll("{訂購連結}", myLink).replaceAll("{會員連結}", myLink + "&q=" + encodeURIComponent("會員方案"));
    if (/NT\$\s*\d/.test(replyText) && !replyText.includes(myLink)) replyText += `\n\n🛒 線上訂購：${myLink}`;
    // 有商品卡片時只傳卡片，不附文字；沒有卡片才傳文字報價
    if (!cardMsg) lineMsgs.push({ type: "text", text: replyText.slice(0, 4900) });
    if (!cardMsg && out.video && lineMsgs.length < 5) lineMsgs.push(introVideoMsg());
    if (!cardMsg && uid && /\{會員連結\}/.test(out.reply || "")) lineMsgs.push(...(await membershipCards(env, uid)));
    await reply(env, ev.replyToken, lineMsgs, uid);
    if (uid && !isOwnerUser && shown.length) await noteContact(env, uid, { items: shown.map(itemRef), topic: text.slice(0, 20) });
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
// ---------- 3 小時關懷：客人聯絡後 3 小時沒下單 → 傳一則溫暖的問候（晚上 21:00 後的留到隔天 11:00） ----------
const CARE_HOURS = 3;
const CARE_MS = CARE_HOURS * 3600e3;
// 管理員（LINE 顯示名稱）：可以自由切換自己的會員等級
const ADMIN_NAMES = ["James 森🦁"];
const SHOP_BASE_URL = "https://shiny-mud-319f.ojason90816-a70.workers.dev";
async function noteContact(env, uid, interest) {
  if (!env.SESSIONS || !uid) return;
  let c = {};
  try { c = JSON.parse((await env.SESSIONS.get("c3:" + uid)) || "{}"); } catch (e) {}
  c.at = Date.now();
  if (interest && interest.items && interest.items.length) { c.items = interest.items.slice(0, 5); c.topic = interest.topic || ""; }
  else if (interest && interest.topic) { c.topic = interest.topic; c.items = []; }
  await env.SESSIONS.put("c3:" + uid, JSON.stringify(c), { expirationTtl: 10 * 86400 });
  // 興趣標籤（群發用）：問過／逛過哪些系列，保留 180 天
  if (interest) {
    const cats = new Set();
    for (const x of interest.items || []) for (const k of catsOf({ n: x.n })) cats.add(k);
    if (interest.topic) for (const k of catsOf({ n: interest.topic })) cats.add(k);
    cats.delete("其他");
    if (cats.size) {
      let tg = {}; try { tg = JSON.parse((await env.SESSIONS.get("tg:" + uid)) || "{}"); } catch (e) {}
      for (const k of cats) tg[k] = Date.now();
      await env.SESSIONS.put("tg:" + uid, JSON.stringify(tg), { expirationTtl: 180 * 86400 });
    }
  }
}
// 依系列找客人：興趣標籤＋訂過該系列商品的客人
async function audience(env) {
  const owner = await env.SESSIONS.get("owner");
  const map = {}; // 系列 → Set(uid)
  const add = (k, uid) => { if (uid && uid !== owner && k !== "其他") (map[k] = map[k] || new Set()).add(uid); };
  let cursor;
  do {
    const r = await env.SESSIONS.list({ prefix: "tg:", cursor });
    for (const key of r.keys) {
      let tg = {}; try { tg = JSON.parse((await env.SESSIONS.get(key.name)) || "{}"); } catch (e) {}
      for (const k of Object.keys(tg)) add(k, key.name.slice(3));
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  for (const o of await allOrders(env, 200)) for (const l of o.lines || []) if (!l.mem) for (const k of catsOf({ n: l.n, b: l.b })) add(k, o.uid);
  return map;
}
// ---------- 新品自動群發：每天 20:00 把當天新上架的商品，依系列傳給問過該系列的客人 ----------
async function newArrivalPlan(env) {
  const twToday = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const last = (await env.SESSIONS.get("bc:lastAd")) || new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const cat = await loadCatalog(env);
  const fresh = cat.filter((it) => it.ad && it.ad > last && it.ad <= twToday && it.img && it.g && !/缺貨|停售/.test(it.st || ""));
  const byCat = {};
  for (const it of fresh) for (const k of catsOf(it)) if (k !== "其他") (byCat[k] = byCat[k] || []).push(it);
  const aud = await audience(env);
  const perUser = {}; // uid → [系列]
  for (const k of Object.keys(byCat)) for (const u of aud[k] || []) (perUser[u] = perUser[u] || []).push(k);
  return { today: twToday, last, fresh, byCat, perUser };
}
async function sendNewArrivals(env, plan) {
  let ok = 0;
  for (const [uid, ks] of Object.entries(plan.perUser)) {
    let name = ""; try { name = await displayName(env, uid); if (name === "老闆") name = ""; } catch (e) {}
    const top = ks.sort((a, b) => plan.byCat[b].length - plan.byCat[a].length).slice(0, 4);
    const msgs = [{ type: "text", text: `${name ? name + " " : ""}您好～您之前問過的「${top.join("、")}」有新品上架囉🎉\n幫您把最新款式整理在下面👇 喜歡的直接點「我要訂購」，數量、起批、到貨時間有任何問題都可以問我～` }];
    for (const k of top) {
      const seen = new Set(), list = [];
      for (const it of plan.byCat[k]) { if (seen.has(it.img)) continue; seen.add(it.img); list.push(it); if (list.length >= 10) break; }
      const card = await productCards(env, uid, list, `${k}新品（共 ${plan.byCat[k].length} 款）`);
      if (card) msgs.push(card);
    }
    const more = top.map((k) => ({ type: "action", action: { type: "message", label: ("看全部" + k).slice(0, 20), text: k } }));
    msgs[msgs.length - 1].quickReply = { items: more.concat([{ type: "action", action: { type: "message", label: "會員方案", text: "會員方案" } }]).slice(0, 13) };
    const r = await lineApi(env, "/v2/bot/message/push", { to: uid, messages: msgs.slice(0, 5) });
    if (r.ok) ok++; else console.log("new arrival push failed", r.status, await r.text());
  }
  await env.SESSIONS.put("bc:lastAd", plan.today);
  return ok;
}
async function runNewArrivals(env) {
  if ((await env.SESSIONS.get("bc:auto")) === "off") return;
  const tw = new Date(Date.now() + 8 * 3600e3), today = tw.toISOString().slice(0, 10);
  if (tw.getUTCHours() !== 20 || (await env.SESSIONS.get("bc:ran")) === today) return;
  await env.SESSIONS.put("bc:ran", today, { expirationTtl: 3 * 86400 });
  const plan = await newArrivalPlan(env);
  const owner = await env.SESSIONS.get("owner");
  if (!plan.fresh.length) return;
  const n = Object.keys(plan.perUser).length;
  const ok = n ? await sendNewArrivals(env, plan) : (await env.SESSIONS.put("bc:lastAd", plan.today), 0);
  if (owner) await lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `📣 今日新品群發完成\n新上架 ${plan.fresh.length} 款：${Object.entries(plan.byCat).map(([k, v]) => `${k} ${v.length}`).join("、")}\n已傳給 ${ok} 位問過這些系列的客人` }] });
}
// ---------- 詢問紀錄：記下客人最近問了什麼（保留 90 天），老闆可以查、可以手動補標籤 ----------
async function logInquiry(env, uid, line) {
  if (!env.SESSIONS || !line) return;
  if (!(await env.SESSIONS.get("nm:" + uid))) { try { await rememberName(env, uid); } catch (e) {} await env.SESSIONS.put("nm:" + uid, "1", { expirationTtl: 86400 }); }
  let q = []; try { q = JSON.parse((await env.SESSIONS.get("iq:" + uid)) || "[]"); } catch (e) {}
  q.unshift({ at: Date.now(), t: line.slice(0, 80) });
  await env.SESSIONS.put("iq:" + uid, JSON.stringify(q.slice(0, 20)), { expirationTtl: 90 * 86400 });
  // 訊息裡提到的角色／系列也記成興趣（例如「酷洛米相框還有嗎」→ 三麗鷗）
  const cats = catsOf({ n: line }).filter((k) => k !== "其他");
  if (cats.length) {
    let tg = {}; try { tg = JSON.parse((await env.SESSIONS.get("tg:" + uid)) || "{}"); } catch (e) {}
    for (const k of cats) tg[k] = Date.now();
    await env.SESSIONS.put("tg:" + uid, JSON.stringify(tg), { expirationTtl: 180 * 86400 });
  }
}
async function nameOf(env, uid) {
  try { const n = await displayName(env, uid); return n === "老闆" ? uid.slice(0, 8) : n; } catch (e) { return uid.slice(0, 8); }
}
const fmtTW = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ").replace("-", "/");
async function inquiryCommand(env, t) {
  if (/^#?(詢問紀錄|詢問名單|誰問過)$/.test(t)) {
    const rows = [];
    let cursor;
    do {
      const r = await env.SESSIONS.list({ prefix: "iq:", cursor });
      for (const k of r.keys) {
        const uid = k.name.slice(3);
        const q = JSON.parse((await env.SESSIONS.get(k.name)) || "[]");
        if (!q.length) continue;
        let tg = {}; try { tg = JSON.parse((await env.SESSIONS.get("tg:" + uid)) || "{}"); } catch (e) {}
        rows.push({ uid, at: q[0].at, last: q[0].t, n: q.length, tags: Object.keys(tg) });
      }
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
    if (!rows.length) return "還沒有詢問紀錄（今天開始記錄，客人傳訊息後就會出現）";
    rows.sort((a, b) => b.at - a.at);
    const out = [];
    for (const x of rows.slice(0, 25)) out.push(`・${await nameOf(env, x.uid)}（${fmtTW(x.at)}）「${x.last.slice(0, 20)}」${x.tags.length ? "\n　🏷 " + x.tags.join("、") : ""}`);
    return `💬 最近詢問的客人（共 ${rows.length} 位）\n${out.join("\n")}${rows.length > 25 ? `\n…還有 ${rows.length - 25} 位` : ""}\n\n看某位客人問了什麼：「小美 詢問紀錄」\n幫客人補標籤（群發用）：「小美 標記 三麗鷗,吉伊卡哇」`;
  }
  const one = t.match(/^(.+?)\s+(詢問紀錄|問了什麼)$/);
  if (one) {
    const fr = await findUid(env, one[1]); if (fr.error) return fr.error;
    const q = JSON.parse((await env.SESSIONS.get("iq:" + fr.uid)) || "[]");
    let tg = {}; try { tg = JSON.parse((await env.SESSIONS.get("tg:" + fr.uid)) || "{}"); } catch (e) {}
    return `💬 ${fr.name} 的詢問紀錄${Object.keys(tg).length ? `\n🏷 興趣：${Object.keys(tg).join("、")}` : ""}\n${q.length ? q.map((x) => `${fmtTW(x.at)}　${x.t}`).join("\n") : "（還沒有紀錄）"}`;
  }
  const tm = t.match(/^(.+?)\s+(標記|加標籤|貼標籤)\s+(.+)$/);
  if (tm) {
    const fr = await findUid(env, tm[1]); if (fr.error) return fr.error;
    const names = CAT_NAMES(), want = tm[3].split(/[,，、\s]+/).filter(Boolean);
    const bad = want.filter((k) => !names.includes(k));
    if (bad.length) return `找不到系列：${bad.join("、")}\n可以用：${names.join("、")}`;
    let tg = {}; try { tg = JSON.parse((await env.SESSIONS.get("tg:" + fr.uid)) || "{}"); } catch (e) {}
    for (const k of want) tg[k] = Date.now();
    await env.SESSIONS.put("tg:" + fr.uid, JSON.stringify(tg), { expirationTtl: 180 * 86400 });
    return `好👌 ${fr.name} 已標記：${Object.keys(tg).join("、")}\n之後這些系列有新品，會自動傳給他`;
  }
  const rm = t.match(/^(.+?)\s+(取消標記|刪標籤)\s+(.+)$/);
  if (rm) {
    const fr = await findUid(env, rm[1]); if (fr.error) return fr.error;
    let tg = {}; try { tg = JSON.parse((await env.SESSIONS.get("tg:" + fr.uid)) || "{}"); } catch (e) {}
    for (const k of rm[3].split(/[,，、\s]+/)) delete tg[k];
    await env.SESSIONS.put("tg:" + fr.uid, JSON.stringify(tg), { expirationTtl: 180 * 86400 });
    return `好👌 ${fr.name} 目前標記：${Object.keys(tg).join("、") || "（無）"}`;
  }
  return null;
}
async function broadcastCommand(env, t) {
  const nm = t.match(/^#?新品群發\s*(確認|關|關閉|開|開啟)?$/);
  if (nm) {
    if (nm[1] && /關/.test(nm[1])) { await env.SESSIONS.put("bc:auto", "off"); return "好👌 每晚 8 點的新品自動群發已關閉，要恢復傳「新品群發 開」"; }
    if (nm[1] && /開/.test(nm[1])) { await env.SESSIONS.delete("bc:auto"); return "好👌 每晚 8 點的新品自動群發已開啟"; }
    const plan = await newArrivalPlan(env);
    if (!plan.fresh.length) return `目前沒有還沒群發的新品（上次群發到 ${plan.last} 上架的商品）`;
    const n = Object.keys(plan.perUser).length;
    if (nm[1] === "確認") { const ok = await sendNewArrivals(env, plan); return `📣 已傳新品給 ${ok} 位客人`; }
    const auto = (await env.SESSIONS.get("bc:auto")) !== "off";
    return `📣 還沒群發的新品 ${plan.fresh.length} 款\n${(() => { const rows = Object.entries(plan.byCat).map(([k, v]) => [k, v.length, Object.values(plan.perUser).filter((x) => x.includes(k)).length]).sort((a, b) => b[2] - a[2] || b[1] - a[1]); const hit = rows.filter((r) => r[2]); return (hit.length ? hit.map(([k, c, u]) => `・${k} ${c} 款 → ${u} 位客人`).join("\n") : "・目前還沒有問過這些系列的客人") + (rows.length > hit.length ? `\n（另外 ${rows.length - hit.length} 個系列還沒有客人詢問過）` : ""); })()}\n\n每位客人只會收到一則（他問過的系列各附新品卡片），共 ${n} 位、用掉 ${n} 則推播額度\n${auto ? "今晚 8 點會自動傳" : "自動群發目前關閉"}，要現在馬上傳請回「新品群發 確認」`;
  }
  if (/^#?群發名單$/.test(t)) {
    const map = await audience(env);
    const rows = Object.entries(map).sort((a, b) => b[1].size - a[1].size).map(([k, v]) => `・${k}：${v.size} 位`);
    return `📣 可以群發的客人（問過、逛過或訂過該系列）\n${rows.length ? rows.join("\n") : "目前還沒有資料，客人開始詢問後就會累積"}\n\n群發方式：\n群發 吉伊卡哇\n（換行）要傳的內容\n\n多個系列用逗號：群發 吉伊卡哇,三麗鷗\n系統會自動在最後附上「點這裡看商品」連結，客人點了會看到該系列商品卡片和自己的下單按鈕`;
  }
  if (/^#?群發確認$/.test(t)) {
    const p = JSON.parse((await env.SESSIONS.get("bc:pending")) || "null");
    if (!p) return "沒有待確認的群發，請先傳「群發 系列名稱＋內容」";
    await env.SESSIONS.delete("bc:pending");
    const go = `${SHOP_BASE_URL}/go?q=${encodeURIComponent(p.cats[0])}`;
    const text = `${p.text}\n\n👉 點這裡看商品、直接下單：\n${go}`.slice(0, 4900);
    let ok = 0;
    for (let i = 0; i < p.uids.length; i += 500) {
      const r = await lineApi(env, "/v2/bot/message/multicast", { to: p.uids.slice(i, i + 500), messages: [{ type: "text", text,
        quickReply: { items: p.cats.slice(0, 3).map((k) => ({ type: "action", action: { type: "message", label: ("看" + k).slice(0, 20), text: k } })).concat([{ type: "action", action: { type: "message", label: "會員方案", text: "會員方案" } }]) } }] });
      if (r.ok) ok += Math.min(500, p.uids.length - i); else console.log("multicast failed", r.status, await r.text());
    }
    return ok ? `📣 已群發給 ${ok} 位客人（${p.cats.join("、")}）` : "群發失敗，可能是 LINE 推播額度用完了，請到官方帳號後台確認";
  }
  if (/^#?群發取消$/.test(t)) { await env.SESSIONS.delete("bc:pending"); await env.SESSIONS.delete("bc:all"); return "好👌 已取消群發"; }
  // 全體好友群發（用 LINE broadcast，所有加好友的人都會收到）
  const am=t.match(/^#?(?:群發所有人|全體群發|群發大家)\s*(?:\n([\s\S]+))?$/);
  if (am) {
    if (!am[1]) return "要傳給所有好友的內容寫在下一行，例如：\n群發所有人\n🎉 J's Planning 秋冬新品上架…";
    await env.SESSIONS.put("bc:all", am[1].trim(), { expirationTtl: 3600 });
    const go = `${SHOP_BASE_URL}/go?q=${encodeURIComponent("訂購")}`;
    return `📣 全體群發預覽（所有加好友的人都會收到，每人算 1 則推播額度）\n————\n${am[1].trim()}\n\n🛒 點這裡進入選購平台：${go}\n————\n確定請回「全體群發確認」，不要請回「群發取消」（1 小時內有效）`;
  }
  if (/^#?全體群發確認$/.test(t)) {
    const body = await env.SESSIONS.get("bc:all");
    if (!body) return "沒有待確認的全體群發，請先傳「群發所有人」＋內容";
    await env.SESSIONS.delete("bc:all");
    const go = `${SHOP_BASE_URL}/go?q=${encodeURIComponent("訂購")}`;
    const r = await lineApi(env, "/v2/bot/message/broadcast", { messages: [{ type: "text", text: `${body}\n\n🛒 點這裡進入選購平台：\n${go}`.slice(0, 4900),
      quickReply: { items: [["我要訂購", "訂購"], ["商品目錄", "商品目錄"], ["J's Planning", "J's Planning"], ["會員方案", "會員方案"]].map(([l, x]) => ({ type: "action", action: { type: "message", label: l, text: x } })) } }] });
    return r.ok ? "📣 已群發給所有好友" : `群發失敗（${r.status}），可能是推播額度不夠，請到 LINE 官方帳號後台確認`;
  }
  const m = t.match(/^#?群發\s+([^\n]+?)\s*(?:\n([\s\S]+))?$/);
  if (!m) return null;
  const names = CAT_NAMES();
  const want = m[1].split(/[,，、\s]+/).filter(Boolean);
  const bad = want.filter((k) => k !== "全部" && !names.includes(k));
  if (bad.length) return `找不到系列：${bad.join("、")}\n可以用：${names.join("、")}、全部`;
  const map = await audience(env);
  const uids = new Set();
  for (const k of want[0] === "全部" ? Object.keys(map) : want) for (const u of map[k] || []) uids.add(u);
  if (!uids.size) return `「${want.join("、")}」目前還沒有詢問過的客人可以群發`;
  if (!m[2]) return `「${want.join("、")}」共有 ${uids.size} 位客人\n\n請把要傳的內容寫在下一行，例如：\n群發 ${want.join(",")}\n吉伊卡哇新品到貨囉🎉 …`;
  const cats = want[0] === "全部" ? ["商品目錄"] : want;
  await env.SESSIONS.put("bc:pending", JSON.stringify({ cats, uids: [...uids], text: m[2].trim() }), { expirationTtl: 3600 });
  return `📣 群發預覽（${cats.join("、")}，共 ${uids.size} 位，會用掉 ${uids.size} 則推播額度）\n————\n${m[2].trim()}\n\n👉 點這裡看商品、直接下單：（系統自動附連結）\n————\n確定請回「群發確認」，不要請回「群發取消」（1 小時內有效）`;
}
const itemRef = (it) => ({ k: it.jan || it.code || "", n: it.n });
async function orderedSince(env, uid, since) {
  const ids = JSON.parse((await env.SESSIONS.get("ou:" + uid)) || "[]");
  if (!ids.length) return false;
  const o = JSON.parse((await env.SESSIONS.get("o:" + ids[0])) || "null");
  if (!o) return false;
  const t = Date.parse(o.at.replace(" ", "T") + ":00+08:00");
  return t >= since - 60000;
}
async function runCare(env) {
  const hourTW = (new Date().getUTCHours() + 8) % 24;
  if (hourTW < 11 || hourTW >= 21) return; // 只在 11:00～21:00 傳，不吵到客人
  if ((await env.SESSIONS.get("care:off")) === "1") return;
  const owner = await env.SESSIONS.get("owner");
  let cursor, sent = 0;
  do {
    const r = await env.SESSIONS.list({ prefix: "c3:", cursor });
    for (const k of r.keys) {
      const uid = k.name.slice(3);
      let c; try { c = JSON.parse((await env.SESSIONS.get(k.name)) || "null"); } catch (e) { c = null; }
      if (!c || !c.at || Date.now() - c.at < CARE_MS) continue;
      await env.SESSIONS.delete(k.name); // 每次聯絡只關懷一次
      if (uid === owner || (await env.SESSIONS.get("h:" + uid)) || (await orderedSince(env, uid, c.at))) continue;
      const msgs = await careMessages(env, uid, c);
      const pr = await lineApi(env, "/v2/bot/message/push", { to: uid, messages: msgs });
      if (!pr.ok) console.log("care failed", pr.status, await pr.text()); else sent++;
      if (sent >= 30) return; // 一次最多 30 位，下個整點再繼續
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
}
async function careMessages(env, uid, c) {
  let name = "";
  try { name = await displayName(env, uid); if (name === "老闆") name = ""; } catch (e) {}
  const hi = name ? `${name} 您好～` : "您好～";
  const link = await shopLink(env, uid);
  let items = [];
  if (c.items && c.items.length) {
    const cat = await loadCatalog(env);
    const keys = new Set(c.items.map((x) => x.k).filter(Boolean));
    items = cat.filter((it) => keys.has(it.jan || it.code || "") && it.img).slice(0, 5);
  }
  const qrItems = (list) => ({ items: list.map(([l, t]) => ({ type: "action", action: { type: "message", label: l, text: t } })) });
  if (items.length) {
    const first = items[0].n.replace(/\s+/g, " ");
    const text = `${hi}謝謝您稍早來找我們聊天☺️\n\n剛剛您問到的「${first}」${items.length > 1 ? `等 ${items.length} 款` : ""}，不知道還有沒有需要呢？\n我幫您把商品再整理一次放在下面👇 數量、起批、到貨時間有任何想問的，都可以直接跟我說，我們陪您慢慢挑，不用有壓力喔🙏\n\n決定好的話，點卡片上的「我要訂購」就能直接下單～`;
    const cards = await productCards(env, uid, items, "上次詢問的商品");
    const out = [{ type: "text", text }];
    if (cards) { cards.quickReply = qrItems([["想下單", "我要訂購"], ["再看看別的", "商品目錄"], ["問真人客服", "真人客服"]]); out.push(cards); }
    else out[0].quickReply = qrItems([["想下單", "我要訂購"], ["再看看別的", "商品目錄"]]);
    return out;
  }
  if (c.topic) {
    const kb = await keywordBrowse(env, { loadCatalog, isExpired }, uid, c.topic).catch(() => null);
    if (kb && kb.length) {
      const flex = kb[0]; delete flex.quickReply;
      flex.quickReply = qrItems([["想下單", "我要訂購"], ["看別的系列", "商品目錄"], ["問真人客服", "真人客服"]]);
      const text = `${hi}謝謝您稍早來找我們聊天☺️\n\n剛剛看您在看「${c.topic}」的商品，不知道有沒有找到喜歡的呢？\n我把這個系列再整理給您看看👇 想問數量、起批、到貨時間，或想找其他款式，都可以直接跟我說，我們陪您慢慢挑，不用有壓力喔🙏`;
      return [{ type: "text", text }, flex];
    }
  }
  const topic = c.topic ? `剛剛看到您在逛「${c.topic}」，` : "";
  const text = `${hi}謝謝您稍早來找我們聊天☺️\n\n${topic}不知道最近有沒有想找的商品？吉伊卡哇、三麗鷗、寶可夢、蠟筆小新…都有不少新貨喔！\n跟我說想要的角色或商品，我馬上幫您找、幫您報價；有預算或數量的考量也可以先聊聊，我們一起慢慢挑🙏\n\n🛒 您的專屬商城：${link}`;
  return [{ type: "text", text, quickReply: qrItems([["吉伊卡哇", "吉伊卡哇"], ["三麗鷗", "三麗鷗"], ["寶可夢", "寶可夢"], ["蠟筆小新", "蠟筆小新"], ["商品目錄", "商品目錄"], ["會員方案", "會員方案"]]) }];
}
// ---------- 會員到期提醒：到期前 3 天提醒續約、到期當天通知 ----------
async function runMemberReminders(env) {
  const hourTW = (new Date().getUTCHours() + 8) % 24;
  if (hourTW < 10 || hourTW >= 20) return;
  let cursor;
  do {
    const r = await env.SESSIONS.list({ prefix: "tx:", cursor });
    for (const k of r.keys) {
      const uid = k.name.slice(3), until = Number(await env.SESSIONS.get(k.name)) || 0;
      if (!until) continue;
      const left = until - Date.now(), done = (await env.SESSIONS.get("txr:" + uid)) || "";
      const tier = await env.SESSIONS.get("tier:" + uid);
      const nm = tier === "vip" ? "VIP 會員" : "一般會員";
      if (left > 0 && left <= 3 * 86400e3 && !done.includes("soon")) {
        await env.SESSIONS.put("txr:" + uid, done + "soon", { expirationTtl: 40 * 86400 });
        await lineApi(env, "/v2/bot/message/push", { to: uid, messages: [{ type: "text", text: `您好～提醒您，您的 ${nm} 將在 ${fmtDay(until)} 到期☺️\n想繼續享有會員價${tier === "vip" ? "和每月運費券" : "和每月運費券"}的話，點下面直接續約，會從到期日往後延長，不會浪費天數喔～` }, ...(await membershipCards(env, uid)).filter((m) => m.type === "flex")] });
      } else if (left <= 0 && !done.includes("end")) {
        await env.SESSIONS.put("txr:" + uid, done + "end", { expirationTtl: 40 * 86400 });
        await env.SESSIONS.delete("tier:" + uid);
        await lineApi(env, "/v2/bot/message/push", { to: uid, messages: [{ type: "text", text: `您好～您的會員資格已在 ${fmtDay(until)} 到期，謝謝您這段時間的支持🙏\n隨時想恢復會員價，傳「會員方案」就能直接續約喔～` }] });
        const owner = await env.SESSIONS.get("owner");
        if (owner) await lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `📅 ${await nameOf(env, uid)} 的會員已到期（${fmtDay(until)}），已自動改回非會員` }] });
      }
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
}
// 部署後要執行一次的老闆指令（執行結果會傳給老闆）
const BOOT_TASKS = [{ id: "20261015-qianqian-vip", cmd: "芊芊 VIP 2個月" }, { id: "20261015-member-list", cmd: "會員名單" },
  { id: "20261016-sanrio-push", notBefore: "2026-10-16T20:00:00+08:00", cmd: "群發 三麗鷗\n三麗鷗迷看過來💖 秋冬新品上架囉！\nHello Kitty、美樂蒂、酷洛米、大耳狗、布丁狗、帕恰狗…雨傘、襪子、環保袋、毛絨保暖小物、吊飾通通有，全部日本正版、批發價直送台灣🇯🇵\n每款都標好起批數和結單日，喜歡的直接點下面連結看商品、下單👇\n👑 VIP 會員運費全免、每件再省 NT$30" },
  { id: "20261016-sanrio-push-ok", notBefore: "2026-10-16T20:00:00+08:00", cmd: "群發確認" }];
async function runBootTasks(env) {
  const owner = await env.SESSIONS.get("owner");
  // 一次性：之前設定、沒有期限的會員，一律從今天起算 1 個月
  if (!(await env.SESSIONS.get("boot:20261015-member-expiry"))) {
    await env.SESSIONS.put("boot:20261015-member-expiry", "1");
    const fixed = [];
    let cursor;
    do {
      const r = await env.SESSIONS.list({ prefix: "tier:", cursor });
      for (const k of r.keys) {
        const uid = k.name.slice(5), tier = await env.SESSIONS.get(k.name);
        if ((tier === "vip" || tier === "member") && !(await env.SESSIONS.get("tx:" + uid))) {
          const res = await setMembership(env, uid, tier, { months: 1 }, false);
          fixed.push(`・${await nameOf(env, uid)}（${tier === "vip" ? "VIP" : "一般"}）到 ${fmtDay(res.until)}`);
        }
      }
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
    if (owner && fixed.length) await lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `📅 會員期限功能上線：之前沒有設期限的會員，已從今天起算 1 個月\n${fixed.join("\n")}\n\n有人期限不一樣的話，傳「名字 VIP 3個月」或「名字 VIP 到12/31」就能改` }] });
  }
  for (const t of BOOT_TASKS) {
    if (await env.SESSIONS.get("boot:" + t.id)) continue;
    if (t.notBefore && Date.now() < Date.parse(t.notBefore)) continue; // 不要半夜傳給客人
    await env.SESSIONS.put("boot:" + t.id, "1");
    let r; try { r = await ownerCommand(env, t.cmd); } catch (e) { r = "執行失敗：" + e.message; }
    if (owner && r) await lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `（你交代的：${t.cmd}）\n${Array.isArray(r) ? r.join("\n") : r}` }] });
  }
}
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
// ── Threads 官方 API 連接（海巡用）──
// 金鑰不經過任何人：老闆打開 /threads/login → Threads 授權 → /threads/callback 用 App 密鑰換成長效權杖，存在 KV（thr:tok）
const THREADS_APP_ID = "1130913892781479";
const THREADS_OWNER = "zoare_2504"; // 只接受這個帳號，別人授權會被拒絕
const THREADS_SCOPE = "threads_basic,threads_content_publish,threads_keyword_search,threads_manage_replies,threads_read_replies";
const thrPage = (t, b) => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t}</title><body style="font-family:system-ui;padding:32px 20px;max-width:520px;margin:auto;line-height:1.7;background:#faf8f3;color:#222"><h2>${t}</h2><p>${b}</p></body>`, { headers: { "content-type": "text/html; charset=utf-8" } });
function legalPage(path) {
  const del = path === "/data-deletion";
  const css = "body{font-family:system-ui,-apple-system,'Noto Sans TC',sans-serif;max-width:720px;margin:auto;padding:32px 20px;line-height:1.8;color:#222;background:#faf8f3}h1{font-size:24px}h2{font-size:17px;margin-top:28px}small{color:#777}";
  const zh = del ? `<h1>ZOARÉ 資料刪除說明</h1>
<p>ZOARÉ 的 Threads 功能只供 ZOARÉ 自有帳號 @zoare_2504 使用。我們不會為其他 Threads 用戶建立帳號，也不會保存他們的個人資料。</p>
<h2>我們保存哪些資料</h2><p>為了找出正在詢問商品來源的公開貼文，我們會暫時保存公開貼文的編號、內容摘要、作者帳號名稱與連結，最多保存 30 天，之後自動刪除。</p>
<h2>如何要求刪除</h2><p>任何人如果希望我們刪除與其 Threads 帳號有關的資料，請透過 ZOARÉ 的 LINE 官方帳號或 Threads 私訊 @zoare_2504 告知帳號名稱，我們會在 7 天內刪除並回覆確認。</p>
<p>@zoare_2504 帳號擁有者也可以隨時在 Threads「設定 → 帳號 → 網站權限」移除本應用程式，移除後我們會刪除授權權杖。</p>`
  : `<h1>ZOARÉ 隱私權政策</h1><small>最後更新：2026-10-29</small>
<p>ZOARÉ 是台灣的日本角色商品批發服務。本政策說明我們透過 Threads API 處理資料的方式。</p>
<h2>使用範圍</h2><p>本應用程式只由 ZOARÉ 自有 Threads 帳號 @zoare_2504 使用，用途是：搜尋公開貼文中正在詢問批發或商品來源的貼文，並由 ZOARÉ 人員確認後，以 @zoare_2504 的身分回覆該貼文。</p>
<h2>我們取得的資料</h2><ul><li>@zoare_2504 的帳號基本資料與授權權杖</li><li>關鍵字搜尋結果中的公開貼文：貼文編號、內容、作者帳號名稱、時間與連結</li><li>對 @zoare_2504 貼文的公開回覆</li></ul>
<h2>使用方式</h2><p>資料只用於讓 ZOARÉ 人員判斷是否回覆，以及追蹤回覆狀態。我們不會出售、出租或分享資料給第三方，不會用於廣告投放，也不會建立用戶檔案或自動私訊。每則回覆都由人員確認後才發出。</p>
<h2>保存期限</h2><p>公開貼文資料最多保存 30 天後自動刪除；授權權杖保存在加密的伺服器環境，帳號擁有者移除授權後即刪除。</p>
<h2>刪除資料</h2><p>請參考<a href="/data-deletion">資料刪除說明</a>。</p>
<h2>聯絡我們</h2><p>LINE 官方帳號 ZOARÉ，或 Threads @zoare_2504。</p>`;
  const en = del ? `<h1>Data Deletion Instructions</h1><p>ZOARÉ's Threads integration is used only by ZOARÉ's own account @zoare_2504. We do not create accounts for other Threads users. Public post data found via keyword search (post ID, text excerpt, username, permalink) is kept for at most 30 days and then deleted automatically. To request deletion of any data related to your Threads account, message @zoare_2504 on Threads or ZOARÉ's LINE Official Account with your username; we will delete it within 7 days and confirm. The account owner can also remove the app under Threads Settings → Account → Website permissions, after which the access token is deleted.</p>`
  : `<h1>Privacy Policy</h1><p>ZOARÉ is a Japanese character-goods wholesale service in Taiwan. This app is used only by ZOARÉ's own Threads account @zoare_2504 to search public posts asking for wholesale suppliers, and to reply to those posts as @zoare_2504 after a staff member reviews each reply. We access @zoare_2504's basic profile and access token, public posts returned by keyword search (ID, text, username, timestamp, permalink), and public replies to @zoare_2504's posts. Data is used only to decide whether to reply and to track reply status. We never sell or share data with third parties, use it for advertising, build user profiles, or send automated direct messages. Public post data is deleted after 30 days. See <a href="/data-deletion">Data Deletion Instructions</a>. Contact: @zoare_2504 on Threads.</p>`;
  return new Response(`<!doctype html><html lang="zh-Hant"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${del ? "ZOARÉ 資料刪除說明" : "ZOARÉ 隱私權政策"}</title><style>${css}</style><body>${zh}<hr style="margin:36px 0">${en}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
async function thrState(env, ts) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.THREADS_APP_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("thr" + ts)));
  return ts + "." + [...sig.slice(0, 12)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function threadsAuth(request, env, url) {
  const redirect = url.origin + "/threads/callback";
  if (url.pathname === "/threads/login") {
    if (!env.THREADS_APP_SECRET) return thrPage("還差一步", "Cloudflare 還沒設定 THREADS_APP_SECRET，設定好再開這個網址。");
    const state = await thrState(env, Date.now());
    const q = new URLSearchParams({ client_id: THREADS_APP_ID, redirect_uri: redirect, scope: THREADS_SCOPE, response_type: "code", state });
    return Response.redirect("https://threads.com/oauth/authorize?" + q, 302);
  }
  const err = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (err) return thrPage("沒有連接成功", "Threads 回覆：" + err.replace(/[<>&]/g, "") + "<br>可以回到上一頁再試一次。");
  const state = url.searchParams.get("state") || "", code = (url.searchParams.get("code") || "").replace(/#_$/, "");
  await env.SESSIONS.put("thr:last", JSON.stringify({ at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16), keys: [...url.searchParams.keys()], stateLen: state.length, codeLen: code.length }), { expirationTtl: 7 * 86400 });
  if (!code) return thrPage("沒有收到授權碼", "請重新打開「/threads/login」，在 Threads 畫面按「繼續」。");
  const ts = Number(state.split(".")[0]);
  if (!ts || Date.now() - ts > 3600e3 || state !== (await thrState(env, ts))) return thrPage("連結過期了", "請重新打開「/threads/login」再授權一次。");
  const r1 = await fetch("https://graph.threads.net/oauth/access_token", { method: "POST", body: new URLSearchParams({ client_id: THREADS_APP_ID, client_secret: env.THREADS_APP_SECRET, code, grant_type: "authorization_code", redirect_uri: redirect }) });
  const j1 = await r1.json().catch(() => ({}));
  if (!j1.access_token) return thrPage("換取權杖失敗", "錯誤：" + String((j1.error && (j1.error.message || j1.error)) || j1.error_message || r1.status).replace(/[<>&]/g, "").slice(0, 200) + "<br>請截圖這頁給 Claude。");
  const r2 = await fetch("https://graph.threads.net/access_token?" + new URLSearchParams({ grant_type: "th_exchange_token", client_secret: env.THREADS_APP_SECRET, access_token: j1.access_token }));
  const j2 = await r2.json().catch(() => ({}));
  const tok = j2.access_token || j1.access_token, ttl = j2.expires_in || 3600;
  const me = await (await fetch("https://graph.threads.net/v1.0/me?fields=id,username&access_token=" + encodeURIComponent(tok))).json().catch(() => ({}));
  if (me.username !== THREADS_OWNER) return thrPage("帳號不對", "授權的是 @" + String(me.username || "?").replace(/[<>&]/g, "") + "，只接受 @" + THREADS_OWNER + "。請在 Threads 登出後換帳號再試。");
  await env.SESSIONS.put("thr:tok", JSON.stringify({ tok, uid: me.id, user: me.username, exp: Date.now() + ttl * 1000, at: Date.now() }));
  const owner = await env.SESSIONS.get("owner");
  if (owner) await lineApi(env, "/v2/bot/message/push", { to: owner, messages: [{ type: "text", text: `✅ Threads @${me.username} 已連接（權杖約 ${Math.round(ttl / 86400)} 天，系統會自動續期）` }] }).catch(() => {});
  return thrPage("✅ 連接成功", "@" + me.username + " 已經接上 ZOARÉ 系統，可以關掉這頁回去跟 Claude 說「好了」。");
}
async function thrGet(env, path, params = {}) {
  const t = JSON.parse((await env.SESSIONS.get("thr:tok")) || "null");
  if (!t) return { error: { message: "還沒連接 Threads（打開 /threads/login）" } };
  const r = await fetch("https://graph.threads.net/v1.0/" + path + "?" + new URLSearchParams({ ...params, access_token: t.tok }));
  return r.json().catch(() => ({ error: { message: "HTTP " + r.status } }));
}
async function threadsTest(env, q) {
  const out = ["🧪 Threads 連線測試"];
  const t = JSON.parse((await env.SESSIONS.get("thr:tok")) || "null");
  if (!t) return out.concat("❌ 還沒連接，請打開 /threads/login").join("\n");
  out.push("權杖到期：" + new Date(t.exp + 8 * 3600e3).toISOString().slice(0, 10));
  const me = await thrGet(env, "me", { fields: "id,username,name" });
  out.push(me.error ? "❌ 帳號：" + me.error.message : "✅ 帳號：@" + me.username);
  const mine = await thrGet(env, "me/threads", { fields: "id,text,timestamp", limit: "3" });
  if (mine.error) out.push("❌ 讀自己貼文：" + mine.error.message);
  else { out.push("✅ 讀自己貼文：最近 " + (mine.data || []).length + " 篇"); for (const x of mine.data || []) out.push("　・" + (x.text || "（圖片）").replace(/\s+/g, " ").slice(0, 30)); }
  const ks = await thrGet(env, "keyword_search", { q, search_type: "RECENT", fields: "id,text,username,timestamp,permalink", limit: "5" });
  if (ks.error) out.push("❌ 關鍵字搜尋「" + q + "」：" + ks.error.message);
  else {
    const d = ks.data || [], others = d.filter((x) => x.username && x.username !== t.user);
    out.push("✅ 關鍵字搜尋「" + q + "」：找到 " + d.length + " 篇" + (others.length ? "（含別人 " + others.length + " 篇）" : "（審核前只會搜到自己的貼文）"));
    for (const x of d.slice(0, 3)) out.push("　・@" + (x.username || "?") + "：" + (x.text || "").replace(/\s+/g, " ").slice(0, 30));
  }
  const lr = JSON.parse((await env.SESSIONS.get("thr:lastrun")) || "null");
  out.push(lr ? `🕘 上次海巡 ${lr.at}：${lr.found} 篇，${lr.push}${lr.errs && lr.errs.length ? "；" + lr.errs.join("；") : ""}` : "🕘 還沒跑過海巡");
  if (await env.SESSIONS.get("thr:manual")) out.push("⏳ 有一次海巡排隊中（每 5 分鐘處理一次）");
  const le = await env.SESSIONS.get("lasterr"); if (le) out.push("📮 LINE 最近錯誤：" + le.slice(0, 120));
  return out.join("\n");
}
// ── 海巡：Threads 關鍵字搜尋 → AI 擬留言 → LINE 傳給老闆確認 → 按發送才用 @zoare_2504 回覆 ──
const THR_KW = ["求貨源", "找貨源", "三麗鷗 批發", "日本 批發", "批發 盤商", "想開團", "團購 廠商", "盒玩 批發", "扭蛋 批發", "吉伊卡哇 批發", "周邊 批發"];
const THR_INTENT = /求|找|徵|哪裡|哪邊|推薦|有沒有|有人|請問|貨源|盤商|廠商|批發|開團|進貨|拿貨|代理/;
const THR_SKIP = /代購.{0,6}(收單|開單|連線)|現貨販售|出清|徵才|求職/;
async function thrPost(env, path, params) {
  const t = JSON.parse((await env.SESSIONS.get("thr:tok")) || "null");
  if (!t) return { error: { message: "還沒連接 Threads" } };
  const r = await fetch("https://graph.threads.net/v1.0/" + path, { method: "POST", body: new URLSearchParams({ ...params, access_token: t.tok }) });
  return r.json().catch(() => ({ error: { message: "HTTP " + r.status } }));
}
async function thrDraft(env, post) {
  const sys = `你是台灣日本角色商品批發商 ZOARÉ 的小編，要在 Threads 上回覆一則別人的貼文。
規則：繁體中文、口語自然、像真人隨手回，不要有 AI 感、不要用「您好」開頭、不要條列、最多 2 句、60 字以內、最多 1 個表情符號。
內容：針對對方問的東西簡短回應，提到我們做日本角色商品批發（三麗鷗、吉伊卡哇、盒玩扭蛋等，小量也能批），請對方私訊或搜尋 LINE「ZOARÉ」看商品。
絕對不要：提到廠商名、進價、折數、人民幣、保證價格、貶低別人；貼文跟批發／找貨無關時，只回一個字：SKIP`;
  const out = (await claude(env, sys, [{ role: "user", content: "貼文作者 @" + post.username + "：\n" + (post.text || "").slice(0, 600) }], 200)).trim();
  return /^SKIP/i.test(out) ? "" : out.replace(/^["「]|["」]$/g, "");
}
async function threadsPatrol(env, opt = {}) {
  const t = JSON.parse((await env.SESSIONS.get("thr:tok")) || "null");
  if (!t) return "❌ Threads 還沒連接";
  let kws = THR_KW; try { const k = JSON.parse((await env.SESSIONS.get("thr:kw")) || "null"); if (k && k.length) kws = k; } catch (e) {}
  const since = Date.now() - 3 * 86400e3, found = new Map(), errs = [];
  for (const q of kws) {
    const j = await thrGet(env, "keyword_search", { q, search_type: "RECENT", fields: "id,text,username,timestamp,permalink", limit: "25" });
    if (j.error) { errs.push(q + "：" + j.error.message); continue; }
    for (const x of j.data || []) {
      if (!x.id || found.has(x.id)) continue;
      if (!opt.demo && (x.username === t.user)) continue;
      if (x.timestamp && Date.parse(x.timestamp) < since) continue;
      if (!opt.demo && (!THR_INTENT.test(x.text || "") || THR_SKIP.test(x.text || ""))) continue;
      if (!opt.demo && (await env.SESSIONS.get("thr:seen:" + x.id))) continue;
      found.set(x.id, x);
    }
  }
  const picks = [...found.values()].slice(0, opt.demo ? 3 : 10), cards = [];
  for (const x of picks) {
    await env.SESSIONS.put("thr:seen:" + x.id, "1", { expirationTtl: 30 * 86400 });
    let draft = ""; try { draft = await thrDraft(env, x); } catch (e) { draft = ""; }
    if (!draft && !opt.demo) continue;
    if (!draft) draft = "我們有在做日本角色商品批發，小量也可以～有需要可以私訊或搜尋 LINE「ZOARÉ」看看喔";
    const sid = x.id.slice(-6);
    await env.SESSIONS.put("thr:c:" + sid, JSON.stringify({ id: x.id, user: x.username, link: x.permalink, text: (x.text || "").slice(0, 300), draft }), { expirationTtl: 30 * 86400 });
    cards.push(thrCard({ ...x, draft, sid }));
  }
  const owner = await env.SESSIONS.get("owner");
  const head = `🔍 Threads 海巡（${kws.length} 個關鍵字）：找到 ${cards.length} 篇在找貨的貼文` + (cards.length ? "\n按「發送」才會留言；想改內容就傳「海巡改 代號 新的留言」" : "") + (errs.length ? "\n⚠️ " + errs.slice(0, 2).join("；") : "");
  if (opt.silentIfEmpty && !cards.length) return head;
  const msgs = [{ type: "text", text: head }];
  if (cards.length) msgs.push({ type: "flex", altText: "Threads 海巡結果 " + cards.length + " 篇", contents: { type: "carousel", contents: cards } });
  await env.SESSIONS.put("thr:inbox", JSON.stringify(msgs), { expirationTtl: 7 * 86400 });
  let push = "沒有綁定老闆";
  if (owner) {
    const pr = await lineApi(env, "/v2/bot/message/push", { to: owner, messages: msgs });
    push = pr.ok ? "已推播" : "推播失敗 " + pr.status + " " + (await pr.text()).slice(0, 120);
  }
  await env.SESSIONS.put("thr:lastrun", JSON.stringify({ at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " "), found: cards.length, errs: errs.slice(0, 2), push }), { expirationTtl: 30 * 86400 });
  return head;
}
function thrCard(x) {
  const draft = x.draft, sid = x.sid;
  return ({ type: "bubble", size: "kilo",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: "@" + (x.username || "?") + (x.timestamp ? "・" + new Date(Date.parse(x.timestamp) + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ") : ""), size: "xs", color: "#888888" },
        { type: "text", text: (x.text || "（無文字）").slice(0, 140), wrap: true, size: "sm" },
        { type: "separator", margin: "md" },
        { type: "text", text: "💬 擬好的留言", size: "xs", color: "#B08D57", margin: "md" },
        { type: "text", text: draft, wrap: true, size: "sm", weight: "bold" },
      ] },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "button", style: "primary", color: "#B08D57", height: "sm", action: { type: "message", label: "✅ 發送這則留言", text: "海巡發送 " + sid } },
        { type: "box", layout: "horizontal", spacing: "sm", contents: [
          { type: "button", style: "secondary", height: "sm", action: { type: "uri", label: "看原文", uri: x.permalink || "https://www.threads.com/" } },
          { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "跳過", text: "海巡跳過 " + sid } },
        ] },
      ] } });
}
const SC_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function thrCodeToId(code) { let n = 0n; for (const ch of code) { const v = SC_ALPHA.indexOf(ch); if (v < 0) return null; n = n * 64n + BigInt(v); } return n.toString(); }
async function threadsFromLink(env, text) {
  const m = text.match(/threads\.(?:com|net)\/@([\w.]+)\/post\/([\w-]{6,})/);
  if (!m) return undefined;
  const id = thrCodeToId(m[2].slice(0, 11)); if (!id) return "連結看不懂，請在 Threads 按「分享 → 複製連結」再貼一次";
  let postText = text.replace(/https?:\/\/\S+/g, "").trim();
  if (!postText) { const g = await thrGet(env, id, { fields: "text,username" }); if (g && g.text) postText = g.text; }
  let draft = ""; try { draft = postText ? await thrDraft(env, { username: m[1], text: postText }) : ""; } catch (e) {}
  if (!draft) draft = "我們有在做日本角色商品批發（三麗鷗、吉伊卡哇、盒玩扭蛋都有），小量也能拿～有需要可以私訊或 LINE 搜「ZOARÉ」看看";
  const sid = id.slice(-6);
  await env.SESSIONS.put("thr:c:" + sid, JSON.stringify({ id, user: m[1], link: "https://www.threads.com/@" + m[1] + "/post/" + m[2], text: postText.slice(0, 300), draft }), { expirationTtl: 30 * 86400 });
  return { msgs: [{ type: "text", text: "幫你擬好留言了👇 確認沒問題就按「發送」\n想改內容：傳「海巡改 " + sid + " 新的留言」" + (postText ? "" : "\n（讀不到原文，是用通用留言；想更貼切可以把原文一起貼給我）") },
    { type: "flex", altText: "Threads 留言草稿", contents: thrCard({ id, username: m[1], permalink: "https://www.threads.com/@" + m[1] + "/post/" + m[2], text: postText || "（原文請點「看原文」）", draft, sid }) }] };
}
async function threadsReplySend(env, sid, custom) {
  const c = JSON.parse((await env.SESSIONS.get("thr:c:" + sid)) || "null");
  if (!c) return "找不到代號 " + sid + "（可能超過 30 天了）";
  if (c.sent) return "這則已經留過言了👌";
  const text = (custom || c.draft || "").trim().slice(0, 500);
  const a = await thrPost(env, "me/threads", { media_type: "TEXT", text, reply_to_id: c.id });
  if (!a.id) return "❌ 留言失敗：" + ((a.error && a.error.message) || "未知錯誤");
  await new Promise((r) => setTimeout(r, 2500));
  const b = await thrPost(env, "me/threads_publish", { creation_id: a.id });
  if (!b.id) return "❌ 發佈失敗：" + ((b.error && b.error.message) || "未知錯誤");
  c.sent = Date.now(); c.replyId = b.id; c.final = text;
  await env.SESSIONS.put("thr:c:" + sid, JSON.stringify(c), { expirationTtl: 30 * 86400 });
  return "✅ 已用 @zoare_2504 留言給 @" + c.user + "\n「" + text + "」";
}
async function threadsOwnerCmd(env, text) {
  const t = text.trim();
  let m;
  if ((m = t.match(/^#?海巡發送\s*(\w{6})$/))) return threadsReplySend(env, m[1]);
  if ((m = t.match(/^#?海巡改\s*(\w{6})\s+([\s\S]+)$/))) return threadsReplySend(env, m[1], m[2]);
  if ((m = t.match(/^#?海巡跳過\s*(\w{6})$/))) return "好，跳過這則👌";
  if (/^#?海巡結果$/.test(t)) { const ib = JSON.parse((await env.SESSIONS.get("thr:inbox")) || "null"); return ib ? { msgs: ib } : "最近 7 天還沒有海巡結果"; }
  if ((m = t.match(/^#?海巡關鍵字\s*(.*)$/))) {
    if (m[1].trim()) { const k = m[1].split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 30); await env.SESSIONS.put("thr:kw", JSON.stringify(k)); return "好👌 海巡關鍵字改成：\n" + k.join("、"); }
    let k = THR_KW; try { k = JSON.parse((await env.SESSIONS.get("thr:kw")) || "null") || THR_KW; } catch (e) {}
    return "目前海巡關鍵字：\n" + k.join("、") + "\n\n要改就傳「海巡關鍵字 求貨源、三麗鷗批發、…」";
  }
  if (/^#?(海巡|開始海巡|海巡示範)$/.test(t)) {
    if (!(await env.SESSIONS.get("thr:tok"))) return "❌ Threads 還沒連接，請先打開 /threads/login";
    await env.SESSIONS.put("thr:manual", /示範/.test(t) ? "demo" : "1", { expirationTtl: 3600 });
    return "收到🔍 海巡開始，大約 5 分鐘後傳「海巡結果」就能看到" + (/示範/.test(t) ? "（示範模式：會包含你自己的貼文，方便錄影）" : "");
  }
  return undefined;
}
// 每天檢查一次：剩不到 10 天就自動續期（長效權杖 60 天）
async function threadsRefresh(env) {
  const t = JSON.parse((await env.SESSIONS.get("thr:tok")) || "null");
  if (!t || t.exp - Date.now() > 10 * 86400e3 || Date.now() - t.at < 86400e3) return;
  const j = await (await fetch("https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=" + encodeURIComponent(t.tok))).json().catch(() => ({}));
  if (j.access_token) await env.SESSIONS.put("thr:tok", JSON.stringify({ ...t, tok: j.access_token, exp: Date.now() + (j.expires_in || 5184000) * 1000, at: Date.now() }));
}
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFollowups(env));
    ctx.waitUntil((async () => {
      if (!env.SESSIONS) return;
      const tw = new Date(Date.now() + 8 * 3600e3), today = tw.toISOString().slice(0, 10);
      const hm = tw.getUTCHours() * 60 + tw.getUTCMinutes();
      const r = await getRates(env);
      if (Math.floor(hm / 5) % 12 === 0) { try { await memExpiry(env, { lineApi }); } catch (e) { console.log("memExpiry", e); } }
      if (Math.floor(hm / 5) % 12 === 1) { try { await runCare(env); } catch (e) { console.log("care", e); } }
      if (Math.floor(hm / 5) % 12 === 2) { try { await runNewArrivals(env); } catch (e) { console.log("newArrivals", e); } }
      if (Math.floor(hm / 5) % 12 === 3) { try { await runMemberReminders(env); } catch (e) { console.log("memberRemind", e); } }
      if (Math.floor(hm / 5) % 12 === 4) { try { await runCartReminders(env, { lineApi }); } catch (e) { console.log("cartRemind", e); } }
      if (Math.floor(hm / 5) % 12 === 5) { try { await computePools(env, { lineApi }); } catch (e) { console.log("pools", e); } }
      if (Math.floor(hm / 5) % 12 === 6) { try { await runPoolReminders(env, { lineApi, loadCatalog }); } catch (e) { console.log("poolremind", e); } }
      const man = await env.SESSIONS.get("thr:manual");
      if (man) { await env.SESSIONS.delete("thr:manual"); try { await threadsPatrol(env, { demo: man === "demo" }); } catch (e) { console.log("patrol manual", e); } }
      for (const [slot, at] of [["am", 9 * 60], ["pm", 20 * 60]]) {
        if (hm >= at && hm < at + 30 && (await env.SESSIONS.get("thr:tok")) && !(await env.SESSIONS.get("thr:ran:" + today + slot))) {
          await env.SESSIONS.put("thr:ran:" + today + slot, "1", { expirationTtl: 3 * 86400 });
          try { await threadsPatrol(env, { silentIfEmpty: true }); } catch (e) { console.log("patrol", e); }
        }
      }
      if (Math.floor(hm / 5) % 288 === 7) { try { await threadsRefresh(env); } catch (e) { console.log("thrRefresh", e); } }
      try { await runBootTasks(env); } catch (e) { console.log("boot", e); }
      try { if ((await env.SESSIONS.get("menuver")) !== RICHMENU_VER && env.LINE_CHANNEL_ACCESS_TOKEN) { const r2 = await setupRichMenu(env); console.log("richmenu", r2); if (!/^好/.test(r2)) await env.SESSIONS.put("menuver", RICHMENU_VER + "-fail"); } } catch (e) { console.log("richmenu", e); }
      if (hm >= 9 * 60 + 15 && (!r || r.date !== today)) { try { await updateRates(env, true); } catch (e) { console.log("rate update failed", e); } }
    })());
  },
  async fetch(request, env, ctx) {
    // 去掉金鑰前後不小心多貼的空白或換行
    for (const k of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "ANTHROPIC_API_KEY", "CATALOG_URL", "MODEL", "THREADS_APP_SECRET"])
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
        THREADS_APP_SECRET: env.THREADS_APP_SECRET ? { length: env.THREADS_APP_SECRET.length, looks_ok: /^[0-9a-f]{32}$/i.test(env.THREADS_APP_SECRET) } : "missing",
        THREADS_CONNECTED: env.SESSIONS ? !!(await env.SESSIONS.get("thr:tok")) : false,
        THREADS_LAST_CALLBACK: env.SESSIONS ? JSON.parse((await env.SESSIONS.get("thr:last")) || "null") : null,
      });
    }
    if (url.pathname === "/threads/login" || url.pathname === "/threads/callback") return threadsAuth(request, env, url);
    if (url.pathname === "/privacy" || url.pathname === "/data-deletion") return legalPage(url.pathname);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx, { lineApi, loadCatalog, isExpired, claude });
    // 公開推廣連結：/go?q=小丸子 → 打開 LINE 官方帳號聊天室並帶入關鍵字，客人按送出就收到商品卡片（含個人下單按鈕）
    // 介紹影片（LINE 影片訊息要 https＋正確的 content-type）
    if (url.pathname === "/m/intro.mp4" || url.pathname === "/m/intro.jpg") {
      const mp4 = url.pathname.endsWith(".mp4");
      const src = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/media/" + (mp4 ? "intro.mp4" : "intro_preview.jpg");
      const h = {}; const rg = request.headers.get("range"); if (rg) h.range = rg;
      const r = await fetch(src, { headers: h, cf: { cacheTtl: 86400, cacheEverything: true } });
      const hd = new Headers({ "content-type": mp4 ? "video/mp4" : "image/jpeg", "cache-control": "public, max-age=86400", "accept-ranges": "bytes" });
      for (const k of ["content-length", "content-range"]) { const v = r.headers.get(k); if (v) hd.set(k, v); }
      return new Response(r.body, { status: r.status, headers: hd });
    }
    if (url.pathname === "/go" || url.pathname.startsWith("/go/")) {
      let id = env.SESSIONS ? await env.SESSIONS.get("botid") : null;
      if (!id) {
        const r = await lineApi(env, "/v2/bot/info");
        if (r.ok) { id = (await r.json()).basicId; if (id && env.SESSIONS) await env.SESSIONS.put("botid", id); }
      }
      if (!id) return new Response("暫時無法開啟，請直接在 LINE 搜尋我們的官方帳號", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      const q = (url.searchParams.get("q") || decodeURIComponent(url.pathname.slice(4)) || "商品目錄").slice(0, 50);
      return Response.redirect(`https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(q)}`, 302);
    }
    if (url.pathname === "/shop" || url.pathname.startsWith("/shop/")) {
      try { return await handleShop(request, env, ctx, { loadCatalog, isExpired, displayName, lineApi, ver: CATALOG_VERSION, catStamp }); }
      catch (e) {
        const msg = String((e && e.stack) || e).slice(0, 600);
        console.log("shop error", msg);
        if (env.SESSIONS) await env.SESSIONS.put("shoperr", new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16) + " " + url.pathname + " " + msg, { expirationTtl: 30 * 86400 }).catch(() => {});
        return Response.json({ ok: false, error: "系統暫時出錯，請等 1 分鐘再試一次；一直不行請在 LINE 告訴我們🙏" }, { status: 500 });
      }
    }
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

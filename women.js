// ZOARÉ 韓系女裝官網（/women）
// 只放客人可以看的資料：款名、顏色、尺寸、材質、圖。不放廠商名、貨號、進價、人民幣。
// 價格：有 p 的款顯示台幣（羽絨新款：一般 p＝進價×1.3、VIP v＝進價×1.15，老闆 2026-11-25 定），沒 p 的私訊報價。p 只放台幣，不放進價。詢價清單用 LINE 傳到官方帳號 @475fizio。
// 新增款式：圖放 repo women/，在 ITEMS 加一筆（id 不重複，c＝new/down/fleece/top）。

const IMG = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/women/";
const LOGO = "https://raw.githubusercontent.com/Gg86384577/zoare-images/main/img/logo_dark.png";
const LINE_ID = "@475fizio";

const CATS = [
  { k: "all", t: "全部" },
  { k: "new", t: "新款羽絨" },
  { k: "down", t: "羽絨・大衣" },
  { k: "fleece", t: "羊羔毛・外套" },
  { k: "top", t: "上衣・裙褲" },
];

const ITEMS = [{"id":"D01","c":"new","g":"長版・大衣款","n":"毛領寬鬆羽絨大衣","co":"軍綠、本白","sz":"F｜衣長74 胸圍146","m":"90鴨絨 105g・環保毛領","img":"d01.jpg","p":2320,"v":2060},{"id":"D02","c":"new","g":"長版・大衣款","n":"毛領抽繩中長羽絨外套","co":"米白、軍綠","sz":"F｜衣長77 胸圍130","m":"90鴨絨 229g・填充最厚","img":"d02.jpg","p":2520,"v":2230},{"id":"D03","c":"new","g":"長版・大衣款","n":"立領寬版長羽絨外套","co":"中灰、米杏","sz":"F｜衣長86 胸圍148","m":"棉錦面料・90鴨絨 164g","img":"d03.jpg","p":2520,"v":2230},{"id":"D04","c":"new","g":"長版・大衣款","n":"毛領排扣中長羽絨外套","co":"米白、深灰","sz":"F｜衣長78 胸圍138","m":"棉萊賽爾面料・90鴨絨 150g","img":"d04.jpg","p":2770,"v":2460},{"id":"D05","c":"new","g":"長版綁帶大衣","n":"毛領綁帶長版大衣","co":"巧克力色","sz":"F｜衣長103 胸圍126","m":"中空纖維保暖棉（非羽絨）","img":"d05.jpg","p":2520,"v":2230},{"id":"D06","c":"new","g":"毛領・短版款","n":"捲毛領工裝羽絨外套","co":"藏青、卡其","sz":"F｜衣長57 胸圍134","m":"棉滌面料・90鴨絨 130g","img":"d06.jpg","p":2390,"v":2110},{"id":"D07","c":"new","g":"毛領・短版款","n":"毛領短版飛行羽絨外套","co":"軍綠、米白","sz":"F｜衣長55 胸圍124","m":"棉錦面料・90鴨絨 140g","img":"d07.jpg","p":2480,"v":2200},{"id":"D08","c":"new","g":"毛領・短版款","n":"毛領雙排扣短版羽絨外套","co":"卡其、黑","sz":"F","m":"棉錦面料・90鴨絨 154g","img":"d08.jpg","p":2710,"v":2400},{"id":"D09","c":"new","g":"毛領・短版款","n":"毛領立領短版外套","co":"藏青、軍綠","sz":"F｜衣長57 胸圍126","m":"棉錦面料・環保毛領","img":"d09.jpg","p":2260,"v":2000},{"id":"D10","c":"new","g":"毛領・短版款","n":"毛領皮革感羽絨外套","co":"黑","sz":"F｜衣長57 胸圍136","m":"皮革感面料・90鴨絨 140g","img":"d10.jpg","p":2520,"v":2230},{"id":"D11","c":"new","g":"毛領・短版款","n":"毛領連帽麵包羽絨外套","co":"藍、灰","sz":"F｜衣長52 胸圍124","m":"尼龍面料・90鴨絨 170g","img":"d11.jpg","p":2520,"v":2230},{"id":"D12","c":"new","g":"簡約・輕量款","n":"襯衫領短版羽絨外套","co":"黑、白","sz":"F｜衣長62 胸圍132","m":"90鴨絨 105g","img":"d12.jpg","p":2320,"v":2060},{"id":"D13","c":"new","g":"簡約・輕量款","n":"立領輕量短版羽絨外套","co":"黑、銀灰","sz":"F｜衣長62 胸圍120","m":"尼龍面料・90鴨絨 140g","img":"d13.jpg","p":2320,"v":2060},{"id":"D14","c":"new","g":"簡約・輕量款","n":"純棉立領短版羽絨外套","co":"藏青","sz":"F｜衣長54 胸圍128","m":"純棉面料・90鴨絨 100g","img":"d14.jpg","p":2390,"v":2110},{"id":"D15","c":"new","g":"簡約・輕量款","n":"立領輕量羽絨外套","co":"銀灰、黑","sz":"F｜衣長55 胸圍120","m":"尼龍面料・90鴨絨 140g","img":"d15.jpg","p":2520,"v":2230},{"id":"D16","c":"new","g":"簡約・輕量款","n":"連帽輕量羽絨外套","co":"淡藍、灰、黑","sz":"F","m":"尼龍面料・90鴨絨 153g","img":"d16.jpg","p":2520,"v":2230},{"id":"D17","c":"new","g":"簡約・輕量款","n":"毛領鋪棉背心","co":"卡其、深棕","sz":"F｜衣長54 胸圍120","m":"鋪棉（非羽絨）","img":"d17.jpg","p":1650,"v":1460},{"id":"W01","c":"down","n":"捲毛翻領短版羽絨","co":"米白、黑","img":"k01.jpg"},{"id":"W02","c":"down","n":"毛領羽絨夾克・附毛邊手套","co":"黑","img":"k02.jpg"},{"id":"W03","c":"down","n":"毛領收腰中長羽絨","co":"軍綠、米白","img":"k03.jpg"},{"id":"W04","c":"down","n":"連帽輕薄羽絨外套","co":"灰藍、銀灰、黑","img":"k04.jpg"},{"id":"W05","c":"down","n":"羊羔毛立領麵包羽絨","co":"咖啡","img":"k05.jpg"},{"id":"W06","c":"down","n":"捲毛領中長工裝羽絨","co":"淺灰、深灰","img":"k06.jpg"},{"id":"W07","c":"down","n":"捲毛大翻領工裝羽絨","co":"卡其、深藍","img":"k07.jpg"},{"id":"W08","c":"down","n":"立領輕薄羽絨夾克","co":"灰卡其、黑","img":"k08.jpg"},{"id":"W09","c":"down","n":"短版立領輕羽絨","co":"銀灰、深藍","img":"k09.jpg"},{"id":"W10","c":"down","n":"高立領綁帶羽絨大衣","co":"卡其","img":"k10.jpg"},{"id":"W11","c":"down","n":"立領輕羽絨背心","co":"粉、白、灰、黑","img":"k11.jpg"},{"id":"W12","c":"down","n":"燈芯絨短版羽絨夾克","co":"深藍","img":"k12.jpg"},{"id":"W13","c":"down","n":"捲毛內領排扣夾克","co":"深灰","img":"k13.jpg"},{"id":"W14","c":"down","n":"大毛領寬版羽絨","co":"咖啡、米白","img":"k14.jpg"},{"id":"W15","c":"down","n":"毛邊連帽短版羽絨","co":"寶藍、深灰","img":"k15.jpg"},{"id":"W16","c":"down","n":"毛領連帽牛角扣短版羽絨","co":"灰卡其","img":"k16.jpg"},{"id":"W17","c":"down","n":"毛領皮革短版夾克","co":"黑","img":"k17.jpg"},{"id":"W18","c":"down","n":"灰毛領皮革飛行員羽絨","co":"深咖啡","img":"k18.jpg"},{"id":"W19","c":"down","n":"大口袋立領羽絨","co":"米白","img":"k19.jpg"},{"id":"W20","c":"down","n":"灰毛翻領短版羽絨","co":"深灰","img":"k20.jpg"},{"id":"W21","c":"down","n":"毛領綁帶長版大衣","co":"深咖啡","img":"k21.jpg"},{"id":"W22","c":"down","n":"大毛領短版羽絨夾克","co":"灰、卡其、咖啡","img":"k22.jpg"},{"id":"W23","c":"fleece","n":"捲毛領飛行員夾克","co":"米白、咖啡","img":"k23.jpg"},{"id":"W24","c":"fleece","n":"毛領立領短夾克","co":"灰、深藍","img":"k24.jpg"},{"id":"W25","c":"fleece","n":"白捲毛領皮革夾克","co":"深咖啡","img":"k25.jpg"},{"id":"W26","c":"fleece","n":"毛領麂皮感飛行員夾克","co":"軍綠灰","img":"k26.jpg"},{"id":"W27","c":"fleece","n":"羊羔毛雙排扣短外套","co":"卡其、深藍、黑","img":"k27.jpg"},{"id":"W28","c":"fleece","n":"捲毛大翻領皮革夾克","co":"咖啡","img":"k28.jpg"},{"id":"W29","c":"fleece","n":"毛毛短背心","co":"深咖、奶茶","img":"k29.jpg"},{"id":"W30","c":"fleece","n":"條紋羊羔毛連帽上衣","co":"粉、灰","img":"k30.jpg"},{"id":"W31","c":"fleece","n":"碎花羊羔毛連帽外套","co":"米黃碎花、藍碎花","img":"k31.jpg"},{"id":"W32","c":"fleece","n":"格紋拼接羊羔毛背心","co":"米灰、綠","img":"k32.jpg"},{"id":"W33","c":"fleece","n":"羊羔毛口袋背心","co":"灰","img":"k33.jpg"},{"id":"W34","c":"fleece","n":"雪花圖騰雙面穿外套","co":"米白","img":"k34.jpg"},{"id":"W35","c":"fleece","n":"雪花小熊雙面穿外套","co":"米白條紋、深藍","img":"k35.jpg"},{"id":"W36","c":"top","n":"蕾絲邊羊羔毛短褲","co":"米白、咖啡、灰","img":"k36.jpg"},{"id":"W37","c":"top","n":"荷葉邊羊羔毛短褲","co":"米白、粉、咖啡、黑","img":"k37.jpg"},{"id":"W38","c":"top","n":"絲絨蕾絲細肩帶背心","co":"咖啡、深咖、黑","img":"k38.jpg"},{"id":"W39","c":"top","n":"碎花不規則下擺上衣","co":"白、米黃","img":"k39.jpg","m":"內刷毛"},{"id":"W40","c":"top","n":"蕾絲領提花V領毛衣","co":"米白、淺藍、咖啡","img":"k40.jpg"},{"id":"W41","c":"top","n":"荷葉領蕾絲袖針織上衣","co":"米白","img":"k41.jpg"},{"id":"W42","c":"top","n":"格紋拼接蓬蓬裙","co":"咖啡、黑","img":"k42.jpg"},{"id":"W43","c":"top","n":"荷葉邊印花長袖上衣","co":"象牙白、炭灰","img":"k43.jpg"},{"id":"W44","c":"top","n":"菱格絨面連帽上衣","co":"燕麥、炭灰","img":"k44.jpg"},{"id":"W45","c":"top","n":"碎花半拉鍊刷毛上衣・蕾絲下擺","co":"米白、深藍","img":"k45.jpg"},{"id":"W46","c":"top","n":"小熊印花蕾絲肩上衣","co":"黑、白","img":"k46.jpg"},{"id":"W47","c":"top","n":"豹紋縮口工裝褲","co":"咖啡豹紋、灰豹紋","img":"k47.jpg"},{"id":"W48","c":"top","n":"碎花縮口工裝褲","co":"米白碎花、深色碎花","img":"k48.jpg"},{"id":"W49","c":"top","n":"荷葉邊條紋喇叭褲","co":"咖啡、灰藍、深灰","img":"k49.jpg"}];

export function handleWomen(request) {
  const url = new URL(request.url);
  if (url.pathname === "/women/items.json") return Response.json(ITEMS, { headers: { "cache-control": "public, max-age=300" } });
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" } });
}

const PAGE = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ZOARÉ 高品質韓系女裝批發</title>
<meta name="description" content="高品質韓系女裝批發：羽絨外套、羊羔毛外套、上衣裙褲。每款 2 件起，可混色，LINE 私訊報價。">
<meta property="og:title" content="ZOARÉ 高品質韓系女裝批發">
<meta property="og:description" content="2026 冬季新款｜羽絨・羊羔毛・上衣裙褲｜每款 2 件起，LINE 私訊報價">
<meta property="og:image" content="${IMG}d02.jpg">
<meta name="theme-color" content="#F3F4F5">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Chiron+Sung+HK:wght@500;700&family=M+PLUS+Rounded+1c:wght@800&display=swap">
<style>
:root{--bg:#F3F4F5;--card:#fff;--ink:#1D1D1F;--mu:#5E6268;--line:#E2E4E7;--silver:#C9CCD0;--gold:#B8955A;--btn:#161616;
--num:"M PLUS Rounded 1c",-apple-system,"PingFang TC",sans-serif;--serif:"Instrument Serif","Chiron Sung HK","Songti TC","Noto Serif TC",serif;--sh:0 1px 4px rgba(40,44,52,.07)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 var(--serif);-webkit-font-smoothing:antialiased}
img{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-user-drag:none;pointer-events:none}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
/* 頁首 */
.top{position:sticky;top:0;z-index:20;background:rgba(243,244,245,.86);backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid transparent;transition:border-color .3s}
.top.on{border-color:var(--line)}
.bar{display:flex;align-items:center;justify-content:space-between;height:56px}
.bar img{height:20px;display:block}
.wm{display:flex;align-items:center;gap:10px}
.metal{display:block;height:22px;aspect-ratio:3076/764;-webkit-mask:url(${LOGO}) center/contain no-repeat;mask:url(${LOGO}) center/contain no-repeat;background:linear-gradient(180deg,#A3A8B0 0%,#3D4047 45%,#B9BDC4 62%,#5A5E66 100%)}
.wm small{font:400 10px/1 var(--serif);letter-spacing:.3em;color:#4A4E55}
@media(max-width:380px){.wm small{display:none}}
.bar .k{font-size:12px;letter-spacing:.18em;color:var(--mu)}
.ask{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 16px;border-radius:99px;background:var(--btn);color:#fff;font-size:14px;font-weight:700}
.ask b{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:#fff;color:var(--btn);font:800 12px/1 -apple-system,"PingFang TC",sans-serif}
/* 封面 */
.hero{position:relative;overflow:hidden;padding:48px 0 32px;background:linear-gradient(160deg,#FAFAFB 0%,#E4E6E9 46%,#F5F6F7 70%,#DADDE1 100%)}
.hero:after{content:"";position:absolute;inset:-40% -60%;background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.75) 50%,transparent 60%);animation:sheen 7s ease-in-out infinite;pointer-events:none}
@keyframes sheen{0%,25%{transform:translateX(-40%)}75%,100%{transform:translateX(40%)}}
.hero .wrap{position:relative;z-index:1;display:grid;gap:24px}
.eyebrow{font-size:12px;letter-spacing:.32em;color:var(--mu)}
.hero h1{margin:8px 0 0;font:400 clamp(44px,11vw,104px)/.95 var(--serif);letter-spacing:-.01em}
.hero h1 i{font-style:italic;color:#7A7E85}
.hero .zh{margin:12px 0 0;font-size:clamp(20px,4.6vw,30px);font-weight:700;letter-spacing:.08em}
.rule{width:56px;height:1px;background:var(--gold);margin:16px 0}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.facts li{padding:6px 12px;border-radius:99px;background:rgba(255,255,255,.7);border:1px solid var(--line);font-size:13px}
.strip{display:flex;gap:10px;overflow:hidden;mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.strip .rail{display:flex;gap:10px;animation:rail 40s linear infinite}
.strip img{width:120px;height:160px;object-fit:cover;border-radius:12px;box-shadow:var(--sh);background:#fff}
@keyframes rail{to{transform:translateX(-50%)}}
@media(min-width:860px){.hero .wrap{grid-template-columns:1.1fr 1fr;align-items:center}.strip img{width:150px;height:200px}}
/* 怎麼叫貨 */
.how{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:24px 0 8px}
.how div{background:var(--card);border-radius:12px;padding:12px;box-shadow:var(--sh)}
.how em{display:block;font:italic 400 26px/1 var(--serif);color:var(--gold)}
.how b{display:block;margin-top:6px;font-size:14px}
.how span{display:block;font-size:12px;line-height:1.5;color:var(--mu)}
/* 分類 */
.tabs{position:sticky;top:56px;z-index:15;background:rgba(243,244,245,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.tabs .wrap{display:flex;gap:8px;overflow-x:auto;padding:10px 16px;scrollbar-width:none}
.tabs .wrap::-webkit-scrollbar{display:none}
.tab{flex:none;height:36px;padding:0 16px;border-radius:99px;border:1px solid var(--line);background:#fff;font-size:14px;white-space:nowrap}
.tab[aria-selected=true]{background:var(--btn);border-color:var(--btn);color:#fff;font-weight:700}
.tab small{margin-left:4px;font:600 11px -apple-system,sans-serif;opacity:.7}
.sec{margin:24px 0 12px;display:flex;align-items:baseline;gap:10px}
.sec h2{margin:0;font-size:22px;letter-spacing:.04em}
.sec span{font-size:13px;color:var(--mu)}
/* 商品 */
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
@media(min-width:700px){.grid{grid-template-columns:repeat(3,1fr)}}
@media(min-width:980px){.grid{grid-template-columns:repeat(4,1fr)}}
.card{position:relative;padding:0;display:flex;flex-direction:column;text-align:left;background:var(--card);border-radius:12px;overflow:hidden;box-shadow:var(--sh);transition:transform .35s cubic-bezier(.2,.7,.2,1),box-shadow .35s}
.card:active{transform:scale(.97)}
@media(hover:hover){.card:hover{transform:translateY(-4px);box-shadow:0 10px 24px rgba(40,44,52,.12)}.card:hover .ph img{transform:scale(1.05)}}
.ph{position:relative;aspect-ratio:4/5;background:#F7F7F8;overflow:hidden}
.ph img{width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.2,.7,.2,1)}
.no{position:absolute;left:8px;top:8px;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.88);font:700 11px/1.6 -apple-system,"PingFang TC",sans-serif;letter-spacing:.04em}
.in{position:absolute;right:8px;top:8px;padding:2px 8px;border-radius:99px;background:var(--btn);color:#fff;font:700 11px/1.6 -apple-system,"PingFang TC",sans-serif}
.meta{padding:10px 12px 12px}
.meta h3{margin:0;font-size:15px;line-height:1.35;font-weight:700}
.meta p{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--mu)}
.meta .q{margin-top:6px;font-size:12px;color:var(--ink);letter-spacing:.04em}
.meta .pr{margin-top:6px;font:800 18px/1.2 var(--num);letter-spacing:.01em}
.meta .pr+.q{margin-top:2px;color:var(--mu)}
.meta .vip{margin-top:4px;display:flex;align-items:center;gap:6px;font-size:12px}
.tagv{display:inline-block;padding:0 8px;border-radius:99px;background:var(--btn);color:#fff;font:800 10px/1.8 -apple-system,"PingFang TC",sans-serif;letter-spacing:.06em}
.meta .vip .num{font-size:15px}
.price .pbig{display:block;font:800 26px/1.2 var(--num);margin-bottom:4px}
.num{font-family:var(--num);font-weight:800}
.reveal{opacity:0;transform:translateY(18px)}
.reveal.show{opacity:1;transform:none;transition:opacity .6s ease,transform .6s cubic-bezier(.2,.7,.2,1)}
/* 底部 */
.foot{margin:40px 0 0;padding:32px 0 120px;border-top:1px solid var(--line);text-align:center;color:var(--mu);font-size:13px}
.foot img{height:22px;margin-bottom:8px}
.foot a{color:var(--ink)}
.fab{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));z-index:30;transform:translate(-50%,140%);transition:transform .45s cubic-bezier(.2,.9,.3,1.2);display:flex;align-items:center;gap:10px;height:48px;padding:0 20px;border-radius:99px;background:var(--btn);color:#fff;font-size:15px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.22)}
.fab.on{transform:translate(-50%,0)}
.fab b{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:99px;background:#fff;color:var(--btn);font:800 12px/1 -apple-system,sans-serif}
.bump{animation:bump .4s}
@keyframes bump{40%{transform:translate(-50%,0) scale(1.08)}}
/* 面板 */
.mask{position:fixed;inset:0;z-index:40;background:rgba(20,20,22,.42);opacity:0;pointer-events:none;transition:opacity .3s}
.mask.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:41;max-height:92vh;overflow:auto;background:#fff;border-radius:18px 18px 0 0;transform:translateY(105%);transition:transform .4s cubic-bezier(.2,.8,.2,1);padding:0 0 calc(16px + env(safe-area-inset-bottom))}
.sheet.on{transform:none}
@media(min-width:760px){.sheet{left:50%;right:auto;bottom:auto;top:50%;width:720px;border-radius:18px;transform:translate(-50%,-46%) scale(.96);opacity:0;pointer-events:none;transition:transform .35s,opacity .3s}.sheet.on{transform:translate(-50%,-50%);opacity:1;pointer-events:auto}}
.grab{width:40px;height:4px;border-radius:4px;background:var(--line);margin:8px auto}
.x{position:absolute;right:8px;top:8px;width:44px;height:44px;border-radius:99px;font-size:22px;line-height:1;color:var(--mu)}
.dt{display:grid;gap:16px;padding:8px 16px 0}
@media(min-width:760px){.dt{grid-template-columns:1fr 1fr;padding:24px}.grab{display:none}}
.dt .big{aspect-ratio:4/5;border-radius:12px;overflow:hidden;background:#F7F7F8}
.dt .big img{width:100%;height:100%;object-fit:cover}
.dt h3{margin:0;font-size:22px;line-height:1.3}
.dt .sub{margin:4px 0 0;font-size:12px;color:var(--mu);letter-spacing:.06em}
.rows{margin:12px 0 0;padding:0;list-style:none;font-size:14px}
.rows li{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.rows li span{flex:none;width:44px;color:var(--mu)}
.lbl{margin:16px 0 8px;font-size:13px;color:var(--mu)}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{min-height:40px;padding:0 16px;border-radius:99px;border:1px solid var(--line);background:#fff;font-size:14px}
.chip[aria-pressed=true]{border-color:var(--btn);background:var(--btn);color:#fff;font-weight:700}
.qty{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.qty button{width:44px;height:44px;font-size:20px}
.qty output{min-width:40px;text-align:center;font:700 16px -apple-system,sans-serif}
.price{margin:16px 0 0;padding:12px;border-radius:12px;background:#F5F6F7;font-size:13px;line-height:1.6}
.price b{font-size:15px}
.go{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:48px;margin-top:16px;border-radius:99px;background:var(--btn);color:#fff;font-size:15px;font-weight:700}
.go:disabled{opacity:.4}
.ghost{display:block;width:100%;height:44px;margin-top:8px;border-radius:99px;border:1px solid var(--line);font-size:14px}
.lst{list-style:none;margin:0;padding:0 16px}
.lst li{display:flex;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.lst img{width:56px;height:70px;object-fit:cover;border-radius:8px;flex:none;background:#F7F7F8}
.lst .t{flex:1;min-width:0;font-size:14px;line-height:1.4}
.lst .t small{display:block;color:var(--mu);font-size:12px}
.lst .t .warn{color:#B4472F}
.lst .del{width:44px;height:44px;color:var(--mu);font-size:13px}
.lst .qty button{width:36px;height:36px;font-size:18px}
.lst .qty output{min-width:28px;font-size:14px}
.sh{padding:16px 16px 4px}
.sh h3{margin:0;font-size:20px}
.sh p{margin:4px 0 0;font-size:13px;color:var(--mu)}
.empty{padding:32px 16px;text-align:center;color:var(--mu)}
.toast{position:fixed;left:50%;top:72px;z-index:60;transform:translate(-50%,-20px);opacity:0;padding:8px 16px;border-radius:99px;background:var(--btn);color:#fff;font-size:14px;transition:.3s;pointer-events:none}
.toast.on{opacity:1;transform:translate(-50%,0)}
:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*,*:after{animation:none!important;transition:none!important}.reveal{opacity:1;transform:none}}
</style></head>
<body oncontextmenu="return false">
<header class="top" id="top"><div class="wrap bar"><span class="wm" role="img" aria-label="ZOARÉ 女裝"><span class="metal"></span><small>WOMENSWEAR</small></span><button class="ask" id="askTop" type="button">詢價清單 <b id="nTop">0</b></button></div></header>

<section class="hero"><div class="wrap">
  <div>
    <div class="eyebrow">2026 WINTER COLLECTION</div>
    <h1>Korean<br><i>Womenswear</i></h1>
    <p class="zh">高品質韓系女裝批發</p>
    <div class="rule"></div>
    <ul class="facts"><li>高品質面料與做工</li><li>羽絨・羊羔毛・上衣裙褲</li><li>每款 2 件起，可混色</li><li>VIP 會員另有優惠價</li></ul>
  </div>
  <div class="strip" aria-hidden="true"><div class="rail" id="rail"></div></div>
</div></section>

<div class="wrap">
  <div class="how">
    <div><em>01</em><b>挑款</b><span>點商品選顏色、件數，加進詢價清單</span></div>
    <div><em>02</em><b>LINE 傳給我們</b><span>清單一鍵帶進官方 LINE</span></div>
    <div><em>03</em><b>報價後下單</b><span>確認價格和數量再付款</span></div>
  </div>
</div>

<nav class="tabs" aria-label="分類"><div class="wrap" id="tabs" role="tablist"></div></nav>
<main class="wrap" id="main"></main>

<footer class="wrap foot">
  <span class="metal" style="height:28px;margin:0 auto 6px" role="img" aria-label="ZOARÉ"></span><div style="font-size:11px;letter-spacing:.42em;color:#4A4E55;margin-bottom:12px">KOREAN WOMENSWEAR</div>
  官方 LINE：${LINE_ID}<br>
  也有日本角色商品批發：<a href="/shop">逛批發商城</a>
</footer>

<button class="fab" id="fab" type="button">傳詢價清單給我們 <b id="nFab">0</b></button>
<div class="mask" id="mask"></div>
<section class="sheet" id="sheet" role="dialog" aria-modal="true"><div class="grab"></div><button class="x" id="x" type="button" aria-label="關閉">×</button><div id="sb"></div></section>
<div class="toast" id="toast" role="status"></div>

<script>
const IMG=${JSON.stringify(IMG)},LINE_ID=${JSON.stringify(LINE_ID)};
const CATS=${JSON.stringify(CATS)};
const ITEMS=${JSON.stringify(ITEMS)};
const SUB={new:"高品質 2026 新款，冬天主力",down:"高品質羽絨，短版、中長版都有",fleece:"高品質羊羔毛外套、背心、雙面穿",top:"高品質上衣、針織、裙褲"};
const $=s=>document.querySelector(s),esc=s=>String(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const nt=n=>"NT$"+Number(n).toLocaleString("en-US");
const byId=Object.fromEntries(ITEMS.map(x=>[x.id,x]));
const colors=x=>String(x.co||"").split(/[、／\\/]/).map(s=>s.trim()).filter(Boolean);
let cart=[];try{cart=JSON.parse(localStorage.getItem("zw_cart")||"[]").filter(l=>byId[l.id])}catch(e){}
const save=()=>{try{localStorage.setItem("zw_cart",JSON.stringify(cart))}catch(e){}};
let cat="all";try{const h=location.hash.slice(1);if(CATS.some(c=>c.k===h))cat=h}catch(e){}

// 封面滾動圖
(()=>{const pick=["d02","k03","d07","k31","d11","k14","d16","k40","d06","k46","d01","k27"];const h=pick.map(p=>'<img src="'+IMG+p+'.jpg" alt="" loading="lazy">').join("");$("#rail").innerHTML=h+h})();

function tabs(){$("#tabs").innerHTML=CATS.map(c=>{const n=c.k==="all"?ITEMS.length:ITEMS.filter(x=>x.c===c.k).length;return '<button class="tab" role="tab" data-k="'+c.k+'" aria-selected="'+(c.k===cat)+'">'+c.t+'<small>'+n+'</small></button>'}).join("")}
function card(x){const inq=cart.filter(l=>l.id===x.id).reduce((a,l)=>a+l.q,0);
return '<button class="card reveal" type="button" data-id="'+x.id+'"><div class="ph"><img src="'+IMG+x.img+'" alt="'+esc(x.n)+'" loading="lazy"><span class="no">'+x.id+'</span>'+(inq?'<span class="in">已選 '+inq+'</span>':'')+'</div><div class="meta"><h3>'+esc(x.n)+'</h3><p>'+esc(x.co)+'</p>'+(x.p?'<div class="pr">'+nt(x.p)+'</div><div class="vip"><span class="tagv">VIP</span><span class="num">'+nt(x.v)+'</span></div><div class="q">高品質｜2 件起｜運費另計</div>':'<div class="q">高品質｜2 件起｜私訊報價</div>')+'</div></button>'}
function render(){
  const groups=cat==="all"?CATS.slice(1):CATS.filter(c=>c.k===cat);
  $("#main").innerHTML=groups.map(g=>{const xs=ITEMS.filter(x=>x.c===g.k);return '<div class="sec"><h2>'+g.t+'</h2><span>'+xs.length+' 款・'+SUB[g.k]+'</span></div><div class="grid">'+xs.map(card).join("")+'</div>'}).join("");
  observe();
}
let io;function observe(){const els=document.querySelectorAll(".reveal");if(!("IntersectionObserver" in window)){els.forEach(e=>e.classList.add("show"));return}
 io&&io.disconnect();io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add("show");io.unobserve(e.target)}}),{rootMargin:"0px 0px -6% 0px"});
 els.forEach((e,i)=>{e.style.transitionDelay=(i%4)*60+"ms";io.observe(e)})}
function count(){const n=cart.length;$("#nTop").textContent=n;$("#nFab").textContent=n;const f=$("#fab");f.classList.toggle("on",n>0)}
function toast(t){const e=$("#toast");e.textContent=t;e.classList.add("on");clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove("on"),1800)}

// 面板
function open(html){$("#sb").innerHTML=html;$("#mask").classList.add("on");$("#sheet").classList.add("on");$("#sheet").scrollTop=0;document.body.style.overflow="hidden"}
function close(){$("#mask").classList.remove("on");$("#sheet").classList.remove("on");document.body.style.overflow=""}
$("#mask").onclick=close;$("#x").onclick=close;document.addEventListener("keydown",e=>{if(e.key==="Escape")close()});

let cur=null;
function detail(id){const x=byId[id],cs=colors(x);cur={id,c:cs.length===1?cs[0]:"",q:2};
 open('<div class="dt"><div class="big"><img src="'+IMG+x.img+'" alt="'+esc(x.n)+'"></div><div>'+
 '<div class="sub">高品質・No. '+x.id+'・'+esc((CATS.find(c=>c.k===x.c)||{}).t)+'</div><h3>'+esc(x.n)+'</h3>'+
 '<ul class="rows"><li><span>顏色</span>'+esc(x.co)+'</li><li><span>尺寸</span>'+esc(x.sz||"F 均碼")+'</li>'+(x.m?'<li><span>材質</span>'+esc(x.m)+'</li>':'')+'</ul>'+
 '<div class="lbl">選顏色</div><div class="chips" id="cs">'+cs.map(c=>'<button class="chip" type="button" aria-pressed="'+(c===cur.c)+'" data-c="'+esc(c)+'">'+esc(c)+'</button>').join("")+'</div>'+
 '<div class="lbl">件數（每款 2 件起，可混色）</div><div class="qty"><button type="button" data-d="-1" aria-label="少一件">−</button><output id="q">2</output><button type="button" data-d="1" aria-label="多一件">+</button></div>'+
 (x.p?'<div class="price"><span class="pbig">'+nt(x.p)+' <small style="font-size:13px">/ 件</small></span><div style="display:flex;align-items:center;gap:6px;margin:0 0 8px"><span class="tagv">VIP</span><span class="num" style="font-size:18px">'+nt(x.v)+'</span><small>/ 件</small></div>怎麼加入 VIP 請問 LINE。運費另計，加進清單後用 LINE 傳給我們確認數量和運費。</div>':'<div class="price"><b>批發價｜私訊報價</b><br>加進清單後用 LINE 傳給我們，我們會回你價格。</div>')+
 '<button class="go" id="add" type="button"'+(cur.c?'':' disabled')+'>'+(cur.c?'加進詢價清單':'先選顏色')+'</button><button class="ghost" id="later" type="button">再看看</button></div></div>');
 $("#cs").onclick=e=>{const b=e.target.closest(".chip");if(!b)return;cur.c=b.dataset.c;document.querySelectorAll("#cs .chip").forEach(c=>c.setAttribute("aria-pressed",c===b));$("#add").disabled=false;$("#add").textContent="加進詢價清單"};
 $("#sb .qty").onclick=e=>{const b=e.target.closest("button");if(!b)return;cur.q=Math.max(1,Math.min(99,cur.q+ +b.dataset.d));$("#q").textContent=cur.q};
 $("#later").onclick=close;
 $("#add").onclick=()=>{const l=cart.find(l=>l.id===cur.id&&l.c===cur.c);if(l)l.q+=cur.q;else cart.push({id:cur.id,c:cur.c,q:cur.q});save();count();render();close();toast("已加進詢價清單");const f=$("#fab");f.classList.remove("bump");void f.offsetWidth;f.classList.add("bump")};
}
function totals(){const t={};cart.forEach(l=>t[l.id]=(t[l.id]||0)+l.q);return t}
function list(){
 if(!cart.length){open('<div class="sh"><h3>詢價清單</h3></div><div class="empty">還沒有挑款，點商品就能加進來。</div><div style="padding:0 16px"><button class="ghost" id="later" type="button">去逛逛</button></div>');$("#later").onclick=close;return}
 const t=totals();
 open('<div class="sh"><h3>詢價清單</h3><p>共 '+Object.keys(t).length+' 款，每款合計 2 件起（可混色）'+(cart.some(l=>byId[l.id].p)?'<br>有標價的小計 <span class="num" style="color:var(--ink);font-size:16px">'+nt(cart.reduce((a,l)=>a+(byId[l.id].p||0)*l.q,0))+'</span>・VIP <span class="num" style="color:var(--ink);font-size:16px">'+nt(cart.reduce((a,l)=>a+(byId[l.id].v||0)*l.q,0))+'</span>（運費另計）':'')+'</p></div><ul class="lst">'+cart.map((l,i)=>{const x=byId[l.id];return '<li><img src="'+IMG+x.img+'" alt=""><div class="t">'+esc(x.n)+'<small>No. '+x.id+'・'+esc(l.c)+(x.p?'・<span class="num">'+nt(x.p*l.q)+'</span>（VIP <span class="num">'+nt(x.v*l.q)+'</span>）':'')+'</small>'+(t[l.id]<2?'<small class="warn">這款還差 '+(2-t[l.id])+' 件</small>':'')+'</div><div class="qty" data-i="'+i+'"><button type="button" data-d="-1" aria-label="少一件">−</button><output>'+l.q+'</output><button type="button" data-d="1" aria-label="多一件">+</button></div><button class="del" type="button" data-i="'+i+'">刪除</button></li>'}).join("")+'</ul><div style="padding:0 16px"><button class="go" id="send" type="button">用 LINE 傳給我們</button><button class="ghost" id="later" type="button">繼續挑款</button></div>');
 $("#later").onclick=close;
 $("#sb .lst").onclick=e=>{const d=e.target.closest(".del");if(d){cart.splice(+d.dataset.i,1)}else{const b=e.target.closest(".qty button");if(!b)return;const l=cart[+b.closest(".qty").dataset.i];l.q=Math.max(1,Math.min(99,l.q+ +b.dataset.d))}save();count();render();list()};
 $("#send").onclick=send;
}
function send(){const t=totals(),short=Object.keys(t).filter(k=>t[k]<2);
 if(short.length){toast("有 "+short.length+" 款不到 2 件，再加一件就好");return}
 const lines=cart.map((l,i)=>{const x=byId[l.id];return (i+1)+". "+l.id+" "+x.n+"｜"+l.c+" × "+l.q+(x.p?"（一般 "+nt(x.p)+"／VIP "+nt(x.v)+"）":"（請報價）")});
 const sum=cart.reduce((a,l)=>a+(byId[l.id].p||0)*l.q,0),vsum=cart.reduce((a,l)=>a+(byId[l.id].v||0)*l.q,0);
 const msg="女裝詢價（官網）\\n"+lines.join("\\n")+(sum?"\\n\\n有標價的小計：一般 "+nt(sum)+"／VIP "+nt(vsum)+"（運費另計）":"")+"\\n\\n麻煩幫我確認，謝謝！";
 location.href="https://line.me/R/oaMessage/"+encodeURIComponent(LINE_ID)+"/?"+encodeURIComponent(msg);
}
$("#askTop").onclick=list;$("#fab").onclick=list;
$("#tabs").onclick=e=>{const b=e.target.closest(".tab");if(!b)return;cat=b.dataset.k;try{history.replaceState(null,"","#"+cat)}catch(_){}tabs();render();const y=$("#tabs").getBoundingClientRect().top+scrollY-56;if(scrollY>y)scrollTo({top:y})};
$("#main").onclick=e=>{const c=e.target.closest(".card");if(c)detail(c.dataset.id)};
addEventListener("scroll",()=>$("#top").classList.toggle("on",scrollY>8),{passive:true});
tabs();render();count();
</script></body></html>`;

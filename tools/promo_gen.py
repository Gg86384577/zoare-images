#!/usr/bin/env python3
"""ZOARÉ 宣傳圖產生器：每天早上維護時執行，做出當天會用到的宣傳圖，放進 promo/ 並更新 promo/bank.json。
LINE 機器人（worker.js）在新品上架、結單倒數、每週二／五定期宣傳時，會從 bank.json 找對應的圖、配上 Claude 寫的文案發出。

用法：python3 tools/promo_gen.py daily            # 做今天需要的圖
      python3 tools/promo_gen.py series 三麗鷗     # 只做某個系列
"""
import json, os, re, sys, glob, random, hashlib, datetime, subprocess
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'promo')
WORK = os.environ.get('PROMO_WORK', '/tmp/promo_work')
os.makedirs(OUT, exist_ok=True); os.makedirs(WORK + '/cut', exist_ok=True)
SERIES = ["三麗鷗", "吉伊卡哇", "史努比", "寶可夢", "盒玩", "角落生物", "mofusand", "拉拉熊", "哆啦A夢", "動漫"]
TW = datetime.timezone(datetime.timedelta(hours=8))

# ---------- 字型 ----------
def font(*cands):
    for c in cands:
        for p in glob.glob(c):
            if os.path.exists(p): return p
    return ''
SP = '/tmp/claude-0/*/scratchpad/fonts'
F = {
    'tc': font(SP + '/gf/ofl/notosanstc/*.ttf', '/usr/share/fonts/**/NotoSansCJK*.tt*'),
    'round': font(SP + '/gensen/otf/TW/GenSenRounded2TW-B.otf', SP + '/gensen/otf/TW/GenSenRounded2TW-M.otf'),
    'disp': font('/mnt/skills/examples/canvas-design/canvas-fonts/Boldonse-Regular.ttf'),
    'serif': font('/mnt/skills/examples/canvas-design/canvas-fonts/Gloock-Regular.ttf'),
    'ital': font('/mnt/skills/examples/canvas-design/canvas-fonts/InstrumentSerif-Italic.ttf'),
    'hand': font('/mnt/skills/examples/canvas-design/canvas-fonts/NothingYouCouldDo-Regular.ttf'),
}
def ff():
    return ''.join(f'@font-face{{font-family:{k};src:url("file://{v}")}}' for k, v in F.items() if v)

# ---------- 目錄與商品 ----------
CAT = json.load(open(os.path.join(REPO, 'catalog.json')))
def local(x):
    m = re.search(r'/main/(img/[^?]+)', x.get('img', '') or '')
    p = os.path.join(REPO, m.group(1)) if m else ''
    return p if p and os.path.exists(p) else ''
def dl_end(x):
    m = re.search(r'(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?', x.get('dl', '') or '')
    if not m: return None
    return datetime.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4] or 23), int(m[5] or 59), tzinfo=TW)
NOW = datetime.datetime.now(TW)
LIVE = [x for x in CAT if not (dl_end(x) and dl_end(x) < NOW)]
def pick(L, n=6):  # 跟 worker.js 的 promoPick 同一套挑法（照目錄順序、同款式只挑一個）
    seen, out = set(), []
    for x in L:
        if not (x.get('img') and x.get('g')): continue
        k = (x.get('s') or x['n'])[:8]
        if k in seen: continue
        seen.add(k); out.append(x)
        if len(out) >= n: break
    return out
def series_items(kw):
    hay = lambda x: (x['n'] + ' ' + (x.get('s') or '') + ((' ' + x.get('b', '')) if kw not in ('吉伊卡哇', 'mofusand') else '')).lower()
    L = [x for x in LIVE if kw.lower() in hay(x) or (kw == '盒玩' and re.search('食玩|扭蛋', x.get('b', '')))]
    L.sort(key=lambda x: x.get('ad', ''), reverse=True)
    return L

# ---------- 去背 ----------
def cutout(p):
    key = hashlib.md5(p.encode()).hexdigest()[:12]
    out = f'{WORK}/cut/{key}.png'
    meta = out + '.json'
    if os.path.exists(meta): return json.load(open(meta))
    im = Image.open(p).convert('RGB'); im.thumbnail((700, 700)); a = np.asarray(im).astype(int)
    white = a.min(2) >= 246
    edge = np.concatenate([white[0], white[-1], white[:, 0], white[:, -1]]).mean()
    res = {'path': p, 'cut': False}
    if edge > 0.82:  # 白底商品照才去背，盒裝圖、情境照用相框
        lab, n = ndimage.label(white)
        border = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1]); border.discard(0)
        fg = ndimage.binary_opening(~np.isin(lab, list(border)), iterations=2)
        lab2, n2 = ndimage.label(fg)
        if n2:
            sizes = ndimage.sum(fg, lab2, range(1, n2 + 1)); keep = np.zeros_like(fg)
            big = [s for s in sizes if s > 0.05 * sizes.max()]
            if len(big) > 4 or sizes.max() < 0.45 * fg.sum():  # 一張圖裡很多小商品＝型錄頁，不去背
                json.dump(res | {'sheet': True}, open(meta, 'w')); return res | {'sheet': True}
            for i, s in enumerate(sizes, 1):
                if s > 0.25 * sizes.max(): keep |= lab2 == i
            keep = ndimage.binary_fill_holes(keep)
            if 0.08 < keep.mean() < 0.92:
                al = Image.fromarray((keep * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(1))
                rgba = im.convert('RGBA'); rgba.putalpha(al); rgba = rgba.crop(al.getbbox()); rgba.save(out)
                res = {'path': out, 'cut': True}
    json.dump(res, open(meta, 'w')); return res
PREF = re.compile('絨毛|娃娃|玩偶|公仔|吊飾|抱枕|盒玩|figure|ぬいぐるみ')
def choose(L, n=6, seed=''):
    """從一組商品挑出最上相的 n 款：白底能去背的優先、絨毛公仔優先、同款式不重複"""
    C = [x for x in L if local(x)]
    if seed: random.Random(seed).shuffle(C)
    C = C[:60]
    scored = []
    for x in C:
        c = cutout(local(x)); sz = os.path.getsize(local(x))
        scored.append(((2 if c['cut'] else 0) - (3 if c.get('sheet') else 0) + (1 if PREF.search(x['n']) else 0) + min(sz / 400000, 1), x))
    scored.sort(key=lambda t: -t[0])
    seen, out = set(), []
    for _, x in scored:
        k = (x.get('s') or x['n'])[:8]
        if k in seen: continue
        seen.add(k); out.append(x)
        if len(out) >= n: break
    return prep(out)
def prep(items):
    out = []
    for x in items:
        p = local(x)
        if p: out.append({**cutout(p), 'n': x['n'], 'g': x['g'], 'k': x.get('k', '')})
    return out

# ---------- 版型 ----------
PAL = {  # 背景、深色、強調、淡色
    '三麗鷗': ('#FBE7EA', '#5B2B36', '#D9758A', '#FFF6F7'), '吉伊卡哇': ('#E6F1FA', '#24425E', '#6FA5CF', '#FBFDFF'),
    '史努比': ('#F4EFE4', '#232323', '#C8432F', '#FFFDF8'), '寶可夢': ('#FFF3C9', '#2A2A55', '#E2533B', '#FFFBEA'),
    '盒玩': ('#FBEADF', '#4A2C22', '#D98A5F', '#FFF8F3'), '角落生物': ('#F2EEDF', '#3F3A2C', '#A7A06A', '#FFFDF5'),
    'mofusand': ('#F7EDE2', '#3B2F28', '#E3A15C', '#FFFAF5'), '拉拉熊': ('#F5EADB', '#3D2B1F', '#B9824F', '#FFFAF3'),
    '哆啦A夢': ('#E3F1FB', '#14365C', '#2F8FD8', '#F8FCFF'), '動漫': ('#ECE8F6', '#2A2442', '#8C7BC9', '#FBFAFF'),
}
DEF = ('#F4EEE4', '#2A2826', '#B8955A', '#FFFDF9')
ROT = [-8, 6, -3, 9, -6, 4]
STAR = '<svg viewBox="0 0 20 20" class="st" style="{s}"><path d="M10 0C10.8 6.5 13.5 9.2 20 10C13.5 10.8 10.8 13.5 10 20C9.2 13.5 6.5 10.8 0 10C6.5 9.2 9.2 6.5 10 0Z" fill="{c}"/></svg>'
def stars(c, spots):
    return ''.join(STAR.format(s=f'left:{x}px;top:{y}px;width:{w}px;height:{w}px', c=c) for x, y, w in spots)
def short(n):
    """標籤上的品名：第一行商品類型、第二行款式（角色）"""
    n = re.sub(r'^(三麗鷗|吉伊卡哇|史努比|寶可夢|角落生物|拉拉熊|哆啦A夢|mofusand|Hello Kitty|SANRIO|サンリオ)\s*', '', n, flags=re.I)
    m = re.search(r'[（(]([^）)]+)[）)]\s*$', n)
    if m: base, var = n[:m.start()].strip(), m.group(1)
    else:
        parts = n.split()
        base, var = (' '.join(parts[:-1]), parts[-1]) if len(parts) > 1 and len(parts[-1]) <= 10 else (n, '')
    cut = lambda t, k: (t[:k] + '…') if len(t) > k else t
    return cut(base, 10), cut(var, 9)
def prod_html(P, boxes, ac):
    h = ''
    for i, (p, (x, y, w)) in enumerate(zip(P, boxes)):
        r = ROT[i % len(ROT)]
        if p['cut']:
            h += f'<img class="cut" src="file://{p["path"]}" style="left:{x}px;top:{y}px;width:{w}px;height:{w}px;transform:rotate({r}deg)">'
        else:
            h += f'<div class="pol" style="left:{x}px;top:{y}px;width:{w}px;transform:rotate({r}deg)"><div class="pi" style="background-image:url(\'file://{p["path"]}\')"></div><i class="tape" style="background:{ac}66"></i></div>'
        tx = min(max(x + w * 0.42, 12), 1080 - 200); ty = min(y + w * (0.80 if p['cut'] else 0.98), 1080 - 96 - 122)
        h += f'<div class="tag" style="left:{tx:.0f}px;top:{ty:.0f}px;transform:rotate({-r / 2:.0f}deg)"><span>{short(p["n"])[0]}</span>{('<em>' + short(p["n"])[1] + '</em>') if short(p["n"])[1] else ''}<b>NT${p["g"]}</b></div>'
    return h
BASE = '''*{margin:0;padding:0;box-sizing:border-box}body{width:1080px;height:1080px;overflow:hidden;position:relative;font-family:tc,round,sans-serif}
.st{position:absolute;z-index:8}.cut{position:absolute;object-fit:contain;filter:drop-shadow(0 18px 18px rgba(60,40,30,.22));z-index:4}
.pol{position:absolute;background:#fff;padding:14px 14px 46px;box-shadow:0 18px 30px rgba(60,40,30,.22);z-index:4}.pi{width:100%;aspect-ratio:1;background-size:cover;background-position:50% 30%}
.tape{position:absolute;left:50%;top:-16px;width:110px;height:34px;margin-left:-55px;transform:rotate(-4deg)}
.wm{position:absolute;font-family:serif,ital;letter-spacing:6px;z-index:9}
.tag{position:absolute;z-index:7;background:#fff;border-radius:14px;padding:6px 14px 7px;box-shadow:0 6px 14px rgba(40,30,20,.18);display:flex;flex-direction:column;align-items:flex-start;max-width:260px}
.tag span{font-family:tc,sans-serif;font-size:18px;color:#7a7168;line-height:1.25;white-space:nowrap}.tag em{font-style:normal;font-family:tc,sans-serif;font-size:21px;font-weight:700;color:#2A2826;line-height:1.25;white-space:nowrap}.tag b{font-family:serif,tc;font-size:30px;color:#2A2826;line-height:1.1}'''

def render(html, out):
    hp = WORK + '/p.html'; open(hp, 'w').write(html)
    js = WORK + '/shot.js'
    open(js, 'w').write("""const {chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1080,height:1080}});await p.goto('file://'+process.argv[2]);await p.waitForTimeout(700);await p.screenshot({path:process.argv[3],type:'jpeg',quality:86});await b.close()})();""")
    subprocess.run(['node', js, hp, out], check=True, cwd='/home/claude', env={**os.environ, 'NODE_PATH': subprocess.run(['npm', 'root', '-g'], capture_output=True, text=True).stdout.strip()})

def tpl_series(kw, P, price, count):
    bg, dk, ac, lt = PAL.get(kw, DEF)
    en = {'三麗鷗': 'SANRIO', '吉伊卡哇': 'CHIIKAWA', '史努比': 'SNOOPY', '寶可夢': 'POKÉMON', '盒玩': 'MINIATURE', '角落生物': 'SUMIKKO', 'mofusand': 'MOFUSAND', '拉拉熊': 'RILAKKUMA', '哆啦A夢': 'DORAEMON', '動漫': 'ANIME'}.get(kw, 'ZOARÉ')
    boxes = [(320, 300, 420), (50, 400, 280), (730, 390, 290), (110, 650, 210), (730, 650, 210), (450, 690, 180)]
    return f'''<html><head><meta charset="utf-8"><style>{ff()}{BASE}
body{{background:radial-gradient(circle at 70% 30%,{lt} 0,{bg} 55%,{bg} 100%)}}
.blob{{position:absolute;border-radius:50%;filter:blur(2px)}}
.big{{position:absolute;left:-20px;top:262px;font-family:disp,sans-serif;font-size:150px;line-height:1;color:transparent;-webkit-text-stroke:2.5px {ac};opacity:.35;letter-spacing:-2px;white-space:nowrap}}
.t1{{position:absolute;left:64px;top:62px;font-family:round,tc;font-size:96px;color:{dk};letter-spacing:4px;z-index:9}}
.t2{{position:absolute;left:70px;top:178px;font-family:ital,serif;font-size:40px;color:{ac};z-index:9}}
.wm{{right:62px;top:70px;font-size:34px;color:{dk}}}
.badge{{position:absolute;right:58px;top:150px;width:220px;height:220px;border-radius:50%;background:{dk};color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;transform:rotate(10deg);z-index:9;box-shadow:0 14px 26px rgba(0,0,0,.18)}}
.badge small{{font-size:24px;letter-spacing:3px;color:{lt}}}.badge b{{font-family:serif;font-size:62px;line-height:1.05}}.badge i{{font-style:normal;font-size:24px}}
.foot{{position:absolute;left:0;right:0;bottom:0;height:96px;background:{dk};color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 60px;font-size:30px;letter-spacing:3px;z-index:10}}
.foot b{{font-family:round,tc;color:{lt}}}
</style></head><body>
<div class="blob" style="left:520px;top:300px;width:520px;height:520px;background:{lt};opacity:.8"></div>
<div class="blob" style="left:-120px;top:620px;width:420px;height:420px;background:{ac};opacity:.18"></div>
<div class="big">{en} {en}</div>
<div class="t1">{kw}</div><div class="t2">curated by ZOARÉ</div><div class="wm">ZOARÉ</div>
<div class="badge"><small>批發價</small><b>${price}</b><i>起</i></div>
{prod_html(P, boxes, ac)}
{stars(ac, [(300, 80, 34), (960, 420, 26), (60, 330, 22), (560, 640, 18)])}
<div class="foot"><span>共 <b>{count:,}</b> 款・小量也能批</span><span>LINE 搜尋 <b>ZOARÉ</b></span></div>
</body></html>'''

def tpl_new(brand_show, P, price, count, date):
    dk, ac, lt = '#2A2826', '#B8955A', '#FFFDF9'
    boxes = [(80, 380, 310), (410, 360, 320), (740, 390, 280), (160, 680, 240), (470, 690, 240), (760, 690, 220)]
    return f'''<html><head><meta charset="utf-8"><style>{ff()}{BASE}
body{{background:#F7F2EA}}
.grid{{position:absolute;inset:0;background-image:linear-gradient(#0000000a 1px,transparent 1px),linear-gradient(90deg,#0000000a 1px,transparent 1px);background-size:54px 54px}}
.new{{position:absolute;left:52px;top:34px;font-family:ital,serif;font-size:170px;line-height:.82;color:{dk};letter-spacing:-4px}}
.new em{{font-style:normal;color:{ac}}}
.stamp{{position:absolute;right:70px;top:70px;width:230px;height:230px;border-radius:50%;border:5px dashed {ac};color:{dk};display:flex;flex-direction:column;align-items:center;justify-content:center;transform:rotate(-12deg);font-family:round,tc;z-index:9;background:#fff8}}
.stamp b{{font-size:44px;letter-spacing:2px;white-space:nowrap}}.stamp small{{font-size:22px;letter-spacing:2px;color:{ac}}}
.sub{{position:absolute;left:62px;top:290px;font-family:round,tc;font-size:40px;color:{dk};letter-spacing:3px;z-index:9}}
.sub span{{background:{dk};color:#F3E6CC;padding:4px 16px;border-radius:999px;margin-left:12px;font-size:30px}}
.wm{{left:64px;bottom:118px;font-size:30px;color:{dk}}}
.price{{position:absolute;right:56px;bottom:112px;background:{ac};color:#fff;font-family:round,tc;font-size:40px;padding:12px 30px;border-radius:999px;transform:rotate(-3deg);z-index:9;box-shadow:0 10px 20px rgba(0,0,0,.15)}}
.foot{{position:absolute;left:0;right:0;bottom:0;height:90px;background:{dk};color:#EFE6D6;display:flex;align-items:center;justify-content:center;font-size:30px;letter-spacing:4px;z-index:10}}
</style></head><body><div class="grid"></div>
<div class="new">New<em>!</em><br><span style="font-size:124px">arrivals</span></div>
<div class="stamp"><small>{date[5:].replace('-', '/')}</small><b>新品上市</b><small>{count} 款上架</small></div>
<div class="sub">{brand_show}<span>日本正版</span></div>
{prod_html(P, boxes, ac)}
{stars(ac, [(640, 230, 30), (980, 560, 22), (60, 600, 20)])}
<div class="wm">ZOARÉ</div><div class="price">批發價 NT${price} 起</div>
<div class="foot">LINE 搜尋 ZOARÉ・現在就能下單</div></body></html>'''

def tpl_count(stage, P, price, dl):
    big, unit, label = {'3d': ('3', 'DAYS', '結單倒數'), '1d': ('1', 'DAY', '明天結單'), '1h': ('60', 'MIN', '最後 1 小時')}[stage]
    dk, gold = '#1F1D1B', '#D8BE8C'
    hot = '#E35D4F' if stage == '1h' else gold
    boxes = [(470, 560, 250), (720, 520, 260), (230, 600, 230), (40, 640, 200)]
    return f'''<html><head><meta charset="utf-8"><style>{ff()}{BASE}
body{{background:radial-gradient(circle at 75% 20%,#3A3631 0,{dk} 60%)}}
.stripe{{position:absolute;left:-40px;right:-40px;top:470px;height:56px;background:repeating-linear-gradient(-45deg,{hot} 0 28px,{dk} 28px 56px);transform:rotate(-4deg);opacity:.9}}
.num{{position:absolute;left:56px;top:120px;font-family:disp,sans-serif;font-size:300px;line-height:1;color:{hot};letter-spacing:-8px}}
.unit{{position:absolute;left:{90 + 235 * len(big)}px;top:96px;font-family:disp,sans-serif;font-size:70px;color:#F3EBDD}}
.lab{{position:absolute;left:{94 + 235 * len(big)}px;top:200px;font-family:round,tc;font-size:62px;color:#fff;letter-spacing:6px}}
.dl{{position:absolute;left:{98 + 235 * len(big)}px;top:292px;font-size:30px;color:{gold};letter-spacing:2px}}
.wm{{right:60px;top:56px;font-size:30px;color:{gold}}}
.price{{position:absolute;left:{98 + 235 * len(big)}px;top:350px;font-family:round,tc;font-size:38px;color:{dk};background:{gold};padding:8px 26px;border-radius:999px;z-index:9}}
.foot{{position:absolute;left:0;right:0;bottom:0;height:92px;background:{gold};color:{dk};display:flex;align-items:center;justify-content:center;font-family:round,tc;font-size:32px;letter-spacing:4px;z-index:10}}
.glow{{position:absolute;left:300px;top:640px;width:760px;height:260px;border-radius:50%;background:radial-gradient({gold}55,transparent 70%)}}
</style></head><body>
<div class="num">{big}</div><div class="unit">{unit}</div><div class="lab">{label}</div><div class="dl">結單 {dl.replace('-', '/')}</div>
<div class="wm">ZOARÉ</div><div class="price">批發價 NT${price} 起</div>
<div class="stripe"></div><div class="glow"></div>
{prod_html(P, boxes, gold)}
{stars(gold, [(980, 440, 26), (420, 60, 20), (60, 560, 18)])}
<div class="foot">還沒下單的快到 LINE 搜尋 ZOARÉ</div></body></html>'''

# ---------- 產生 ----------
BANK_P = os.path.join(OUT, 'bank.json')
BANK = json.load(open(BANK_P)) if os.path.exists(BANK_P) else {}
IMGOF = lambda v: v['img'] if isinstance(v, dict) else v
def save(key, html, P=None):
    name = 'p_' + hashlib.md5((key + NOW.strftime('%Y%m%d')).encode()).hexdigest()[:10] + '.jpg'
    render(html, os.path.join(OUT, name))
    old = IMGOF(BANK[key]) if key in BANK else None
    BANK[key] = {'img': 'promo/' + name, 'items': [{'n': p['n'], 'g': p['g'], 'k': p.get('k', '')} for p in (P or [])]}
    if old and old != BANK[key]['img'] and old not in [IMGOF(v) for v in BANK.values()] and os.path.exists(os.path.join(REPO, old)): os.remove(os.path.join(REPO, old))
    print('made', key, '->', name)

def make_series(kw, key=None):
    L = series_items(kw)
    if not L: print('no items', kw); return
    P = choose(L[:400], 6, NOW.strftime('%Y%m%d') + kw)
    if not P: return
    save(key or 'series:' + kw, tpl_series(kw, P, min(x['g'] for x in L), len(L)), P)

def rot_series(d):
    wk = (datetime.date(d.year, d.month, d.day) - datetime.date(2026, 1, 5)).days // 7
    return SERIES[(wk * 2 + (1 if d.weekday() == 4 else 0)) % len(SERIES)]

def daily():
    today = NOW.strftime('%Y-%m-%d')
    # 1) 今天是週二／五 → 定期宣傳圖（跟 worker 同一個輪替）
    if NOW.weekday() in (1, 4): make_series(rot_series(NOW), 'reg:' + today)
    # 2) 新品：今天上架的，依品牌（數量多的前 3 個）
    fresh = {}
    for x in LIVE:
        if x.get('ad') == today: fresh.setdefault(x.get('b') or '新品', []).append(x)
    for b, L in sorted(fresh.items(), key=lambda kv: -len(kv[1]))[:3]:
        P = choose(L, 6)
        if P: save(f'new:{today}:{b}', P=P, html=tpl_new(re.sub(r'^(309|Kamio|CRUX|Nakajima|T\'s Factory|J\'s Planning|A Planning|OST|森本|Marimo Craft|RE-MENT|萬代南夢宮|萬代|Bushiroad|F-toys|GPS|Ensky|Sun Arrow)\s*', '', b) or '新品', P, min(x['g'] for x in L), len(L), today))
    # 3) 結單倒數：4 天內結單的每一組，3 天／1 天／1 小時三張都先做好
    groups = {}
    for x in LIVE:
        e = dl_end(x)
        if e and NOW < e <= NOW + datetime.timedelta(days=4): groups.setdefault((x.get('b') or '') + '|' + x['dl'], []).append(x)
    for g, L in groups.items():
        P = choose(L, 4)
        if not P: continue
        for st in ('3d', '1d', '1h'):
            k = f'dl:{g}:{st}'
            if k not in BANK: save(k, tpl_count(st, P, min(x['g'] for x in L), L[0]['dl']), P)
    # 4) 系列圖庫：每天輪流更新 2 個，給「做宣傳 系列」用
    i = NOW.toordinal() * 2
    for kw in (SERIES[i % len(SERIES)], SERIES[(i + 1) % len(SERIES)]): make_series(kw)
    for kw in SERIES:
        if 'series:' + kw not in BANK: make_series(kw)
    # 清掉 10 天前的新品／定期／已結單的圖
    cut = (NOW - datetime.timedelta(days=10)).strftime('%Y-%m-%d')
    for k in list(BANK):
        m = re.match(r'^(?:new|reg):(\d{4}-\d{2}-\d{2})', k)
        dm = re.match(r'^dl:.*\|(\d{4}-\d{1,2}-\d{1,2})', k)
        if (m and m.group(1) < cut) or (dm and dm.group(1) < NOW.strftime('%Y-%m-%d')):
            p = os.path.join(REPO, IMGOF(BANK.pop(k)))
            if p not in [os.path.join(REPO, IMGOF(v)) for v in BANK.values()] and os.path.exists(p): os.remove(p)

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'daily'
    if cmd == 'series': make_series(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == 'count':  # 測試用：python3 tools/promo_gen.py count 1d 吉伊卡哇
        L = series_items(sys.argv[3]); P = choose(L[:400], 4, 'x'); save('test:' + sys.argv[2], P=P, html=tpl_count(sys.argv[2], P, min(x['g'] for x in L), '2026-11-05 23:59'))
    elif cmd == 'new':
        L = series_items(sys.argv[2]); P = choose(L[:400], 6, 'y'); save('test:new', P=P, html=tpl_new(sys.argv[2], P, min(x['g'] for x in L), len(L), NOW.strftime('%Y-%m-%d')))
    else: daily()
    json.dump(BANK, open(BANK_P, 'w'), ensure_ascii=False, indent=0)

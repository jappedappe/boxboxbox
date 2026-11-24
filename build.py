#!/usr/bin/env python3
"""Inline src/ + vendor/ into index.html."""
from pathlib import Path
R=Path(__file__).parent
t=(R/'src/template.html').read_text()
for k,p in [('CSS','src/style.css'),('QRCODE','vendor/qrcode.js'),('JSQR','vendor/jsQR.js'),('APP','src/app.js')]:
    t=t.replace('{{'+k+'}}',(R/p).read_text(),1)
(R/'index.html').write_text(t)
print('built index.html',len(t))

# ---- styleguide sample wording: taken from the app's own strings ----
# Keys the app doesn't have yet fall back to the prototype labels in src/prototype-labels.json.
import json as _json
def _app_strings(path):
    import re as _re
    t=(R/path).read_text(encoding='utf-8')
    def body(open_idx):
        depth=0
        for k in range(open_idx, len(t)):
            c=t[k]
            if c=='{': depth+=1
            elif c=='}':
                depth-=1
                if depth==0: return t[open_idx+1:k]
    pair=_re.compile(r"(?<![\w.])([A-Za-z_]\w*)\s*:\s*'((?:[^'\\\n]|\\.)*)'")
    out={l:{} for l in ['en','sv','da','fi','nb']}
    def add(lang, text):
        for k,v in pair.findall(text):
            out[lang].setdefault(k, v.replace("\\'", "'"))
    m=_re.search(r'const STR = \{', t)
    top=body(m.end()-1)
    for lang in ['en','sv']:
        mm=_re.search(r'\b'+lang+r': \{', top)
        if mm:
            depth=0; start=mm.end()-1
            for k in range(start,len(top)):
                c=top[k]
                if c=='{': depth+=1
                elif c=='}':
                    depth-=1
                    if depth==0: add(lang, top[start+1:k]); break
    for lang in ['da','fi','nb']:
        for mm in _re.finditer(r'STR\.'+lang+r' = \{', t): add(lang, body(mm.end()-1))
    for lang in out:
        for mm in _re.finditer(r'Object\.assign\(STR\.'+lang+r', \{', t): add(lang, body(mm.end()-1))
    return out
SAMPLE_IDS = {  # sample id: (key in the app's STR, key in prototype-labels.json)
 'typeItem': ('boxTypeItem','typeItem'), 'typeBox': ('boxTypeBox','typeBox'),
 'newItemIn': (None,'newItemIn'), 'boxNewIn': ('boxNewIn','newBoxIn'),
 'notInBoxShort': ('notInBoxShort',None), 'alone': (None,'alone'),
 'change': ('boxWhereChange','change'), 'pickIcon': ('pickIcon','pickIcon'),
 'photo': ('photoAdd','photo'), 'takeOut': ('takeOut','takeOut'), 'favorite': ('fav','favorite'),
 'scanBarcode': ('scanBarcode','scanBarcode'), 'whatIsIt': ('whatIsIt','whatIsIt'),
 'boxNameHint': ('boxNameHint','boxNameHint'), 'details': ('boxDetails','details'),
 'brand': ('f_brand','brand'), 'value': ('f_value','value'), 'notes': ('f_notes','notes'),
 'size': ('boxSize','size'), 'sizeValue': ('rk_bt_moving',None), 'status': ('status','status'),
 'more': ('moreDetails','more'), 'lastUsed': ('lastUsed','lastUsed'), 'remind': ('remind','remind'),
 'noRemind': ('noRemind','noRemind'), 'pickDate': ('pickDate','pickDate'),
 'attachments': ('attachments','attachments'), 'receipt': ('addAttach','receipt'),
 'tags': ('tags','tags'), 'newTag': ('newTag','addTag'), 'add': ('add','add'),
 'addItemBox': (None,'addItemBox'), 'addItemAnother': (None,'addItemAnother'), 'addItem': ('addItem','addItem'),
 'addBoxItem': ('addBoxItem','addBoxItem'), 'addBoxAnother': ('addBoxAnother','addAnother'), 'addBox': ('addBox','addBox'),
 'cancel': ('cancel','cancel'), 'save': ('save','save'), 'saveAnother': ('saveAnother','saveAdd'), 'share': ('share','share'),
}
def sample_text():
    app=_app_strings('src/app.js')
    proto=_json.loads((R/'src/prototype-labels.json').read_text(encoding='utf-8'))
    out={}; fallbacks=set()
    for lang in ['en','sv','da','nb','fi']:
        out[lang]={}
        for sid,(ak,pk) in SAMPLE_IDS.items():
            if ak and ak in app[lang]: out[lang][sid]=app[lang][ak]
            elif pk and pk in proto[lang]:
                out[lang][sid]=proto[lang][pk]; fallbacks.add(sid)
            else:
                out[lang][sid]=app['en'].get(ak) or (proto['en'].get(pk) if pk else '') or sid
    print('styleguide labels from prototype fallback:', sorted(fallbacks))
    return _json.dumps(out, ensure_ascii=False)

# the design system page: same CSS as the app
import re
g=(R/'src/styleguide.html').read_text()
ver=re.search(r"APP_VERSION = '([^']+)'",(R/'src/app.js').read_text()).group(1)
g=g.replace('{{CSS}}',(R/'src/style.css').read_text(),1).replace('{{VERSION}}',ver)
g=g.replace('{{SAMPLE_TEXT}}', sample_text())
(R/'styleguide.html').write_text(g)
print('built styleguide.html',len(g))

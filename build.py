#!/usr/bin/env python3
"""Inline src/ + vendor/ into index.html."""
from pathlib import Path
R=Path(__file__).parent
t=(R/'src/template.html').read_text()
for k,p in [('CSS','src/style.css'),('QRCODE','vendor/qrcode.js'),('JSQR','vendor/jsQR.js'),('APP','src/app.js')]:
    t=t.replace('{{'+k+'}}',(R/p).read_text(),1)
(R/'index.html').write_text(t)
print('built index.html',len(t))
# the design system page: same CSS as the app
import re
g=(R/'src/styleguide.html').read_text()
ver=re.search(r"APP_VERSION = '([^']+)'",(R/'src/app.js').read_text()).group(1)
g=g.replace('{{CSS}}',(R/'src/style.css').read_text(),1).replace('{{VERSION}}',ver)
(R/'styleguide.html').write_text(g)
print('built styleguide.html',len(g))

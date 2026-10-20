#!/usr/bin/env python3
"""Inline src/ + vendor/ into index.html."""
from pathlib import Path
R=Path(__file__).parent
t=(R/'src/template.html').read_text()
for k,p in [('CSS','src/style.css'),('QRCODE','vendor/qrcode.js'),('JSQR','vendor/jsQR.js'),('APP','src/app.js')]:
    t=t.replace('{{'+k+'}}',(R/p).read_text(),1)
(R/'index.html').write_text(t)
print('built index.html',len(t))

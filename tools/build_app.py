#!/usr/bin/env python3
"""Build the phone app for GitHub Pages.

Run from the repo root:  python3 tools/build_app.py
Wraps app/app.html in a full web page and writes docs/index.html.
(app/app.html has no <html>/<head> of its own so the same file can also be
previewed inside Claude.)  docs/engine.js is the alert logic, edited in place.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
body = (ROOT / "app" / "app.html").read_text()
head, sep, rest = body.partition("</style>")
page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
{head}{sep}
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0}}[hidden]{{display:none!important}}</style>
</head>
<body>
{rest.strip()}
</body>
</html>
"""
(ROOT / "docs" / "index.html").write_text(page)
(ROOT / "docs" / ".nojekyll").write_text("")
print("wrote docs/index.html")

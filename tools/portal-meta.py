#!/usr/bin/env python3
"""Apply social-preview metadata and the GitHub link across the portal pages.

Two jobs, done in one pass so every page stays consistent:

1. Open Graph / Twitter tags that actually embed. The original tags pointed og:image at
   an SVG favicon -- no scraper (Discord, Twitter/X, Facebook, Slack, iMessage) renders
   SVG, and none resolve relative URLs, so links previewed as bare text. Each page now
   declares a 1200x630 PNG at an absolute URL built from the %SITE_URL% placeholder the
   static server substitutes at serve time.

2. The repository link, in the header actions and the footer, following the existing
   .icon-btn / footer-col patterns so it inherits the site's styling and theming.

Idempotent: re-running replaces the managed block rather than appending to it.
"""
import re
import sys
from pathlib import Path

PORTAL = Path(sys.argv[1] if len(sys.argv) > 1 else "packages/account/portal")
REPO = "https://github.com/Paskooter/phoenix"

BEGIN = "<!-- social:begin -->"
END = "<!-- social:end -->"

PAGES = {
    "index.html": {
        "title": "Phoenix — the cloud your robot can talk to again",
        "desc": "A clean-room reimplementation of the cloud service that gave Jibo its "
                "voice. Open source, self-hosted, and running on hardware you own.",
        "path": "/",
    },
    "terms.html": {
        "title": "Terms of use — Phoenix",
        "desc": "The terms that apply to this Phoenix instance.",
        "path": "/terms",
    },
    "privacy.html": {
        "title": "Privacy — Phoenix",
        "desc": "What a Phoenix installation stores, where it stays, and who can see it.",
        "path": "/privacy",
    },
    "security.html": {
        "title": "Security — Phoenix",
        "desc": "How Phoenix handles credentials, transport security and robot trust.",
        "path": "/security",
    },
    "app.html": {
        "title": "Console — Phoenix",
        "desc": "Sign in to manage your robot, loops and updates.",
        "path": "/app",
        "noindex": True,
    },
    "404.html": {
        "title": "Not found — Phoenix",
        "desc": "That page does not exist.",
        "path": "/404",
        "noindex": True,
    },
}


def social_block(meta):
    """The managed metadata block. %SITE_URL% is substituted by the static server."""
    img = "%SITE_URL%/assets/og.png"
    url = "%SITE_URL%" + meta["path"]
    robots = "noindex, nofollow" if meta.get("noindex") else "index, follow"
    return f"""{BEGIN}
<meta name="description" content="{meta['desc']}" />
<meta name="robots" content="{robots}" />
<link rel="canonical" href="{url}" />

<meta property="og:type" content="website" />
<meta property="og:site_name" content="Phoenix" />
<meta property="og:title" content="{meta['title']}" />
<meta property="og:description" content="{meta['desc']}" />
<meta property="og:url" content="{url}" />
<meta property="og:image" content="{img}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Phoenix — the cloud your robot can talk to again" />
<meta property="og:locale" content="en_US" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{meta['title']}" />
<meta name="twitter:description" content="{meta['desc']}" />
<meta name="twitter:image" content="{img}" />
<meta name="twitter:image:alt" content="Phoenix — the cloud your robot can talk to again" />

<meta name="theme-color" content="#08090d" media="(prefers-color-scheme: dark)" />
<meta name="theme-color" content="#fbfbfd" media="(prefers-color-scheme: light)" />
{END}"""


# Tags the managed block now owns; strip any pre-existing copies so they cannot conflict.
STRIP = re.compile(
    r'^\s*<meta\s+(?:name|property)="'
    r'(?:description|robots|theme-color|og:[a-z:]+|twitter:[a-z:]+)"[^>]*/?>\s*$\n?',
    re.M | re.I,
)
STRIP_CANONICAL = re.compile(r'^\s*<link\s+rel="canonical"[^>]*/?>\s*$\n?', re.M | re.I)
MANAGED = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", re.S)

GITHUB_ICON = (
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">'
    '<path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54'
    '-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26'
    ' 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46'
    '.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05'
    '.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56'
    'A11.5 11.5 0 0 0 12 .5Z"/></svg>'
)

HEADER_LINK = (
    f'      <a class="icon-btn" href="{REPO}" target="_blank" rel="noopener"\n'
    f'         data-brand-attr="href:links.github" aria-label="Source on GitHub" title="Source on GitHub">\n'
    f'        {GITHUB_ICON}\n'
    f'      </a>\n'
)


def ensure_head(path, meta):
    html = path.read_text(encoding="utf-8")
    original = html

    html = MANAGED.sub("", html)
    head_open = html.index("<head>") + len("<head>")
    head_close = html.index("</head>")
    head = html[head_open:head_close]
    head = STRIP.sub("", head)
    head = STRIP_CANONICAL.sub("", head)
    head = head.rstrip() + "\n\n" + social_block(meta) + "\n"
    html = html[:head_open] + head + html[head_close:]

    if html != original:
        path.write_text(html, encoding="utf-8")
        return True
    return False


def ensure_github(path):
    """Add the repo link to the header actions and the footer, once."""
    html = path.read_text(encoding="utf-8")
    original = html

    if 'aria-label="Source on GitHub"' not in html:
        # Immediately before the theme toggle, so it sits with the other icon actions.
        marker = '      <button class="icon-btn" data-theme-toggle'
        if marker in html:
            html = html.replace(marker, HEADER_LINK + marker, 1)

    # Footer: add a Project column entry next to Legal.
    if "footer-col" in html and ">Source on GitHub<" not in html:
        legal = '        <div class="footer-col">\n          <h4>Legal</h4>'
        if legal in html:
            project = (
                '        <div class="footer-col">\n'
                '          <h4>Project</h4>\n'
                '          <ul>\n'
                f'            <li><a href="{REPO}" target="_blank" rel="noopener"\n'
                f'                   data-brand-attr="href:links.github">Source on GitHub</a></li>\n'
                f'            <li><a href="{REPO}/releases" target="_blank" rel="noopener"\n'
                f'                   data-brand-attr="href:links.releases">Releases</a></li>\n'
                f'            <li><a href="{REPO}/issues" target="_blank" rel="noopener"\n'
                f'                   data-brand-attr="href:links.issues">Report an issue</a></li>\n'
                '          </ul>\n'
                '        </div>\n'
            )
            html = html.replace(legal, project + legal, 1)

    if html != original:
        path.write_text(html, encoding="utf-8")
        return True
    return False


changed = []
for name, meta in PAGES.items():
    p = PORTAL / name
    if not p.exists():
        print(f"  skip (absent): {name}")
        continue
    if ensure_head(p, meta):
        changed.append(f"{name} (meta)")
    if name != "404.html" and ensure_github(p):
        changed.append(f"{name} (github)")

for c in changed:
    print(f"  updated {c}")
print(f"  {len(changed)} edit(s)")

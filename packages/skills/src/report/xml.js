// Minimal xml2js-compatible parser (explicitArray semantics) — the reference NewsParse runs the
// AP feed XML through xml2js; Phoenix vendors no deps, so this covers the subset that the AP/RSS
// feed shapes use: every child element becomes an array under its tag name, attributes land in
// '$', and text-only elements collapse to their string content.

export function parseXml(xml) {
  const s = String(xml).replace(/<\?[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  let pos = 0;

  function parseAttrs(tagBody) {
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
    let m;
    while ((m = re.exec(tagBody)) !== null) attrs[m[1] || m[3]] = decode(m[2] != null ? m[2] : m[4]);
    return attrs;
  }

  function decode(t) {
    return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  // Returns [name, value] or null at close tag / end.
  function parseElement() {
    const open = s.indexOf('<', pos);
    if (open < 0) return null;
    if (s[open + 1] === '/') return null;
    const close = s.indexOf('>', open);
    const tagBody = s.slice(open + 1, close);
    const selfClosing = tagBody.endsWith('/');
    const name = (selfClosing ? tagBody.slice(0, -1) : tagBody).trim().split(/\s+/)[0];
    const attrs = parseAttrs(tagBody.slice(name.length));
    pos = close + 1;

    if (selfClosing) return [name, Object.keys(attrs).length ? { $: attrs } : ''];

    const children = {};
    let text = '';
    let hasChildren = false;
    for (;;) {
      const nextTag = s.indexOf('<', pos);
      if (nextTag < 0) break;
      text += s.slice(pos, nextTag);
      pos = nextTag;
      if (s[pos + 1] === '/') {
        pos = s.indexOf('>', pos) + 1;
        break;
      }
      // CDATA
      if (s.startsWith('<![CDATA[', pos)) {
        const end = s.indexOf(']]>', pos);
        text += s.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      const child = parseElement();
      if (!child) break;
      hasChildren = true;
      const [cname, cval] = child;
      (children[cname] = children[cname] || []).push(cval);
    }

    text = decode(text.trim());
    const hasAttrs = Object.keys(attrs).length > 0;
    if (!hasChildren && !hasAttrs) return [name, text];
    const obj = {};
    if (hasAttrs) obj.$ = attrs;
    if (text) obj._ = text;
    Object.assign(obj, children);
    return [name, obj];
  }

  const root = parseElement();
  if (!root) return {};
  return { [root[0]]: root[1] };
}

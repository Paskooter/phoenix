// Minimal xml2js-compatible parser (explicitArray semantics) — the reference NewsParse runs the
// AP feed XML through xml2js; Phoenix vendors no deps, so this covers the subset that the AP/RSS
// feed shapes use: every child element becomes an array under its tag name, attributes land in
// '$', and text-only elements collapse to their string content.

export function parseXml(xml) {
  const s = String(xml);
  let pos = 0;

  function malformed(message) {
    throw new Error(`Malformed XML: ${message}`);
  }

  function findTagEnd(start) {
    let quote = null;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        return i;
      }
    }
    malformed('unclosed tag');
  }

  function skipProcessingInstruction() {
    const end = s.indexOf('?>', pos + 2);
    if (end < 0) malformed('unclosed processing instruction');
    pos = end + 2;
  }

  function skipComment() {
    const end = s.indexOf('-->', pos + 4);
    if (end < 0) malformed('unclosed comment');
    const body = s.slice(pos + 4, end);
    if (body.includes('--') || body.endsWith('-')) malformed('invalid comment');
    pos = end + 3;
  }

  function skipDoctype() {
    // The AP fixture has no doctype, but accepting a declaration keeps the
    // wrapper compatible with xml2js for otherwise ordinary XML. An internal
    // subset may contain its own '>' characters, so track bracket depth.
    let quote = null;
    let subsetDepth = 0;
    for (let i = pos + 2; i < s.length; i += 1) {
      const ch = s[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '[') {
        subsetDepth += 1;
      } else if (ch === ']') {
        subsetDepth = Math.max(0, subsetDepth - 1);
      } else if (ch === '>' && subsetDepth === 0) {
        pos = i + 1;
        return;
      }
    }
    malformed('unclosed doctype');
  }

  function parseAttrs(tagBody) {
    const attrs = {};
    let i = 0;
    while (i < tagBody.length) {
      while (/\s/.test(tagBody[i] || '')) i += 1;
      if (i >= tagBody.length) break;

      const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(tagBody.slice(i));
      if (!nameMatch) malformed('invalid attribute');
      const name = nameMatch[0];
      i += name.length;
      while (/\s/.test(tagBody[i] || '')) i += 1;
      if (tagBody[i] !== '=') malformed(`attribute ${name} has no value`);
      i += 1;
      while (/\s/.test(tagBody[i] || '')) i += 1;
      const quote = tagBody[i];
      if (quote !== '"' && quote !== "'") malformed(`attribute ${name} is not quoted`);
      i += 1;
      const valueStart = i;
      while (i < tagBody.length && tagBody[i] !== quote) i += 1;
      if (i >= tagBody.length) malformed(`attribute ${name} is unclosed`);
      const value = decode(tagBody.slice(valueStart, i));
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = value;
      i += 1;
    }
    return attrs;
  }

  function decode(t) {
    let result = '';
    let start = 0;
    while (start < t.length) {
      const amp = t.indexOf('&', start);
      if (amp < 0) return result + t.slice(start);
      result += t.slice(start, amp);
      const semi = t.indexOf(';', amp + 1);
      if (semi < 0) malformed('unclosed entity');
      const body = t.slice(amp + 1, semi);
      if (body === 'lt') result += '<';
      else if (body === 'gt') result += '>';
      else if (body === 'quot') result += '"';
      else if (body === 'apos') result += "'";
      else if (body === 'amp') result += '&';
      else if (/^#x[0-9a-f]+$/i.test(body) || /^#\d+$/.test(body)) {
        const value = body[1].toLowerCase() === 'x'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isInteger(value) || value < 1 || value > 0x10FFFF) malformed(`invalid entity &${body};`);
        result += String.fromCodePoint(value);
      } else {
        malformed(`unknown entity &${body};`);
      }
      start = semi + 1;
    }
    return result;
  }

  function parseCloseTag() {
    const close = findTagEnd(pos + 2);
    const closeBody = s.slice(pos + 2, close).trim();
    if (!/^[A-Za-z_][\w:.-]*$/.test(closeBody)) malformed('invalid closing tag');
    pos = close + 1;
    return closeBody;
  }

  function parseElement() {
    if (s[pos] !== '<') malformed('expected opening tag');
    if (s.startsWith('</', pos)) malformed('unexpected closing tag');
    if (s.startsWith('<!--', pos)) malformed('comment where element was expected');
    if (s.startsWith('<![CDATA[', pos)) malformed('CDATA outside an element');
    if (s.startsWith('<?', pos)) malformed('processing instruction where element was expected');
    if (s.startsWith('<!', pos)) malformed('unsupported declaration');

    const close = findTagEnd(pos + 1);
    const rawBody = s.slice(pos + 1, close);
    const selfClosing = rawBody.endsWith('/');
    const tagBody = selfClosing ? rawBody.slice(0, -1) : rawBody;
    const nameMatch = /^\s*([A-Za-z_][\w:.-]*)/.exec(tagBody);
    if (!nameMatch) malformed('invalid opening tag');
    const name = nameMatch[1];
    const attrs = parseAttrs(tagBody.slice(nameMatch[0].length));
    pos = close + 1;

    if (selfClosing) return [name, Object.keys(attrs).length ? { $: attrs } : ''];

    const children = {};
    let text = '';
    let hasChildren = false;
    for (;;) {
      const nextTag = s.indexOf('<', pos);
      if (nextTag < 0) malformed(`unclosed element ${name}`);
      text += decode(s.slice(pos, nextTag));
      pos = nextTag;
      if (s.startsWith('</', pos)) {
        const closeName = parseCloseTag();
        if (closeName !== name) malformed(`expected </${name}> but found </${closeName}>`);
        break;
      }
      if (s.startsWith('<![CDATA[', pos)) {
        const end = s.indexOf(']]>', pos);
        if (end < 0) malformed(`unclosed CDATA in ${name}`);
        text += s.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      if (s.startsWith('<!--', pos)) {
        skipComment();
        continue;
      }
      if (s.startsWith('<?', pos)) {
        skipProcessingInstruction();
        continue;
      }
      if (s.startsWith('<!', pos)) malformed(`unsupported declaration in ${name}`);
      const child = parseElement();
      hasChildren = true;
      const [cname, cval] = child;
      (children[cname] = children[cname] || []).push(cval);
    }

    const hasAttrs = Object.keys(attrs).length > 0;
    if (!hasChildren && !hasAttrs) return [name, text];
    const obj = {};
    if (hasAttrs) obj.$ = attrs;
    if (text.trim()) obj._ = text;
    Object.assign(obj, children);
    return [name, obj];
  }

  while (pos < s.length) {
    if (s.charCodeAt(pos) === 0xFEFF || /\s/.test(s[pos])) {
      pos += 1;
    } else if (s.startsWith('<?', pos)) {
      skipProcessingInstruction();
    } else if (s.startsWith('<!--', pos)) {
      skipComment();
    } else if (/<!DOCTYPE\b/i.test(s.slice(pos))) {
      skipDoctype();
    } else {
      break;
    }
  }
  if (pos >= s.length) return null;
  if (s[pos] !== '<') malformed('non-whitespace before first tag');
  const root = parseElement();
  if (!root) return null;
  return { [root[0]]: root[1] };
}

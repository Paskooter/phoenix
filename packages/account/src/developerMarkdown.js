// Deliberately bounded Markdown for repository documentation. Raw HTML is text;
// the renderer never passes authored markup or attributes through to the page.
export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function safeDocumentationUrl(value) {
  if (typeof value !== 'string' || /[\s<>"'\\\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^#[\w%.-]+$/.test(value) || /^\/(?!\/)[\w/?#%=&.+~-]*$/.test(value)) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

function inline(text, resolveLink) {
  // Tokenize before escaping. Generated HTML is never reparsed as Markdown.
  // A bare <https://…> autolink is accepted only when its whole URL is safe.
  const token = /(`+)([\s\S]*?)\1|(!?)\[([^\]\n]*)\]\(([^\s)]*)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|<(https?:\/\/[^\s<>"'\\]+)>/g;
  let result = '', offset = 0, match;
  while ((match = token.exec(text))) {
    result += escapeHtml(text.slice(offset, match.index));
    if (match[1]) result += '<code>' + escapeHtml(match[2]) + '</code>';
    else if (match[4] !== undefined) {
      const label = escapeHtml(match[4]);
      const href = !match[3] && safeDocumentationUrl(resolveLink(match[5]));
      result += href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    } else if (match[6]) result += '<strong>' + escapeHtml(match[6]) + '</strong>';
    else if (match[7]) result += '<em>' + escapeHtml(match[7]) + '</em>';
    else {
      const href = safeDocumentationUrl(match[8]);
      result += href ? `<a href="${escapeHtml(href)}">${escapeHtml(match[8])}</a>` : escapeHtml(match[0]);
    }
    offset = token.lastIndex;
  }
  return result + escapeHtml(text.slice(offset));
}

export function renderMarkdown(source, { resolveLink = href => href, reservedIds = [] } = {}) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const html = [], headings = [], usedIds = new Set(['dev-main', 'dev-theme', 'dev-search-input', 'dev-search-results', 'dev-search-status', ...reservedIds]);
  const format = value => inline(value, resolveLink);
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(x => x.trim().replace(/\\\|/g, '|'));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = []; i++;
      const end = new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      while (i < lines.length && !end.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      html.push(`<pre tabindex="0" role="region" aria-label="Code example"><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      const text = heading[2].replace(/[`*]/g, '');
      const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
      let id = base, count = 1;
      while (usedIds.has(id)) id = `${base}-${++count}`;
      usedIds.add(id);
      headings.push({ level: heading[1].length, id, text });
      html.push(`<h${heading[1].length} id="${escapeHtml(id)}">${format(heading[2])}</h${heading[1].length}>`); i++; continue;
    }
    if (i + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const header = cells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      html.push('<div class="dev-table" tabindex="0" role="region" aria-label="Reference table"><table><thead><tr>' + header.map(c => `<th scope="col">${format(c)}</th>`).join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + header.map((_, n) => '<td>' + format(row[n] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'); continue;
    }
    const list = /^\s*(?:(\d+)\.|([-+*]))\s+(.+)$/.exec(line);
    if (list) {
      const ordered = !!list[1], items = []; let current = '';
      while (i < lines.length) {
        const item = /^\s*(?:(\d+)\.|([-+*]))\s+(.+)$/.exec(lines[i]);
        if (item && !!item[1] === ordered) { if (current) items.push(current); current = item[3]; i++; }
        else if (/^ {2,}\S/.test(lines[i])) { current += ' ' + lines[i++].trim(); }
        else break;
      }
      if (current) items.push(current);
      const tag = ordered ? 'ol' : 'ul'; html.push(`<${tag}>${items.map(x => '<li>' + format(x) + '</li>').join('')}</${tag}>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const body = []; while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push('<blockquote><p>' + format(body.join(' ')) + '</p></blockquote>'); continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|\s*(?:`{3,}|~{3,})|\s*[-+*]\s|\s*\d+\.\s|>)/.test(lines[i]) && !(i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]))) paragraph.push(lines[i++]);
    html.push('<p>' + format(paragraph.join(' ')) + '</p>');
  }
  return { html: html.join('\n'), headings };
}

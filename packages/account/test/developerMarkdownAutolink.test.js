// Bare <https://…> links in repository Markdown: rendered as links, never as markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/developerMarkdown.js';

test('markdown: a bare https autolink becomes a link with the URL as its text', () => {
  const { html } = renderMarkdown('Open a ticket in #help: <https://discord.gg/FyDVYQ6FfV>. Or <http://localhost:9011/apps>.');
  assert.ok(html.includes('<a href="https://discord.gg/FyDVYQ6FfV">https://discord.gg/FyDVYQ6FfV</a>'), html);
  assert.ok(html.includes('<a href="http://localhost:9011/apps">http://localhost:9011/apps</a>'), html);
});

// Regression guard (passes before and after): adding autolinks must not turn hostile text into markup.
test('markdown: hostile autolink-shaped text stays inert text', () => {
  const { html } = renderMarkdown('<javascript:alert(1)> <https://user:pass@evil.example/> <https://ok.example/" onclick="x> <img src=x onerror=alert(1)> `<https://code.example>`');
  assert.ok(!/href="(?:javascript|https:\/\/user)/.test(html), html);
  assert.ok(!/<[^>]*\sonclick=|<img\b/.test(html), html);
  assert.ok(html.includes('<code>&lt;https://code.example&gt;</code>'), 'code spans keep their literal text');
  assert.match(html, /&lt;javascript:alert\(1\)&gt;/);
});

(() => {
  'use strict';
  const root = document.documentElement;
  try { const theme = localStorage.getItem('phoenix.theme'); if (theme === 'dark' || theme === 'light') root.dataset.theme = theme; } catch { /* Storage is optional. */ }
  document.querySelector('#dev-theme').addEventListener('click', () => {
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'light' ? 'dark' : 'light'; root.dataset.theme = next;
    try { localStorage.setItem('phoenix.theme', next); } catch { /* Storage is optional. */ }
  });

  const menu = document.querySelector('.dev-menu');
  const phone = matchMedia('(max-width: 760px)');
  function responsiveMenu() {
    menu.open = !phone.matches;
    if (!phone.matches) {
      const current = menu.querySelector('[aria-current="page"]');
      if (current) {
        const bounds = menu.getBoundingClientRect(), row = current.getBoundingClientRect();
        if (row.bottom > bounds.bottom) menu.scrollTop += row.bottom - bounds.bottom + 12;
        else if (row.top < bounds.top) menu.scrollTop -= bounds.top - row.top;
      }
    }
  }
  responsiveMenu(); phone.addEventListener('change', responsiveMenu);

  const search = document.querySelector('.dev-search');
  const input = document.querySelector('#dev-search-input');
  const results = document.querySelector('#dev-search-results');
  const status = document.querySelector('#dev-search-status');
  const list = results.querySelector('ul');
  let indexPromise;
  input.maxLength = 100;
  search.hidden = false;
  function index() {
    if (!indexPromise) indexPromise = fetch('/developers/search.json', { credentials: 'omit' }).then(response => {
      if (!response.ok) throw new Error('search_unavailable');
      return response.json();
    }).catch(error => { indexPromise = null; throw error; });
    return indexPromise;
  }
  async function update() {
    const query = input.value.trim().slice(0, 100).toLowerCase();
    list.replaceChildren(); results.hidden = !query;
    if (!query) return;
    status.textContent = 'Searching documentation…';
    try {
      const rows = await index();
      if (input.value.trim().slice(0, 100).toLowerCase() !== query) return;
      const terms = query.split(/\s+/);
      const matched = rows.filter(row => terms.every(term => (row.title + ' ' + row.text).toLowerCase().includes(term)))
        .sort((a, b) => Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query)));
      const matches = matched.slice(0, 8);
      status.textContent = matched.length > matches.length ? `Showing ${matches.length} of ${matched.length} matching pages` : matches.length ? `${matches.length} matching ${matches.length === 1 ? 'page' : 'pages'}` : 'No matching pages. Try “theme”, “version” or “publish”.';
      for (const row of matches) {
        // Index paths are fixed server-side, but keep the DOM boundary narrow.
        if (!/^\/developers(?:\/[a-z-]+)*$/.test(row.path)) continue;
        const item = document.createElement('li'), link = document.createElement('a'), path = document.createElement('span');
        link.href = row.path; link.append(document.createTextNode(row.title)); path.textContent = row.path; link.append(path); item.append(link); list.append(item);
      }
    } catch {
      if (input.value.trim().toLowerCase() === query) status.textContent = 'Search could not load. Use the documentation menu or try again.';
    }
  }
  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (input.value.trim()) void update(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { results.hidden = true; event.preventDefault(); }
    else if (event.key === 'ArrowDown') { const first = list.querySelector('a'); if (first) { first.focus(); event.preventDefault(); } }
  });
  search.addEventListener('keydown', event => { if (event.key === 'Escape') { input.focus(); results.hidden = true; } });
  document.addEventListener('click', event => { if (!search.contains(event.target)) results.hidden = true; });
  document.addEventListener('focusin', event => { if (!search.contains(event.target)) results.hidden = true; });
})();

// Account-owned chat controls. Never retain a provider key in browser storage,
// the page URL, a read response, or a notification/error string.
export async function createFreeChatCard({ api, h, toggle, field }) {
  const card = h('section', { class: 'card', 'data-free-chat': '' });
  const content = h('div', { class: 'card-body' }); card.append(content);
  content.append(h('h2', {}, 'Free AI chat'));
  const result = await api('GET', '/api/free-chat');
  if (!result.ok) { content.append(h('p', { role: 'status' }, 'Could not load chat settings. Try again.')); return card; }
  let state = result.data;
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  content.append(h('p', {}, 'Jibo talks to the cloud with his eye visible. No separate computer, tools, web browsing or search. '
    + 'What you say is sent to OpenRouter and its model provider. This chat service does not save your words or AI replies. '
    + 'Turn this off for classic chit-chat answers. This is separate from Agent Mode.'));
  const choice = toggle('freeChatEnabled', state.enabled, 'Free AI chat', 'On uses AI conversation. Off keeps classic chit-chat.');
  const detail = h('select', { name: 'freeChatDetail' },
    h('option', { value: 'short', selected: state.detail === 'short' }, 'Short answers'),
    h('option', { value: 'detailed', selected: state.detail === 'detailed' }, 'Detailed answers'));
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save chat settings');
  const form = h('form', {}, choice, field('Answer length', detail), save);
  const summary = h('p', { class: 'field-hint' });
  const paintSummary = () => { summary.textContent = state.ownKey
    ? 'Using your OpenRouter allowance. Safety rate limits still apply.'
    : `${state.limits.requestsPerDay} model requests each day, up to ${state.limits.requestsPerMinute} a minute. An unavailable free model can use two requests for one answer.`;
    if (!state.available) summary.textContent += ' AI chat is not available on this server yet. Your classic choice can still be saved.'; };
  paintSummary();
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = 'Saving chat settings…';
    const enabled = form.querySelector('[name="freeChatEnabled"]').checked;
    const saved = await api('PUT', '/api/free-chat', { enabled, detail: detail.value });
    const readback = saved.ok ? await api('GET', '/api/free-chat') : null;
    save.disabled = false;
    if (readback?.ok && readback.data.enabled === enabled && readback.data.detail === detail.value) {
      state = readback.data; paintSummary(); status.textContent = 'Chat settings saved';
    } else status.textContent = 'Could not save chat settings. Try again.';
  });
  const providerInput = h('input', { type: 'password', name: 'freeChatProviderKey', autocomplete: 'off', spellcheck: 'false', maxlength: '512', disabled: !state.available });
  const ownStatus = h('p', { role: 'status', 'aria-live': 'polite' }, state.ownKey ? 'Your OpenRouter key is saved.' : 'No personal OpenRouter key saved.');
  const useKey = h('button', { type: 'submit', class: 'btn', disabled: !state.available }, 'Use my key');
  const remove = h('button', { type: 'button', class: 'btn btn-quiet', disabled: !state.available || !state.ownKey }, 'Remove my key');
  const keyForm = h('form', {}, h('h3', {}, 'Optional: your OpenRouter key'),
    h('p', {}, 'Use your own provider allowance instead of the shared daily allowance. Your key stays encrypted on Phoenix, never on Jibo. '
      + 'Only OpenRouter is supported here; this does not connect an agent or enable tools.'),
    field('OpenRouter key', providerInput), h('div', { class: 'row' }, useKey, remove), ownStatus);
  const updateKey = async key => {
    useKey.disabled = true; remove.disabled = true; ownStatus.textContent = 'Saving provider choice…';
    const saved = await api('PUT', '/api/free-chat/key', { key }); providerInput.value = '';
    const readback = saved.ok ? await api('GET', '/api/free-chat') : null;
    useKey.disabled = !state.available;
    if (readback?.ok && readback.data.ownKey === (key !== null)) {
      state = readback.data; paintSummary(); ownStatus.textContent = state.ownKey ? 'Your OpenRouter key is saved.' : 'Your OpenRouter key was removed.';
    } else ownStatus.textContent = 'Could not save your provider choice. Try again.';
    remove.disabled = !state.available || !state.ownKey;
  };
  keyForm.addEventListener('submit', event => { event.preventDefault(); const key = providerInput.value; providerInput.value = ''; void updateKey(key); });
  remove.addEventListener('click', () => { void updateKey(null); });
  content.append(form, status, summary, keyForm); return card;
}

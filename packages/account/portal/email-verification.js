// Shared email status/resend controls for the persistent notice and Account.
export function createEmailVerificationUi({ api, h, icon, notify, getAccount, refreshAccount }) {
  let accountId = null;
  let status = null;
  let retryUntil = 0;
  let busy = false;
  let timer = null;
  let lastCheck = 0;
  const buttons = new Set();
  const hints = new Set();

  function resetFor(account) {
    if (accountId === account?.id) return;
    accountId = account?.id || null;
    status = null;
    retryUntil = 0;
    busy = false;
    lastCheck = 0;
    buttons.clear();
    hints.clear();
    clearInterval(timer);
    timer = null;
  }

  function paintControls() {
    const seconds = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
    for (const button of buttons) {
      if (!button.isConnected) { buttons.delete(button); continue; }
      button.disabled = busy || !status?.available || seconds > 0;
      button.textContent = busy ? 'Sending…' : seconds > 0 ? `Resend in ${seconds}s` : 'Send verification email';
    }
    for (const hint of hints) {
      if (!hint.isConnected) { hints.delete(hint); continue; }
      hint.textContent = status?.available === false
        ? 'Verification emails are currently unavailable. Please try again later.'
        : 'Check your inbox and spam folder. Links expire after 24 hours.';
    }
    if (seconds === 0 && timer) { clearInterval(timer); timer = null; }
  }

  function applyStatus(next) {
    status = next;
    retryUntil = Date.now() + (Number(next.retryAfterSeconds) || 0) * 1000;
    paintControls();
    if (retryUntil > Date.now() && !timer) timer = setInterval(paintControls, 1000);
  }

  async function checkStatus(force = false) {
    if (!accountId || (!force && Date.now() - lastCheck < 5000)) return;
    lastCheck = Date.now();
    const requestedAccount = accountId;
    const result = await api('GET', '/api/me/email-verification');
    if (getAccount()?.id !== requestedAccount) return;
    if (result.ok) applyStatus(result.data);
    else applyStatus({ available: false });
  }

  async function resend() {
    if (busy || Date.now() < retryUntil) return;
    const requestedAccount = accountId;
    busy = true;
    paintControls();
    const result = await api('POST', '/api/me/email-verification/resend', {});
    if (getAccount()?.id !== requestedAccount) return;
    busy = false;
    if (result.ok) {
      if (result.data.emailVerified) { await refreshAccount(); return; }
      applyStatus({ available: true, ...result.data });
      notify('Verification email sent. Check your inbox and spam folder.');
    } else {
      if (result.data.retryAfterSeconds) applyStatus({ ...status, ...result.data });
      paintControls();
      notify(result.data.error || 'Could not send the verification email. Please try again.', 'error');
    }
  }

  function resendButton() {
    const button = h('button', {
      type: 'button', class: 'btn btn-primary', 'data-verification-resend': '', disabled: true,
      on: { click: resend },
    }, 'Send verification email');
    buttons.add(button);
    // Run after the caller inserts the card into the page.
    queueMicrotask(paintControls);
    return button;
  }

  function mailHint() {
    const hint = h('p', { class: 'field-hint' }, 'Check your inbox and spam folder. Links expire after 24 hours.');
    hints.add(hint);
    return hint;
  }

  function paintBanner(root, account) {
    resetFor(account);
    const visible = !!account?.email && account.emailVerified !== true;
    root.hidden = !visible;
    root.replaceChildren();
    if (!visible) return;
    root.append(icon('alert', 24),
      h('div', { class: 'email-verification-copy' },
        h('strong', { text: 'Your email is not verified' }),
        h('p', {}, 'Confirm ', h('b', { text: account.email }), ' so we know this email belongs to you.'),
        mailHint()),
      h('div', { class: 'email-verification-actions' }, resendButton(),
        h('a', { class: 'btn btn-quiet', href: '#/profile' }, 'Account settings')));
    void checkStatus();
  }

  function accountCard(account) {
    resetFor(account);
    const verified = account.emailVerified === true;
    const card = h('section', { class: `card email-verification-card${verified ? '' : ' is-unverified'}`, 'data-email-verification': '' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Email verification' }),
        h('span', { class: `pill ${verified ? 'pill-ok' : 'pill-warn'}`, 'data-email-status': '' },
          icon(verified ? 'check' : 'alert', 14), verified ? 'Verified' : 'Not verified')),
      h('div', { class: 'card-body' },
        h('p', { text: verified ? `${account.email} is verified.` : `Verify ${account.email} to confirm that this address belongs to you.` }),
        verified ? null : h('div', { class: 'email-verification-actions' }, resendButton()),
        verified ? null : mailHint()));
    if (!verified) void checkStatus();
    return card;
  }

  // Mail can be confirmed in another tab/device. Refresh the signed-in view
  // when this tab becomes active rather than keeping an obsolete warning.
  addEventListener('focus', async () => {
    if (!getAccount() || getAccount().emailVerified === true) return;
    await checkStatus(true);
    if (status?.emailVerified) await refreshAccount();
  });
  return { paintBanner, accountCard };
}

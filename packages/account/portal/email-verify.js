import { initBrand, initTheme } from '/brand.js';

initTheme();
void initBrand();

let token = null;
let linkVersion = 0;
let retryTimer = null;
const confirm = document.getElementById('verification-confirm');
const message = document.getElementById('verification-message');
const title = document.getElementById('verification-title');

function readLink() {
  linkVersion += 1;
  clearTimeout(retryTimer);
  token = new URLSearchParams(location.hash.slice(1)).get('token');
  // Remove the credential from history immediately. Opening a link alone
  // never redeems it. Handle another link opened in this same tab as well.
  history.replaceState(null, '', location.pathname);
  const valid = !!token && /^[a-f0-9]{64}$/.test(token);
  if (!valid) token = null;
  confirm.hidden = !valid;
  confirm.disabled = false;
  confirm.textContent = 'Verify email address';
  title.textContent = 'Verify your email';
  message.textContent = valid ? 'Confirm that this email address belongs to you.'
    : 'This verification link is incomplete. Request a new email from your account.';
}
readLink();
addEventListener('hashchange', readLink);

confirm.addEventListener('click', async () => {
  if (!token || confirm.disabled) return;
  const version = linkVersion;
  confirm.disabled = true;
  confirm.textContent = 'Verifying…';
  try {
    const response = await fetch('/api/email-verification/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
    const result = await response.json().catch(() => ({}));
    if (version !== linkVersion) return;
    if (response.ok) {
      token = null;
      title.textContent = 'Email verified';
      message.textContent = 'Your email address is verified. You can continue to your account.';
      confirm.hidden = true;
      return;
    }
    message.textContent = result.error || 'Could not verify this email. Please try again.';
    if (response.status === 400) { token = null; confirm.hidden = true; }
    if (response.status === 429) {
      const seconds = Number(result.retryAfterSeconds) || 60;
      confirm.textContent = 'Please wait before trying again';
      retryTimer = setTimeout(() => { confirm.disabled = false; confirm.textContent = 'Verify email address'; }, seconds * 1000);
      return;
    }
  } catch {
    if (version !== linkVersion) return;
    message.textContent = 'Cannot reach the server. Please try again.';
  }
  confirm.disabled = false;
  confirm.textContent = 'Verify email address';
});

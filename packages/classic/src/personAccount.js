import { accountPeerBase, accountPeerHeaders } from './media.js';

const ACCOUNT_TIMEOUT_MS = 2_000;

/** Person's private Account authorization hop uses the same peer as Media and Key. */
export function accountPersonMembership({
  base = accountPeerBase(),
  token = process.env.ETCO_account_internalPeerToken,
  fetcher = globalThis.fetch,
  timeoutMs = ACCOUNT_TIMEOUT_MS,
} = {}) {
  const check = async (operation, { loopId, accountId }) => {
    if (!token) throw new Error('Account peer authentication is not configured');
    const url = new URL(operation, `${String(base).replace(/\/+$/, '')}/`);
    url.search = new URLSearchParams({ loopId, accountId }).toString();
    const response = await fetcher(url, {
      method: 'GET',
      headers: accountPeerHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('Account authorization request failed');
    const body = await response.json();
    if (typeof body?.result !== 'boolean') throw new Error('Invalid Account authorization response');
    return body.result;
  };
  return {
    isLoopMember: (context) => check('isLoopMember', context),
    isAccountOwnerOrRobot: (context) => check('isAccountOwnerOrRobot', context),
  };
}

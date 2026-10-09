// Synthetic internal-peer credentials for Settings tests. The token is invented
// and only ever configured inside the test process.
import { after } from 'node:test';

export const SYNTHETIC_INTERNAL_PEER_TOKEN = 'synthetic-peer-token-settings-tests';
export const INTERNAL_PEER_HEADER = 'x-phoenix-internal-token';

/** Configure the internal peer token now; returns a function restoring the previous value. */
export function setInternalPeerToken(token = SYNTHETIC_INTERNAL_PEER_TOKEN) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ETCO_account_internalPeerToken');
  const previous = process.env.ETCO_account_internalPeerToken;
  process.env.ETCO_account_internalPeerToken = token;
  return () => {
    if (had) process.env.ETCO_account_internalPeerToken = previous;
    else delete process.env.ETCO_account_internalPeerToken;
  };
}

/**
 * Configure the token for the whole test file. It is set immediately (so modules or
 * fixtures constructed at import/top level see it) and restored in a file-level after().
 */
export function useInternalPeerToken(token = SYNTHETIC_INTERNAL_PEER_TOKEN) {
  const restore = setInternalPeerToken(token);
  after(restore);
  return token;
}

/** Header object a trusted internal peer sends. */
export function internalPeerHeaders(token = SYNTHETIC_INTERNAL_PEER_TOKEN) {
  return { [INTERNAL_PEER_HEADER]: token };
}

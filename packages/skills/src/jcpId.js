// Command-protocol IDs are separate from Phoenix response/session IDs.
// jibo-command-requester generates these as 32 lowercase hexadecimal characters
// (its Node implementation is an MD5 of a transaction source).  The response
// envelope and GraphManager session continue to use their UUID contract.
import { randomBytes } from 'node:crypto';

export function newJcpId() {
  return randomBytes(16).toString('hex');
}

#!/usr/bin/env node
// Generate a VAPID key pair for one Phoenix deployment. This only writes to
// stdout so an operator can paste the private value into a mode-0600 .env file
// or a secret manager; do not redirect it into a repository file.

import { generateVapidKeys } from '../packages/account/src/webPush.js';

const args = process.argv.slice(2);
const flag = args.indexOf('--subject');
const subject = flag >= 0 ? args[flag + 1] : '';
if (!subject || args.length !== 2 || flag !== 0) {
  console.error('Usage: node scripts/generate-web-push-vapid.mjs --subject mailto:ops@example.com');
  process.exitCode = 2;
} else {
  const keys = generateVapidKeys();
  console.log('# Paste these only into the target server\'s mode-0600 .env or secret manager.');
  console.log(`ETCO_account_webPushSubject=${subject}`);
  console.log(`ETCO_account_webPushPublicKey=${keys.publicKey}`);
  console.log(`ETCO_account_webPushPrivateKey=${keys.privateKey}`);
}

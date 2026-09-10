// A-17 runtime probe: start the real Classic entrypoint and send every IFTTT_20170207 and
// NLP_20161031 request over the wire (POST /, application/x-amz-json-1.1, X-Amz-Target).
// Run: node docs/parity/evidence/2026-09-10/a17-ifttt-nlp/probe.mjs
import { createClassicEntrypoint, localPhoneticKey } from '../../../../../packages/classic/src/index.js';

const entry = createClassicEntrypoint();
const server = await entry.listen(0);
const port = server.address().port;

async function amz(target, body, accessKeyId = 'acct-1') {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { target, status: res.status, errType: res.headers.get('x-amzn-errortype') || null, body: parsed };
}

// seed an IFTTT identity so Trigger has an applet to match (the IFTTT side of the dead service)
entry.iftttStore.findOrCreateIdentity({ identity: 'idf-1', filter: localPhoneticKey('hello twitter'), loopIds: ['loop-acct-1'], refresh: true });

const results = [];
results.push(await amz('IFTTT_20170207.UserInfo', {}));
results.push(await amz('IFTTT_20170207.Trigger', { text: 'hello twitter' }));
results.push(await amz('IFTTT_20170207.ListTriggers', { identity: 'idf-list' }));
results.push(await amz('IFTTT_20170207.ListMedia', { identity: 'media-1' }));
results.push(await amz('IFTTT_20170207.Action', { fields: { url: 'https://example.test/a.jpg' } }));
results.push(await amz('IFTTT_20170207.ListActions', {}));
results.push(await amz('IFTTT_20170207.DeleteIdentity', { identity: 'idf-1' }));
results.push(await amz('NLP_20161031.PartOfSpeech', { Input: 'Hey Jibo, what is the weather?' }));
results.push(await amz('NLP_20161031.NamedEntityRecognition', { Input: 'who is Jibo?' }));

for (const r of results) {
  const members = Array.isArray(r.body) ? `list(${r.body.length})` : r.body && typeof r.body === 'object' ? Object.keys(r.body).sort().join(',') : String(r.body);
  console.log(`${r.status} ${r.target}${r.errType ? ` [${r.errType}]` : ''} -> ${members}`);
}
console.log('dead IFTTT notify ledger:', JSON.stringify(entry.iftttStore.notifications));
console.log('action rows:', JSON.stringify(entry.iftttStore.actions.map((a) => ({ loopId: a.loopId, fields: a.fields }))));
server.close();

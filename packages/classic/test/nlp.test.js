// A-17 — NLP_20161031 wire contract, derived from the pinned source:
//   apis/nlp-2016-10-31.normal.json, jiborobot/srv-nlp-ws nlp.py (Flask /POS,/NER) and
//   jibospacy.py (clean_input + spacy.load('en')). requirements.txt pins spacy==1.2.0 / Flask 0.11.1.
//
// The spaCy 1.2.0 backend is dead, so tag CONTENT cannot be reproduced without faking it. These
// tests cover the parts that ARE reproducible: the request/response contract, the source
// clean_input transform, input validation, and an explicit provider seam (populated arrays flow
// through when a provider is supplied; the default dead provider serves the documented empty shape
// and is never replaced by invented tags).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint, cleanInput, unavailableNlpProvider, createHttpNlpProvider } from '../src/index.js';

let server; let deadServer; let defaultServer;
let boundPort; let boundDead; let boundDefault;
const posCalls = []; const nerCalls = []; const deadCalls = [];

const posRows = [{ word: 'what', pos: 'ADV' }, { word: 'weather', pos: 'NOUN' }];
const nerRows = [{ start: 0, end: 4, text: 'Jibo', label: 'PRODUCT' }];
const provider = {
  available: true,
  pos: async (text) => { posCalls.push(text); return posRows; },
  ner: async (text) => { nerCalls.push(text); return nerRows; },
};
const deadProvider = {
  available: false,
  pos: async (text) => { deadCalls.push(['pos', text]); return null; },
  ner: async (text) => { deadCalls.push(['ner', text]); return null; },
};

async function amz(port, target, body, accessKeyId = 'acct-1') {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => {
  server = await createClassicEntrypoint({ nlp: { provider } }).listen(0); boundPort = server.address().port;
  deadServer = await createClassicEntrypoint({ nlp: { provider: deadProvider } }).listen(0); boundDead = deadServer.address().port;
  defaultServer = await createClassicEntrypoint().listen(0); boundDefault = defaultServer.address().port;
});
after(() => { server.close(); deadServer.close(); defaultServer.close(); });
beforeEach(() => { posCalls.length = 0; nerCalls.length = 0; deadCalls.length = 0; });

test('PartOfSpeech returns the pinned {word,pos} members', async () => {
  const r = await amz(boundPort, 'NLP_20161031.PartOfSpeech', { Input: 'what is the weather?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.partsOfSpeech.length, 2);
  assert.deepEqual(Object.keys(r.body.partsOfSpeech[0]).sort(), ['pos', 'word']);
  assert.deepEqual(r.body.partsOfSpeech[0], { word: 'what', pos: 'ADV' });
});

test('NamedEntityRecognition returns the pinned {start,end,text,label} members', async () => {
  const r = await amz(boundPort, 'NLP_20161031.NamedEntityRecognition', { Input: 'Jibo is here' });
  assert.equal(r.status, 200);
  assert.equal(r.body.namedEntities.length, 1);
  assert.deepEqual(Object.keys(r.body.namedEntities[0]).sort(), ['end', 'label', 'start', 'text']);
  assert.deepEqual(r.body.namedEntities[0], { start: 0, end: 4, text: 'Jibo', label: 'PRODUCT' });
});

test('clean_input is applied before the provider (drop ?, keep from the last WH word)', async () => {
  assert.equal(cleanInput('Hey Jibo, what is the weather?'), 'what is the weather');
  assert.equal(cleanInput('what do you know how it works?'), 'how it works');

  await amz(boundPort, 'NLP_20161031.PartOfSpeech', { Input: 'Hey Jibo, what is the weather?' });
  assert.deepEqual(posCalls, ['what is the weather']);
  await amz(boundPort, 'NLP_20161031.NamedEntityRecognition', { Input: 'what do you know how it works?' });
  assert.deepEqual(nerCalls, ['how it works']);
});

test('Input is required for both operations', async () => {
  for (const target of ['NLP_20161031.PartOfSpeech', 'NLP_20161031.NamedEntityRecognition']) {
    const r = await amz(boundPort, target, {});
    assert.equal(r.status, 400, target);
    assert.equal(r.errType, 'ValidationException', target);
  }
});

test('the handler consults the provider seam — the dead provider is invoked, not bypassed', async () => {
  const r = await amz(boundDead, 'NLP_20161031.PartOfSpeech', { Input: 'what is love?' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { partsOfSpeech: [] });
  assert.deepEqual(deadCalls, [['pos', 'what is love']]);
});

test('default deployment (no spaCy provider) serves the documented empty shape, never fake tags', async () => {
  const pos = await amz(boundDefault, 'NLP_20161031.PartOfSpeech', { Input: 'what is love?' });
  assert.equal(pos.status, 200);
  assert.deepEqual(pos.body, { partsOfSpeech: [] });
  const ner = await amz(boundDefault, 'NLP_20161031.NamedEntityRecognition', { Input: 'who is Jibo?' });
  assert.equal(ner.status, 200);
  assert.deepEqual(ner.body, { namedEntities: [] });
  assert.equal(await unavailableNlpProvider().pos('x'), null);
});

test('unknown nlp operation -> ValidationException', async () => {
  const r = await amz(boundPort, 'NLP_20161031.Frobnicate', { Input: 'x' });
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('createHttpNlpProvider POSTs the pinned {Input} body to /POS and /NER', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const doc = url.endsWith('/POS') ? { partsOfSpeech: [{ word: 'hi', pos: 'INTJ' }] } : { namedEntities: [{ start: 0, end: 2, text: 'hi', label: 'X' }] };
    return { ok: true, json: async () => doc };
  };
  const p = createHttpNlpProvider('http://nlp.test:8080/', { fetchImpl });
  assert.deepEqual(await p.pos('hi there'), [{ word: 'hi', pos: 'INTJ' }]);
  assert.deepEqual(await p.ner('hi there'), [{ start: 0, end: 2, text: 'hi', label: 'X' }]);
  assert.deepEqual(calls, [
    { url: 'http://nlp.test:8080/POS', body: { Input: 'hi there' } },
    { url: 'http://nlp.test:8080/NER', body: { Input: 'hi there' } },
  ]);
});

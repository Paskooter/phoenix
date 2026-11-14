// Developer pages must stay true once this server is publicly served: no copy
// that calls the server an unreleased or undeployed candidate, no private
// native-review internals, and the JavaScript-app publication boundary intact.
// The skill guide must also say how a normally set-up Jibo is reached over SSH,
// by linking the existing setup-guide steps rather than inventing new ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { staticRoutes } from './fixtures/developer-content.mjs';

const read = path => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
const flat = text => text.replace(/\s+/g, ' ');
const GUIDES = ['publishing.md', 'skill-api.md', 'skill-sdk.md', 'skill-example.md', 'templates.md'];
const guide = name => read('docs/developers/' + name);

function env(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const SITE = { PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_PAGES_DIR: undefined, PHOENIX_BRANDING_FILE: undefined, PHOENIX_SITE_URL: undefined };
function served(path, on) {
  return env({ ...SITE, PHOENIX_DEVELOPER_SKILLS_ENABLED: on ? 'true' : undefined }, () => {
    const res = { writeHead(status) { this.status = status; }, end(bytes = '') { this.body = Buffer.from(bytes).toString(); } };
    staticRoutes()['GET ' + path]({ req: { headers: {}, path }, res });
    return res.body.replace(/&#39;|&rsquo;/g, '’').replace(/'/g, '’');
  });
}
const OFF = ['/developers', '/developers/publishing', '/developers/skill-sdk', '/developers/skill-api', '/developers/skill-example', '/developers/templates'];
const ON = ['/developers', '/developers/publishing', '/developers/skills', '/developers/templates'];

// Wording that only made sense while the server was a private candidate, and
// private native-review implementation detail that public pages must not carry.
const STALE = /unreleased|\bcandidate\b|live site|not been deployed|Upload for private review|native-submissions|vnd\.phoenix\.native-submission|For native (?:material|submissions)|inert operator review|Native submission and inert review|private native[- ]review|for private review/i;

test('developer guides carry no private-candidate or native-review wording', () => {
  for (const name of GUIDES) assert.doesNotMatch(flat(guide(name)), STALE, name);
});

test('served developer pages carry no private-candidate wording with the guide off and on', () => {
  for (const path of OFF) assert.doesNotMatch(flat(served(path, false)), STALE, 'guide off ' + path);
  for (const path of ON) assert.doesNotMatch(flat(served(path, true)), STALE, 'guide on ' + path);
});

test('the JavaScript-app publication boundary stays explicit without a future promise', () => {
  const published = /JavaScript apps can(?:’|')t be published to the Skill Store\./;
  for (const name of ['publishing.md', 'skill-sdk.md', 'templates.md']) {
    const text = flat(guide(name));
    assert.match(text, published, name);
    assert.doesNotMatch(text, /(?:submitted|published) to the Skill Store yet/, name);
  }
  assert.match(flat(guide('publishing.md')), /This browser picker accepts theme packs only/);
  assert.match(flat(guide('skill-api.md')), /409 `native_publication_disabled`/);
  const summary = /<section class="dev-area" id="area-skills"[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(served('/developers', false))[1];
  assert.match(summary, /JavaScript apps can’t be published to the Skill Store\.$/);
});

const MODE = 'https://jibo.io/guide#mode';
const section = (text, heading) => {
  const start = text.indexOf('\n## ' + heading + '\n');
  assert.ok(start >= 0, heading);
  const end = text.indexOf('\n## ', start + 4);
  return text.slice(start, end < 0 ? undefined : end);
};
// Claims no accepted hardware proof supports for a normally set-up Jibo.
const UNPROVEN = /keeps? (?:his |your |the )?owner|owner data|preserv|without (?:losing|erasing)|data (?:is|stays) safe|(?:Developer testing|normal behaviou?r)[^.]*(?:stays|survives|keeps|unchanged)/i;

test('the skill guide links the existing int-developer setup steps before SSH is needed', () => {
  const skills = read('docs/SKILLS.md');
  const before = section(skills, 'Before you start'), ssh = section(skills, 'Connect over SSH');
  const b = flat(before), s = flat(ssh);
  assert.ok(before.includes('](' + MODE + ')'), 'Before you start links the setup guide mode steps');
  assert.ok(ssh.includes('](' + MODE + ')'), 'Connect over SSH links the setup guide mode steps');
  assert.match(b, /`int-developer` mode/);
  assert.match(b, /set up the usual way[^.]*normal mode[^.]*refuses SSH/i);
  assert.match(b, /DFU (?:Mod )?Toolkit/);
  assert.match(b, /RCM/);
  assert.match(b, /physical access/i);
  assert.match(b, /USB/);
  assert.match(b, /Set mode and configure Wi-Fi/);
  assert.match(s, /normal and oobe modes reject inbound SSH/);
  for (const text of [b, s]) assert.doesNotMatch(text, UNPROVEN);
  // UI steps only: the mode switch adds no new terminal commands.
  assert.doesNotMatch(before, /```/);
  assert.deepEqual([...ssh.matchAll(/^node tools\/skill-kit\/cli\.mjs (\S+)/gm)].map(m => m[1]), ['info']);
});

test('guide on: the served skill guide carries the setup-guide link', () => {
  const html = served('/developers/skills', true);
  assert.equal((html.match(/href="https:\/\/jibo\.io\/guide#mode"/g) || []).length, 2);
});

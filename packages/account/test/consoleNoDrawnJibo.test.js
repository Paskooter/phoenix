// The console never draws Jibo. A robot avatar is the robot's initials on its
// console color: no head, face or eye shapes (owner rule; drawn Jibos never
// look right, so the project shows real photos of Jibo or no picture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../portal/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../portal/console.css', import.meta.url), 'utf8');

/** Runs the real initialsOf and robotAvatar source against a stub h(). */
function loadAvatar() {
  const initials = app.match(/^function initialsOf\(name\) \{[\s\S]*?\n\}\n/m);
  const avatar = app.match(/^const robotAvatar = [\s\S]*?\n\}, [^\n]*\);\n/m);
  assert.ok(initials, 'initialsOf is in app.js');
  assert.ok(avatar, 'robotAvatar is in app.js');
  const context = {
    h: (tag, attrs, ...children) => ({ tag, attrs, children: children.flat() }),
    robotColorOf: (value) => value || 'blue',
  };
  vm.runInNewContext(`${initials[0]}\n${avatar[0]}\nthis.robotAvatar = robotAvatar;`, context);
  return context.robotAvatar;
}

test('a robot avatar is its initials on its color, with no drawn eye', () => {
  const robotAvatar = loadAvatar();
  const named = robotAvatar('gold', 'lg', 'Kitchen Jibo');
  assert.equal(named.tag, 'span');
  assert.match(named.attrs.class, /\brobot-avatar\b/);
  assert.match(named.attrs.class, /\brobot-color-gold\b/);
  assert.deepEqual(JSON.parse(JSON.stringify(named.children)), ['KJ']);
  // Unnamed placeholders read "J" for Jibo rather than drawing him.
  assert.deepEqual(JSON.parse(JSON.stringify(robotAvatar('blue').children)), ['J']);
  assert.deepEqual(JSON.parse(JSON.stringify(robotAvatar('blue', 'md', null).children)), ['J']);
});

test('no console page or style draws a Jibo eye', () => {
  assert.doesNotMatch(app, /robot-avatar-eye/);
  assert.doesNotMatch(css, /robot-avatar-eye/);
});

test('every avatar for a real robot or loop passes its name', () => {
  const calls = [...app.matchAll(/robotAvatar\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 10, `found ${calls.length} robotAvatar calls`);
  for (const args of calls) {
    if (args.startsWith('color, size = ')) continue; // the definition itself
    // A fixed 'blue' placeholder stands for "a Jibo" before one is known.
    if (/^'blue'(, '[a-z]+')?$/.test(args.trim())) continue;
    assert.equal(args.split(',').length >= 3, true, `robotAvatar(${args}) names the robot`);
  }
});

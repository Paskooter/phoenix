// N-01: "load every named rule" must be observable, and a rule that fails to
// load must abort the profile instead of being dropped from a later request.
//
// Source contract: RobustParserClient.init() (RobustParserClient.ts:40-50) runs
// RulesRegistry.findRules() and then, when config.loadFSTs is set,
// loadAllFSTs() (RobustParserClient.ts:156-164), which issues one COMPILE per
// discovered rule through Parallel.invoke. init() only reaches
// ClientState.RUNNING when every COMPILE resolves, so handleNLU is never served
// from a partially loaded registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { preloadRuleExecutors } from '../src/compiledFstRuntime.js';

test('every named rule is loaded, and a load failure aborts the whole registry', () => {
  const names = ['chitchat/launch', 'clock/stop_timer', 'launch'];
  const built = [];
  const count = preloadRuleExecutors(names, name => {
    built.push(name);
    return { name };
  });
  assert.equal(count, names.length);
  assert.deepEqual(built, names);
});

test('one unloadable named rule reports every failure instead of skipping it', () => {
  const names = ['a/ok', 'b/broken', 'c/broken', 'd/ok'];
  assert.throws(
    () => preloadRuleExecutors(names, name => {
      if (name.endsWith('broken')) throw new Error(`Malformed compiled NLU FST at ${name}`);
      return { name };
    }),
    error => {
      assert.match(error.message, /named-rule load failed for 2 of 4 rules/);
      assert.match(error.message, /b\/broken: Malformed compiled NLU FST at b\/broken/);
      assert.match(error.message, /c\/broken: Malformed compiled NLU FST at c\/broken/);
      return true;
    },
  );
  // A rule that constructs no executor at all is a failure too, not a no-match.
  assert.throws(
    () => preloadRuleExecutors(['a/empty'], () => null),
    /named-rule load failed for 1 of 1 rules: a\/empty: no executor was constructed/,
  );
});

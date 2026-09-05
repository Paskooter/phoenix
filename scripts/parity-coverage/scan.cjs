// Parse frozen source without importing or executing its services/test hooks.
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require(path.resolve(process.argv[2]));
if (ts.version !== '2.5.3') throw new Error('Coverage scanner requires the pinned TypeScript 2.5.3 parser');
const sources = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = { compiler: ts.version, tests: [], registrations: [], contracts: [], manualRequests: [], diagnostics: [] };
const suiteNames = /^(describe|context|suite|xdescribe|xcontext)(\.(skip|only))?$/;
const testNames = /^(it|test|specify|xit|xtest|xspecify)(\.(skip|only))?$/;
const registrations = /(?:^|\.)(add(?:Http|Socket|Get|Post|Put|Delete|Head|Patch|Options)Handler|(?:router|app)\.(?:get|post|put|delete|head|patch|options|all|use))$/;

for (const input of sources) {
  const file = ts.createSourceFile(input.path, input.text, ts.ScriptTarget.Latest, true);
  for (const d of file.parseDiagnostics) results.diagnostics.push({ path: input.path, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
  const at = node => {
    const loc = file.getLineAndCharacterOfPosition(node.getStart(file));
    return { path: input.path, line: loc.line + 1, column: loc.character + 1 };
  };
  const label = node => {
    if (!node) return { text: '<missing>', literal: false };
    if (node.kind === ts.SyntaxKind.StringLiteral || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return { text: node.text, literal: true };
    return { text: node.getText(file), literal: false };
  };
  const inTestTree = /(?:^|\/)(?:tests?|res_test)\/|\.(?:test|spec)\.[jt]s$|\/integration-tests-[^/]+\//.test(input.path);

  function walk(node, suites, repetition, factory, namespace) {
    let nextRepetition = repetition, nextFactory = factory, nextNamespace = namespace;
    if ([ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement].includes(node.kind)) nextRepetition = true;
    if ([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration].includes(node.kind)) nextFactory = true;
    if (node.kind === ts.SyntaxKind.ModuleDeclaration) nextNamespace = namespace.concat(node.name.text);
    if (node.kind === ts.SyntaxKind.CallExpression) {
      const name = node.expression.getText(file);
      if (inTestTree && suiteNames.test(name)) {
        const entry = { ...at(node), ...label(node.arguments[0]), skipped: /^x|\.skip$/.test(name), only: /\.only$/.test(name) };
        node.arguments.forEach((arg, n) => walk(arg, n ? suites.concat(entry) : suites, nextRepetition, nextFactory, nextNamespace));
        return;
      }
      if (inTestTree && testNames.test(name)) {
        const title = label(node.arguments[0]);
        results.tests.push({ ...at(node), declaration: name, title: title.text, literalTitle: title.literal,
          suites: suites.map(s => s.text), suiteLocations: suites.map(s => ({ path: s.path, line: s.line, column: s.column })),
          originalSkipped: /^x|\.skip$/.test(name) || suites.some(s => s.skipped), originalOnly: /\.only$/.test(name) || suites.some(s => s.only),
          originalPending: node.arguments.length < 2,
          multiplicity: nextRepetition || nextFactory || !title.literal || suites.some(s => !s.literal) ? 'dynamic-or-factory' : 'single-declaration',
          statement: node.getText(file).slice(0, 240) });
      }
      if (!inTestTree && registrations.test(name)) results.registrations.push({ ...at(node), callee: name,
        arguments: node.arguments.map(arg => arg.getText(file)), literalPath: label(node.arguments[0]) });
      if (input.path === 'packages/parser/scripts/test.js' && name === 'makeRequest') {
        results.manualRequests.push({ ...at(node), inputExpression: node.arguments[0].getText(file), expectation: 'unspecified', executableAsCommitted: false });
      }
      if (/\.(forEach|map)$/.test(name)) nextRepetition = true;
    }
    if (/^packages\/interfaces\/src\//.test(input.path) && [ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration].includes(node.kind)) {
      results.contracts.push({ ...at(node), kind: ts.SyntaxKind[node.kind], name: nextNamespace.concat(node.name.text).join('.'), declaration: node.getText(file) });
    }
    ts.forEachChild(node, child => walk(child, suites, nextRepetition, nextFactory, nextNamespace));
  }
  walk(file, [], false, false, []);
}
process.stdout.write(JSON.stringify(results));
if (results.diagnostics.length) process.exitCode = 1;

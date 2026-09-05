// Historical source execution adapter, compatible with Node 8.9.4.
// Uses the exact original compiler but emits separate CommonJS modules instead
// of Gulp/browserify bundles. This is NOT a successful original release build.
// Runtime fixtures exercise these modules; compiler diagnostics are retained.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ref = path.resolve(process.argv[2]);
const ts = require(path.resolve(process.argv[3]));
if (ts.version !== '2.5.3') throw new Error('Expected original TypeScript 2.5.3');
const manifest = JSON.parse(fs.readFileSync(path.join(ref, 'package.json')));
const prepared = JSON.parse(fs.readFileSync(path.join(ref, 'parity-prepared.json')));
function mkdir(dir) {
  if (fs.existsSync(dir)) return;
  mkdir(path.dirname(dir)); fs.mkdirSync(dir);
}
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().reduce((result, name) => {
    const file = path.join(dir, name);
    return result.concat(fs.statSync(file).isDirectory() ? files(file) : [file]);
  }, []);
}
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const inputs = {}, outputs = {}, diagnostics = [];
for (const workspace of manifest.workspaces) {
  const root = path.join(ref, workspace);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const src = path.join(root, 'src');
  for (const file of files(src)) {
    if (!/\.ts$/.test(file) || /\.d\.ts$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(ref, file);
    const output = path.join(root, 'lib', path.relative(src, file).replace(/\.ts$/, '.js'));
    const result = ts.transpileModule(source, {
      fileName: file, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: pkg.name === '@jibo/interfaces' ? ts.ScriptTarget.ES2015 : ts.ScriptTarget.ES2017,
        preserveConstEnums: true, removeComments: false, sourceMap: false, isolatedModules: true },
    });
    for (const diagnostic of result.diagnostics || []) diagnostics.push({ file: relative, code: diagnostic.code,
      category: diagnostic.category, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') });
    mkdir(path.dirname(output)); fs.writeFileSync(output, result.outputText);
    inputs[relative] = sha(source); outputs[path.relative(ref, output)] = sha(result.outputText);
  }
  // Original bundle entry names differ from src/index.ts. Preserve package
  // resolution without changing any source or public exports.
  if (pkg.main && fs.existsSync(path.join(root, 'lib/index.js')) && pkg.main !== 'lib/index.js') {
    const output = path.join(root, pkg.main);
    const wrapper = "module.exports = require('./index.js');\n";
    mkdir(path.dirname(output)); fs.writeFileSync(output, wrapper);
    outputs[path.relative(ref, output)] = sha(wrapper);
  }
}
const record = { referenceRevision: prepared.referenceRevision, runtime: process.version, compiler: ts.version,
  method: 'ts.transpileModule, isolated CommonJS modules; no type check or original Gulp bundle verification',
  adapterSha256: sha(fs.readFileSync(__filename)), inputs, outputs, diagnostics };
fs.writeFileSync(path.join(ref, 'parity-compiled.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ runtime: record.runtime, compiler: record.compiler, inputFiles: Object.keys(inputs).length,
  emittedFiles: Object.keys(outputs).length, diagnostics: diagnostics.length }));
if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) process.exitCode = 1;

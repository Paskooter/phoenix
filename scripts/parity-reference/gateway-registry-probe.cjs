'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cases = require('./gateway-registry-cases.cjs');

function mkdir(dir) {
  if (!fs.existsSync(dir)) { mkdir(path.dirname(dir)); fs.mkdirSync(dir); }
}
function remove(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) remove(file); else fs.unlinkSync(file);
  }
  fs.rmdirSync(dir);
}
function errorValue(error, temp) {
  const message = temp ? error.message.split(temp).join('<fixture>') : error.message;
  return { name: error.name, message, code: error.code };
}
function frozen(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return true;
  return Object.isFrozen(value) && Object.getOwnPropertyNames(value).every(key => frozen(value[key]));
}
function request(port, row, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, row.headers, extraHeaders);
    if (row.body !== undefined) headers['content-length'] = Buffer.byteLength(row.body);
    const req = http.request({ host: '127.0.0.1', port, path: row.path, method: row.method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('HTTP probe timeout')));
    if (row.body !== undefined) req.write(row.body);
    req.end();
  });
}

module.exports = async function run(adapter, originalRoot) {
  const progress = stage => { if (adapter.progress) adapter.progress(stage); };
  progress('validations');
  const result = { runtime: process.version, implementation: adapter.name, validations: [], registries: [], config: [], http: [] };
  for (const row of cases.validationCases()) {
    try {
      const mgr = adapter.manager(row.configs);
      const gets = {};
      for (const id of ['alpha', 'ALPHA', '@be/clock', 'missing', 1, null]) {
        try { gets[JSON.stringify(id)] = { value: mgr.getSkillConfig(id), onRobot: mgr.isOnRobotSkill(id) }; }
        catch (error) { gets[JSON.stringify(id)] = { error: errorValue(error) }; }
      }
      result.validations.push({ id: row.id, configs: mgr.getSkillConfigs(), proactive: mgr.getProactiveSkillConfigs(), gets, frozen: row.configs.every(frozen) });
    } catch (error) { result.validations.push({ id: row.id, error: errorValue(error), frozen: row.configs.every(frozen) }); }
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-registry-'));
  progress('registries');
  try {
    let i = 0;
    for (const row of cases.registryCases()) {
      const root = path.join(temp, String(i++));
      mkdir(path.join(root, 'resources/skills'));
      fs.writeFileSync(path.join(root, 'resources/skills/cases.json'), row.rawIndex !== undefined ? row.rawIndex : JSON.stringify(row.index));
      for (const file of Object.keys(row.files)) fs.writeFileSync(path.join(root, file), row.rawFiles ? row.files[file].raw : JSON.stringify(row.files[file]));
      try {
        const skills = await adapter.registry(root, 'cases.json');
        result.registries.push({ id: row.id, skills, frozen: frozen(skills) });
      } catch (error) { result.registries.push({ id: row.id, error: errorValue(error, root) }); }
    }
  } finally { remove(temp); }
  progress('original-index');
  const originalSkills = await adapter.registry(originalRoot, 'skills-local.json');
  const mgr = adapter.manager(originalSkills);
  result.originalIndex = { skills: originalSkills, frozen: frozen(originalSkills), managed: mgr.getSkillConfigs().length };
  progress('config');
  for (const row of cases.configCases()) result.config.push({ id: row.id, config: await adapter.config(row.env) });
  progress('server');
  const server = await adapter.server(cases.httpSkills());
  progress('http');
  try {
    for (const row of cases.httpCases()) {
      progress(row.id);
      result.http.push(Object.assign({ id: row.id }, await request(server.port, row)));
    }
    const row = { method: 'GET', path: '/v1/skills/settings/robot' };
    progress('conditional-etag');
    const first = await request(server.port, row);
    result.http.push(Object.assign({ id: 'conditional-etag' }, await request(server.port, row, { 'if-none-match': first.headers.etag })));
  } finally { progress('close'); await server.close(); }
  progress('complete');
  return result;
};

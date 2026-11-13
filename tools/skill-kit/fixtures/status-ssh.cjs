'use strict';
// Executable test double: an exact argv/command allowlist, never a shell or SSH.
const fs = require('node:fs');
const spec = JSON.parse(fs.readFileSync(process.env.SKILL_KIT_SSH_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
function refuse() { process.stderr.write('fixture_command_refused\n'); process.exitCode = 90; }
const reply = spec.replies.find(item => item.command === args[5]);
if (args.length !== 6 || JSON.stringify(args.slice(0, 5)) !== JSON.stringify(['-T', '-l', 'root', '--', 'fixture.invalid']) || !reply) {
  refuse();
} else {
  fs.appendFileSync(spec.trace, JSON.stringify({event: 'command', argv: args}) + '\n');
  let inputBytes = 0;
  process.stdin.on('data', data => { inputBytes += data.length; });
  process.stdin.on('end', () => {
    if (inputBytes !== (reply.inputBytes || 0)) return refuse();
    const bytes = Buffer.from(reply.stdout || '');
    const cuts = [0, ...(reply.cuts || []), bytes.length];
    let index = 0;
    function next() {
      if (index === cuts.length - 1) {
        if (reply.stderr) process.stderr.write(reply.stderr);
        fs.appendFileSync(spec.trace, JSON.stringify({event: 'flushed', bytes: bytes.length, exit: reply.exit || 0}) + '\n');
        if (reply.signal) process.kill(process.pid, reply.signal);
        else process.exitCode = reply.exit || 0;
        return;
      }
      const chunk = bytes.subarray(cuts[index], cuts[++index]);
      process.stdout.write(chunk, () => reply.delayMs ? setTimeout(next, reply.delayMs) : next());
    }
    next();
  });
}

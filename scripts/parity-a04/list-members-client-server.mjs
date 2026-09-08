import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createAccountService, Store } from '../../packages/account/src/index.js';
import { MEMBER_STATUS } from '../../packages/account/src/model.js';

const readyPath = process.env.A04_READY_PATH;
const capturePath = process.env.A04_CAPTURE_PATH;
const storePath = process.env.A04_STORE_PATH;
if (!readyPath || !capturePath || !storePath) throw new Error('A04_READY_PATH, A04_CAPTURE_PATH, and A04_STORE_PATH are required');
mkdirSync(dirname(readyPath), { recursive: true });
mkdirSync(dirname(capturePath), { recursive: true });

const store = new Store(storePath);
const owner = {
  _id: 'a04-client-owner', email: 'owner@client.synthetic.invalid', firstName: 'Owner', lastName: 'Client',
  accessKeyId: 'A04CLIENTOWNER0000001', secretAccessKey: 'a04-client-owner-secret', isActive: true,
};
const guest = {
  _id: 'a04-client-guest', email: 'guest@client.synthetic.invalid', firstName: 'Guest', lastName: 'Client',
  accessKeyId: 'A04CLIENTGUEST0000001', secretAccessKey: 'a04-client-guest-secret', isActive: true,
};
const robot = {
  _id: 'a04-client-robot', friendlyId: 'a04-client-robot', email: null,
  firstName: '', lastName: '', facebookAccessToken: null,
  accessKeyId: 'A04CLIENTROBOT0000001', secretAccessKey: 'a04-client-robot-secret', isActive: true,
};
const outsider = {
  _id: 'a04-client-outsider', email: 'outsider@client.synthetic.invalid', firstName: 'Outsider', lastName: 'Client',
  accessKeyId: 'A04CLIENTOUTSIDER0001', secretAccessKey: 'a04-client-outsider-secret', isActive: true,
};
for (const account of [owner, guest, robot, outsider]) store.accounts.set(account._id, account);
const loop = {
  _id: 'a04-client-loop', name: 'Client ListLoopMembers', owner: owner._id, robot: robot._id,
  isDeleted: false, isSuspended: false, created: 1700000000000,
  members: [
    { _id: 'a04-client-owner-member', accountId: owner._id, status: MEMBER_STATUS.ACCEPTED, enrolled: { face: true, voice: false }, created: 1700000000001 },
    { _id: 'a04-client-guest-member', accountId: guest._id, status: MEMBER_STATUS.ACCEPTED, enrolled: { face: false, voice: true }, created: 1700000000002 },
    { _id: 'a04-client-robot-member', accountId: robot._id, status: MEMBER_STATUS.ACCEPTED, enrolled: { face: false, voice: false }, created: 1700000000003 },
    { _id: 'a04-client-invited-member', accountId: 'a04-client-invited', status: MEMBER_STATUS.INVITED, memberProperties: { email: 'invited@client.synthetic.invalid' }, enrolled: { face: false, voice: false }, created: 1700000000004 },
    { _id: 'a04-client-declined-member', accountId: 'a04-client-declined', status: MEMBER_STATUS.DECLINED, memberProperties: { firstName: 'Declined' }, enrolled: { face: false, voice: false }, created: 1700000000005 },
  ],
};
store.loops.set(loop._id, loop);
store.flush();

const service = await createAccountService({ store }).listen(0);
const port = service.address().port;
const ready = {
  candidateBase: '4d453eb8a85a0bebcac189a7dc643153d54ba35c',
  port,
  loopId: loop._id,
  accounts: { owner, guest, robot, outsider },
};
writeFileSync(readyPath, `${JSON.stringify(ready, null, 2)}\n`);
appendFileSync(capturePath, `${JSON.stringify({ event: 'ready', port })}\n`);

await new Promise((resolve) => {
  const stop = () => service.close(() => resolve());
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
});

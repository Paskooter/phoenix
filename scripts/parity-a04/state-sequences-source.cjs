'use strict';

// A-04 gate 1: pinned Account controller state sequences under Node 8.
//
// Executes the exact transpiled 6cea LoopHandler/LoopController chain with
// controlled Loop/Account/Token/mail/robot seams. Schema pre-find middleware
// excludes isDeleted (loop.ts). LoopUpdated skill/account routing is annotated
// from srv-notification-ws LoopUpdatedHandler (payload.robot, skill "-1").
// This is not a Hapi/Mongo/deployed Account server.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var compiled = process.env.COMPILED_ROOT || '/source/compiled';
var outputPath = process.env.SEQUENCE_OUTPUT || '/review/source-sequences.json';
var server = require('@jibo/server');

server.App = class NoopApp {
  constructor(options) { this.options = options; }
  start() { return this; }
};
server.connectMongo = function connectMongo() {};

var loopPath = path.join(compiled, 'schemes/loop.js');
var accountPath = path.join(compiled, 'schemes/account.js');
var LoopExport = require(loopPath);
var AccountExport = require(accountPath);
var Token = require(path.join(compiled, 'schemes/token.js'));
var MailController = require(path.join(compiled, 'controllers/mail.ctrl.js')).default;
var RobotClient = require(path.join(compiled, 'clients/robot.client.js')).default;

function Id(value) { this.value = String(value); }
Id.prototype.equals = function equals(other) {
  return other != null && this.value === String(other);
};
Id.prototype.toString = function toString() { return this.value; };
function id(value) {
  if (value == null) return value;
  return value instanceof Id ? value : new Id(value);
}

var seq = 0;
function nextId(prefix) {
  seq += 1;
  return id(prefix + '-' + seq);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function plain(value, seen) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Id) return value.toString();
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'object') return value;
  seen = seen || [];
  if (seen.indexOf(value) >= 0) return '[Circular]';
  var nextSeen = seen.concat([value]);
  if (Array.isArray(value)) {
    return value.map(function (item) { return plain(item, nextSeen); });
  }
  var result = {};
  Object.keys(value).sort().forEach(function (key) {
    var item = value[key];
    if (item !== undefined && typeof item !== 'function') result[key] = plain(item, nextSeen);
  });
  return result;
}

function errorRecord(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    statusCode: (error.output && error.output.statusCode) || error.statusCode,
    payload: plain(error.output && error.output.payload),
  };
}

function wrapMembers(items) {
  var arr = [];
  arr._push = Array.prototype.push;
  arr.push = function push() {
    for (var i = 0; i < arguments.length; i += 1) {
      var member = arguments[i] || {};
      if (!member._id) member._id = nextId('member');
      member.id = String(member._id);
      if (member.accountId != null) member.accountId = id(member.accountId);
      arr._push.call(arr, member);
    }
    return arr.length;
  };
  (items || []).forEach(function (item) { arr.push(item); });
  return arr;
}

function LoopDoc(fields) {
  fields = fields || {};
  this._id = fields._id ? id(fields._id) : nextId('loop');
  this.name = fields.name;
  this.owner = id(fields.owner);
  this.robot = fields.robot != null ? id(fields.robot) : undefined;
  this.members = wrapMembers(fields.members || []);
  this.isDeleted = fields.isDeleted === true;
  this.isSuspended = fields.isSuspended === true;
  this.created = fields.created || new Date(1700000000000);
  this.updated = fields.updated;
  this.saveCount = 0;
}

LoopDoc.prototype.toJSON = function toJSON() {
  var members = this.members.map(function (member) {
    var result = Object.assign({}, member);
    result.id = result._id;
    delete result._id;
    delete result.invitationCode;
    result.memberId = result.accountId;
    if (result.created) result.created = new Date(result.created).getTime();
    else delete result.created;
    return result;
  });
  return {
    _id: this._id,
    id: this._id,
    owner: this.owner,
    robot: this.robot,
    members: members,
    name: this.name,
    created: this.created ? new Date(this.created).getTime() : this.created,
    updated: this.updated ? new Date(this.updated).getTime() : this.updated,
    isDeleted: this.isDeleted === true,
    isSuspended: this.isSuspended === true,
  };
};

LoopDoc.prototype.save = async function save() {
  this.updated = new Date();
  this.saveCount += 1;
  Loop.records.set(String(this._id), this);
  var hook = Loop.loopSchema && Loop.loopSchema.postSave;
  if (typeof hook === 'function') {
    var doc = this;
    hook(doc, function next() {});
  }
  return this;
};

function Loop(fields) {
  if (!(this instanceof Loop)) return new Loop(fields);
  LoopDoc.call(this, fields);
}
Loop.prototype = Object.create(LoopDoc.prototype);
Loop.prototype.constructor = Loop;
Loop.records = new Map();
Loop.calls = [];
Loop.loopSchema = LoopExport.loopSchema;
Loop.findById = async function findById(value) {
  Loop.calls.push({ method: 'findById', id: String(value) });
  var loop = Loop.records.get(String(value));
  return loop && loop.isDeleted !== true ? loop : null;
};
Loop.findOne = async function findOne(query) {
  Loop.calls.push({ method: 'findOne', query: plain(query) });
  var values = Array.from(Loop.records.values()).filter(function (loop) {
    return loop.isDeleted !== true;
  });
  for (var i = 0; i < values.length; i += 1) {
    var loop = values[i];
    if (query && query.robot && loop.robot && loop.robot.equals(query.robot)) return loop;
  }
  return null;
};
Loop.find = async function find(query) {
  Loop.calls.push({ method: 'find', query: plain(query) });
  var values = Array.from(Loop.records.values()).filter(function (loop) {
    return loop.isDeleted !== true;
  });
  if (!query) return values;
  if (query.$or) {
    return values.filter(function (loop) {
      return query.$or.some(function (branch) {
        var robotPred = branch.robot;
        var memberAccount = branch['members.accountId'];
        if (robotPred && memberAccount) {
          var robotMatch = loop.robot && loop.robot.equals(robotPred);
          var memberMatch = (loop.members || []).some(function (member) {
            return member.accountId && member.accountId.equals(memberAccount);
          });
          return robotMatch && memberMatch;
        }
        if (branch.owner && loop.owner && loop.owner.equals(branch.owner)) return true;
        var elem = branch.members && branch.members.$elemMatch;
        if (elem) {
          return (loop.members || []).some(function (entry) {
            return entry.accountId && entry.accountId.equals(elem.accountId)
              && elem.status && elem.status.$in && elem.status.$in.indexOf(entry.status) >= 0;
          });
        }
        return false;
      });
    });
  }
  if (query._id) return values.filter(function (loop) { return loop._id.equals(query._id); });
  return values;
};

function AccountDoc(fields) {
  fields = fields || {};
  this._id = fields._id ? id(fields._id) : nextId('account');
  this.id = String(this._id);
  this.email = fields.email;
  this.firstName = fields.firstName;
  this.lastName = fields.lastName;
  this.fullName = fields.fullName || ((fields.firstName || '') + ' ' + (fields.lastName || '')).trim();
  this.friendlyId = fields.friendlyId;
  this.isAdmin = fields.isAdmin === true;
  this.isDeleted = fields.isDeleted === true;
  this.isActive = fields.isActive !== false;
  this.photoUrl = fields.photoUrl || null;
  this.birthday = fields.birthday || null;
  this.gender = fields.gender || null;
  this.phoneNumber = fields.phoneNumber || null;
  this.facebookAccessToken = fields.facebookAccessToken;
  this.accessKeyId = fields.accessKeyId;
  this.secretAccessKey = fields.secretAccessKey;
}
AccountDoc.prototype.fillAccessKeys = function fillAccessKeys() {
  this.accessKeyId = 'ak' + String(this._id).replace(/[^a-z0-9]/gi, '').slice(0, 18);
  this.secretAccessKey = 'sk' + String(this._id) + 'secretsecretsecretsecret';
};
AccountDoc.prototype.save = async function save() {
  Account.records.set(String(this._id), this);
  var hook = Account.accountSchema && Account.accountSchema.postSave;
  if (typeof hook === 'function') hook(this, function next() {});
  return this;
};
AccountDoc.prototype.toJSON = function toJSON(options) {
  var ret = {
    id: this._id,
    email: this.email,
    firstName: this.firstName,
    lastName: this.lastName,
    friendlyId: this.friendlyId,
    isActive: !!this.isActive,
    facebookConnected: !!this.facebookAccessToken,
  };
  if (options && options.unsafe) {
    ret.accessKeyId = this.accessKeyId;
    ret.secretAccessKey = this.secretAccessKey;
  }
  return ret;
};

function Account(fields) {
  if (!(this instanceof Account)) return new Account(fields);
  AccountDoc.call(this, fields);
}
Account.prototype = Object.create(AccountDoc.prototype);
Account.prototype.constructor = Account;
Account.records = new Map();
Account.calls = [];
Account.accountSchema = AccountExport.accountSchema;
Account.findById = async function findById(value) {
  Account.calls.push({ method: 'findById', id: value == null ? null : String(value) });
  if (value == null) return null;
  return Account.records.get(String(value)) || null;
};
Account.findOne = async function findOne(query) {
  Account.calls.push({ method: 'findOne', query: plain(query) });
  var values = Array.from(Account.records.values());
  for (var i = 0; i < values.length; i += 1) {
    var account = values[i];
    if (query && query.email && account.email === query.email) {
      if (query.isDeleted && query.isDeleted.$ne === true && account.isDeleted === true) continue;
      return account;
    }
    if (query && query.friendlyId && account.friendlyId === query.friendlyId) return account;
  }
  return null;
};
Account.find = function find(query) {
  Account.calls.push({ method: 'find', query: plain(query) });
  var rows = Array.from(Account.records.values()).filter(function (account) {
    if (query && query._id && query._id.$in) {
      return query._id.$in.some(function (value) { return String(value) === String(account._id); });
    }
    return false;
  });
  rows.lean = function lean() { return Promise.resolve(rows); };
  return rows;
};

var tokenN = 0;
Token.getRandomCode = async function getRandomCode() {
  tokenN += 1;
  return 'code-' + tokenN;
};

var mailCalls = [];
MailController.prototype.send = function send(email, payload) {
  mailCalls.push({ email: email, payload: plain(payload) });
  return Promise.resolve('source-mail-accepted');
};

var robotReads = [];
RobotClient.prototype.getRobot = async function getRobot(robotId) {
  robotReads.push(robotId);
  return { payload: { suspended: false } };
};

function installModule(modulePath, ctor, extra) {
  var exported = require.cache[require.resolve(modulePath)].exports;
  exported.default = ctor;
  Object.keys(extra || {}).forEach(function (key) { exported[key] = extra[key]; });
}
installModule(loopPath, Loop, { loopSchema: Loop.loopSchema });
installModule(accountPath, Account, { accountSchema: Account.accountSchema });

var Handler = require(path.join(compiled, 'handlers/loop.handler.js')).default;
var sourceIndex = require(path.join(compiled, 'index.js'));
var setupAccountEntityTriggers = sourceIndex.setupAccountEntityTriggers;
if (typeof setupAccountEntityTriggers !== 'function') {
  throw new Error('compiled index did not export setupAccountEntityTriggers');
}

function eventName(event) {
  if (!event) return null;
  if (event.constructor && event.constructor.name && event.constructor.name !== 'Object') {
    return event.constructor.name;
  }
  if (event.payload && event.payload.eventKey) return event.payload.eventKey;
  return null;
}

function loopUpdatedRouting(event) {
  var payload = event && event.payload ? event.payload : event;
  var robot = payload && payload.robot != null ? String(payload.robot) : null;
  if (!robot) robot = null;
  return {
    payloadRobot: robot,
    wouldDeliver: !!robot,
    accountIdIfDelivered: robot,
    skillIdIfDelivered: robot ? '-1' : null,
    notificationName: 'LoopUpdated',
  };
}

function memberStatus(loop) {
  return (loop.members || []).map(function (member) {
    return {
      id: member._id && String(member._id),
      accountId: member.accountId != null ? String(member.accountId) : null,
      status: member.status,
      email: member.memberProperties && member.memberProperties.email || null,
      invitationCode: member.invitationCode || null,
    };
  });
}

function ownerRobot(loop) {
  return {
    owner: loop.owner != null ? String(loop.owner) : null,
    robot: loop.robot != null ? String(loop.robot) : null,
    isDeleted: loop.isDeleted === true,
    isSuspended: loop.isSuspended === true,
    name: loop.name || null,
  };
}

function snapshot(label, loop, events, extra) {
  var loopUpdated = events.filter(function (row) { return row.name === 'LoopUpdated'; });
  var membership = events.filter(function (row) { return row.name !== 'LoopUpdated' && row.name !== 'AccountUpdated'; });
  var routing = loopUpdated.map(function (row) { return loopUpdatedRouting(row.value); });
  return Object.assign({
    step: label,
    memberStatus: loop ? memberStatus(loop) : [],
    ownerRobot: loop ? ownerRobot(loop) : null,
    eventRecipients: membership.map(function (row) {
      var payload = row.value && row.value.payload ? row.value.payload : row.value;
      return {
        name: row.name,
        accountId: payload && payload.accountId != null ? String(payload.accountId) : null,
        email: payload && payload.email || null,
        ownerId: payload && payload.ownerId != null ? String(payload.ownerId) : null,
        memberIds: payload && payload.memberIds ? plain(payload.memberIds) : undefined,
      };
    }),
    loopUpdatedRouting: routing,
    skillMinusOne: routing.every(function (row) { return !row.wouldDeliver || row.skillIdIfDelivered === '-1'; }),
    pendingRows: [],
    pendingRowsNote: 'Source Account EventSender is SNS fire-and-forget; no durable pending rows. notification-ws delivers LoopUpdated only when payload.robot is set, with skill "-1".',
  }, extra || {});
}

async function drain() {
  await new Promise(function (resolve) { setImmediate(resolve); });
  await Promise.resolve();
  await new Promise(function (resolve) { setImmediate(resolve); });
}

function makeWorld() {
  Loop.records = new Map();
  Loop.calls = [];
  Account.records = new Map();
  Account.calls = [];
  mailCalls = [];
  robotReads = [];
  tokenN = 0;
  seq = 0;

  var owner = new Account({
    _id: 'owner-1', email: 'owner@fixture.test', firstName: 'Owner', lastName: 'Fixture',
  });
  owner.fillAccessKeys();
  var guestAccept = new Account({
    _id: 'guest-accept', email: 'accept@fixture.test', firstName: 'Accept', lastName: 'Guest',
  });
  guestAccept.fillAccessKeys();
  var guestDecline = new Account({
    _id: 'guest-decline', email: 'decline@fixture.test', firstName: 'Decline', lastName: 'Guest',
  });
  guestDecline.fillAccessKeys();
  var admin = new Account({
    _id: 'admin-1', email: 'admin@fixture.test', firstName: 'Admin', lastName: 'Fixture', isAdmin: true,
  });
  admin.fillAccessKeys();
  [owner, guestAccept, guestDecline, admin].forEach(function (account) {
    Account.records.set(String(account._id), account);
  });

  var events = [];
  var sender = {
    events: events,
    send: function send(event) {
      events.push({
        name: eventName(event),
        value: plain(event),
      });
      return Promise.resolve('source-event-accepted');
    },
  };
  setupAccountEntityTriggers({ eventSender: sender });
  var handler = new Handler({
    config: { features: {}, server: { portalUrl: 'http://portal.fixture.test' } },
    registry: { get: function () { return ''; } },
    eventSender: sender,
  });
  return {
    owner: owner,
    guestAccept: guestAccept,
    guestDecline: guestDecline,
    admin: admin,
    sender: sender,
    events: events,
    handler: handler,
  };
}

function requestFor(account, payload, isAdmin) {
  return {
    headers: {
      'x-amz-credentials': JSON.stringify({
        id: String(account._id),
        isAdmin: isAdmin === true || account.isAdmin === true,
        friendlyId: account.friendlyId,
      }),
    },
    payload: payload,
  };
}

async function invoke(handler, method, account, payload, isAdmin) {
  try {
    var value = await handler[method](requestFor(account, payload, isAdmin));
    return { status: 200, body: value === undefined ? null : plain(value), error: null };
  } catch (error) {
    return {
      status: (error.output && error.output.statusCode) || error.statusCode || 500,
      body: plain(error.output && error.output.payload),
      error: errorRecord(error),
    };
  }
}

function activeLoop() {
  var found = null;
  Loop.records.forEach(function (loop) {
    if (loop.isDeleted !== true) found = loop;
  });
  return found;
}

function loopById(loopId) {
  return Loop.records.get(String(loopId)) || null;
}

function takeEvents(world, from) {
  return world.events.slice(from);
}

async function runSequence(name, steps) {
  var world = makeWorld();
  var captured = [];
  var loopId = null;
  for (var i = 0; i < steps.length; i += 1) {
    var step = steps[i];
    var eventFrom = world.events.length;
    var actor = world[step.actor];
    var payload = typeof step.payload === 'function' ? step.payload({ loopId: loopId, world: world, last: captured[captured.length - 1] }) : step.payload;
    var response = await invoke(world.handler, step.method, actor, payload, step.admin);
    await drain();
    if (!loopId && response.body && (response.body.id || response.body._id)) {
      loopId = String(response.body.id || response.body._id);
    }
    var loop = loopId ? loopById(loopId) : activeLoop();
    var events = takeEvents(world, eventFrom);
    captured.push({
      id: step.id,
      method: step.method,
      actor: step.actor,
      payload: plain(payload),
      response: {
        status: response.status,
        error: response.error,
        bodyMemberStatus: response.body && response.body.members
          ? response.body.members.map(function (member) {
            return {
              id: member.id != null ? String(member.id) : null,
              accountId: member.accountId != null ? String(member.accountId) : (member.memberId != null ? String(member.memberId) : null),
              status: member.status,
            };
          })
          : Array.isArray(response.body)
            ? response.body.map(function (member) {
              return {
                id: member.id != null ? String(member.id) : null,
                accountId: member.accountId != null ? String(member.accountId) : (member.memberId != null ? String(member.memberId) : null),
                status: member.status,
                type: member.type,
                loopId: member.loopId != null ? String(member.loopId) : null,
              };
            })
            : null,
        bodyOwnerRobot: response.body && !Array.isArray(response.body) ? {
          owner: response.body.owner != null ? String(response.body.owner) : null,
          robot: response.body.robot != null ? String(response.body.robot) : null,
          isDeleted: response.body.isDeleted === true,
          isSuspended: response.body.isSuspended === true,
          name: response.body.name || null,
        } : (Array.isArray(response.body) && step.method === 'ListLoops'
          ? response.body.map(function (item) {
            return {
              id: item.id != null ? String(item.id) : null,
              owner: item.owner != null ? String(item.owner) : null,
              robot: item.robot != null ? String(item.robot) : null,
              isDeleted: item.isDeleted === true,
            };
          })
          : null),
      },
      dimensions: snapshot(step.id, loop, events, {
        listedCount: Array.isArray(response.body) ? response.body.length : undefined,
      }),
    });
  }
  return {
    name: name,
    loopId: loopId,
    steps: captured,
    mailCalls: mailCalls.slice(),
    robotReads: robotReads.slice(),
  };
}

async function run() {
  var inviteAcceptList = await runSequence('invite-accept-list', [
    { id: '01-create', method: 'CreateLoop', actor: 'owner', payload: { name: 'Accept Sequence', robotId: 'robot-accept' } },
    { id: '02-invite', method: 'InviteMember', actor: 'owner', payload: function (ctx) {
      return { loopId: ctx.loopId, email: 'accept@fixture.test', firstName: 'Accept', lastName: 'Guest' };
    } },
    { id: '03-accept', method: 'AcceptInvitation', actor: 'guestAccept', payload: function (ctx) {
      return { loopId: ctx.loopId };
    } },
    { id: '04-list', method: 'ListMembers', actor: 'owner', payload: {} },
  ]);

  var inviteDeclineList = await runSequence('invite-decline-list', [
    { id: '01-create', method: 'CreateLoop', actor: 'owner', payload: { name: 'Decline Sequence', robotId: 'robot-decline' } },
    { id: '02-invite', method: 'InviteMember', actor: 'owner', payload: function (ctx) {
      return { loopId: ctx.loopId, email: 'decline@fixture.test', firstName: 'Decline', lastName: 'Guest' };
    } },
    { id: '03-decline', method: 'DeclineInvitation', actor: 'guestDecline', payload: function (ctx) {
      return { loopId: ctx.loopId };
    } },
    { id: '04-list', method: 'ListMembers', actor: 'owner', payload: {} },
  ]);

  var removeThenRead = await runSequence('remove-member-list-read', [
    { id: '01-create', method: 'CreateLoop', actor: 'owner', payload: { name: 'Remove Sequence', robotId: 'robot-remove' } },
    { id: '02-invite', method: 'InviteMember', actor: 'owner', payload: function (ctx) {
      return { loopId: ctx.loopId, email: 'accept@fixture.test', firstName: 'Accept', lastName: 'Guest' };
    } },
    { id: '03-accept', method: 'AcceptInvitation', actor: 'guestAccept', payload: function (ctx) {
      return { loopId: ctx.loopId };
    } },
    { id: '04-remove', method: 'RemoveMember', actor: 'owner', payload: function (ctx) {
      var members = ctx.last.dimensions.memberStatus;
      var guest = null;
      members.forEach(function (member) {
        if (member.accountId === 'guest-accept') guest = member;
      });
      return { loopId: ctx.loopId, id: guest && guest.id };
    } },
    { id: '05-list-members', method: 'ListMembers', actor: 'owner', payload: { statusList: ['removed'] } },
    { id: '06-list-loops', method: 'ListLoops', actor: 'owner', payload: {} },
  ]);

  var createClearRead = await runSequence('create-clear-read', [
    { id: '01-create', method: 'CreateLoop', actor: 'owner', payload: { name: 'Clear Sequence', robotId: 'robot-clear' } },
    { id: '02-clear', method: 'ClearRobot', actor: 'admin', admin: true, payload: { robotId: 'robot-clear' } },
    { id: '03-list-loops', method: 'ListLoops', actor: 'owner', payload: {} },
    { id: '04-get-robot', method: 'GetRobot', actor: 'owner', payload: function (ctx) {
      return { loopId: ctx.loopId };
    } },
  ]);

  var createRemoveRead = await runSequence('create-remove-loop-read', [
    { id: '01-create', method: 'CreateLoop', actor: 'owner', payload: { name: 'RemoveLoop Sequence', robotId: 'robot-rmloop' } },
    { id: '02-remove-loop', method: 'RemoveLoop', actor: 'owner', payload: function (ctx) {
      return { loopId: ctx.loopId };
    } },
    { id: '03-list-loops', method: 'ListLoops', actor: 'owner', payload: {} },
    { id: '04-get-robot', method: 'GetRobot', actor: 'owner', payload: function (ctx) {
      return { loopId: ctx.loopId };
    } },
  ]);

  var report = {
    kind: 'a04-gate1-source-controller-state-sequences',
    sourceRepository: 'jiborobot/srv-account-ws',
    sourceRevision: '6cea43470825657d6a5722162f28c8f233153ee2',
    notificationRevision: 'e42bfe01506a8febf3005ac536fda735bba49d0d',
    node: process.version,
    compiledRoot: compiled,
    compiledLoopCtrlSha256: sha256(fs.readFileSync(path.join(compiled, 'controllers/loop.ctrl.js'))),
    compiledLoopHandlerSha256: sha256(fs.readFileSync(path.join(compiled, 'handlers/loop.handler.js'))),
    compiledIndexSha256: sha256(fs.readFileSync(path.join(compiled, 'index.js'))),
    compiledLoopSchemaSha256: sha256(fs.readFileSync(path.join(compiled, 'schemes/loop.js'))),
    qualification: 'Exact transpiled 6cea handler/controller/schema/index with controlled model/mail/robot seams. LoopUpdated skill "-1" and robot account target are from notification-ws LoopUpdatedHandler, applied to the post-save payload.robot field. No Mongo, Hapi listener, or SNS.',
    sequences: [
      inviteAcceptList,
      inviteDeclineList,
      removeThenRead,
      createClearRead,
      createRemoveRead,
    ],
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({
    node: report.node,
    outputPath: outputPath,
    sequences: report.sequences.map(function (seq) {
      return {
        name: seq.name,
        steps: seq.steps.map(function (step) {
          return { id: step.id, status: step.response.status, skillMinusOne: step.dimensions.skillMinusOne };
        }),
      };
    }),
  }) + '\n');
}

run().catch(function (error) {
  process.stderr.write((error && error.stack || error) + '\n');
  process.exitCode = 1;
});

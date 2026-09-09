#!/usr/bin/env node
'use strict';

// Original generated Loop client 3.0.110 under Node 8. This wrapper only
// sequences actors and records callback results.
var fs = require('fs');
var crypto = require('crypto');
var Loop = require('/client/clients/loop');

var ready = JSON.parse(fs.readFileSync('/review/server-ready.json', 'utf8'));
var results = [];
var outputPath = '/review/sdk-results.json';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shapeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    code: error.code,
    statusCode: error.statusCode,
    message: error.message,
    retryable: error.retryable,
  };
}

function makeClient(port, actor) {
  return new Loop({
    endpoint: 'http://127.0.0.1:' + port,
    region: 'global',
    accessKeyId: actor.accessKeyId,
    secretAccessKey: actor.secretAccessKey,
    maxRetries: 0,
    httpOptions: { timeout: 8000 },
  });
}

function invoke(client, method, params) {
  return new Promise(function (resolve) {
    try {
      client[method](params, function (error, data) {
        resolve({ error: shapeError(error), data: data === undefined ? null : data });
      });
    } catch (error) {
      resolve({ error: shapeError(error), data: null, threw: true });
    }
  });
}

function record(face, id, method, actor, params, response) {
  var data = response.data;
  var memberStatus = null;
  var ownerRobot = null;
  if (data && Array.isArray(data)) {
    memberStatus = data.map(function (member) {
      return {
        id: member.id || null,
        accountId: member.accountId || member.memberId || null,
        status: member.status || null,
        type: member.type || null,
      };
    });
    if (data.length && data[0] && data[0].owner !== undefined) {
      ownerRobot = data.map(function (item) {
        return {
          id: item.id || null,
          owner: item.owner || null,
          robot: item.robot || null,
          isDeleted: item.isDeleted === true,
        };
      });
      memberStatus = null;
    }
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data.members)) {
      memberStatus = data.members.map(function (member) {
        return {
          id: member.id || null,
          accountId: member.accountId || member.memberId || null,
          status: member.status || null,
        };
      });
    }
    ownerRobot = {
      owner: data.owner || null,
      robot: data.robot || null,
      isDeleted: data.isDeleted === true,
      isSuspended: data.isSuspended === true,
      name: data.name || null,
    };
  }
  results.push({
    face: face,
    id: id,
    sdkMethod: method,
    actor: actor,
    params: params,
    error: response.error,
    statusCode: response.error && response.error.statusCode || 200,
    memberStatus: memberStatus,
    ownerRobot: ownerRobot,
    threw: !!response.threw,
  });
  return response;
}

function memberByAccount(data, accountId) {
  var members = data && Array.isArray(data.members) ? data.members : [];
  for (var i = 0; i < members.length; i += 1) {
    if (members[i].accountId === accountId || members[i].memberId === accountId) return members[i];
  }
  return null;
}

async function runFace(face, port, fixture) {
  var owner = makeClient(port, fixture.owner);
  var acceptGuest = makeClient(port, fixture.acceptGuest);
  var declineGuest = makeClient(port, fixture.declineGuest);
  var admin = makeClient(port, fixture.admin);

  var created = await invoke(owner, 'create', { name: face + ' invite sequence', robotId: fixture.robotIdInvite });
  record(face, 's1-01-create', 'create', 'owner', { robotId: fixture.robotIdInvite }, created);
  var loopId = created.data && created.data.id;

  var invited = await invoke(owner, 'inviteMember', {
    loopId: loopId, email: fixture.acceptGuest.email, firstName: 'Accept', lastName: 'Guest',
  });
  record(face, 's1-02-invite-accept', 'inviteMember', 'owner', { loopId: loopId }, invited);

  var accepted = await invoke(acceptGuest, 'acceptInvitation', { loopId: loopId });
  record(face, 's1-03-accept', 'acceptInvitation', 'acceptGuest', { loopId: loopId }, accepted);

  var listedAccept = await invoke(owner, 'listMembers', {});
  record(face, 's1-04-list-after-accept', 'listMembers', 'owner', {}, listedAccept);

  var invitedDecline = await invoke(owner, 'inviteMember', {
    loopId: loopId, email: fixture.declineGuest.email, firstName: 'Decline', lastName: 'Guest',
  });
  record(face, 's1-05-invite-decline', 'inviteMember', 'owner', { loopId: loopId }, invitedDecline);

  var declined = await invoke(declineGuest, 'declineInvitation', { loopId: loopId });
  record(face, 's1-06-decline', 'declineInvitation', 'declineGuest', { loopId: loopId }, declined);

  var listedDecline = await invoke(owner, 'listMembers', {});
  record(face, 's1-07-list-after-decline', 'listMembers', 'owner', {}, listedDecline);

  var acceptMember = memberByAccount(invited.data, fixture.acceptGuest.id);
  var removed = await invoke(owner, 'removeMember', { loopId: loopId, id: acceptMember && acceptMember.id });
  record(face, 's2-01-remove-member', 'removeMember', 'owner', { loopId: loopId, id: acceptMember && acceptMember.id }, removed);

  var listedRemoved = await invoke(owner, 'listMembers', { statusList: ['removed'] });
  record(face, 's2-02-list-removed', 'listMembers', 'owner', { statusList: ['removed'] }, listedRemoved);

  var listedLoops = await invoke(owner, 'list', {});
  record(face, 's2-03-list-loops', 'list', 'owner', {}, listedLoops);

  var createdClear = await invoke(owner, 'create', { name: face + ' clear sequence', robotId: fixture.robotIdClear });
  record(face, 's3-01-create-clear', 'create', 'owner', { robotId: fixture.robotIdClear }, createdClear);
  var clearLoopId = createdClear.data && createdClear.data.id;

  var cleared = await invoke(admin, 'clearRobot', { robotId: fixture.robotIdClear });
  record(face, 's3-02-clear-robot', 'clearRobot', 'admin', { robotId: fixture.robotIdClear }, cleared);

  var listAfterClear = await invoke(owner, 'list', {});
  record(face, 's3-03-list-after-clear', 'list', 'owner', {}, listAfterClear);

  var getAfterClear = await invoke(owner, 'getRobot', { loopId: clearLoopId });
  record(face, 's3-04-get-after-clear', 'getRobot', 'owner', { loopId: clearLoopId }, getAfterClear);

  var createdRemove = await invoke(owner, 'create', { name: face + ' remove-loop sequence', robotId: fixture.robotIdRemove });
  record(face, 's3-05-create-remove-loop', 'create', 'owner', { robotId: fixture.robotIdRemove }, createdRemove);
  var removeLoopId = createdRemove.data && createdRemove.data.id;

  var removedLoop = await invoke(owner, 'remove', { loopId: removeLoopId });
  record(face, 's3-06-remove-loop', 'remove', 'owner', { loopId: removeLoopId }, removedLoop);

  var listAfterRemove = await invoke(owner, 'list', {});
  record(face, 's3-07-list-after-remove-loop', 'list', 'owner', {}, listAfterRemove);

  var getAfterRemove = await invoke(owner, 'getRobot', { loopId: removeLoopId });
  record(face, 's3-08-get-after-remove-loop', 'getRobot', 'owner', { loopId: removeLoopId }, getAfterRemove);
}

(async function () {
  await runFace('account', ready.accountPort, ready.account);
  await runFace('classic', ready.classicPort, ready.classic);
  var report = {
    kind: 'a04-gate1-original-sdk-state-sequences',
    node: process.version,
    clientVersion: require('/client/package.json').version,
    clientPackageSha256: sha256(fs.readFileSync('/client/package.json')),
    candidateRevision: ready.candidateRevision,
    callCount: results.length,
    results: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    node: report.node,
    clientVersion: report.clientVersion,
    calls: report.callCount,
    outputPath: outputPath,
  }));
})().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

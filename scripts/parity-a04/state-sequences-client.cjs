#!/usr/bin/env node
'use strict';

// Original generated Loop client 3.0.110 under Node 8. This wrapper only
// sequences actors and records callback results. SEQUENCE_PHASE=post replays
// the next valid reads after Account/Classic restart and the callback-auth
// boundary; the pre phase is the gate 1 sequence.
var fs = require('fs');
var http = require('http');
var crypto = require('crypto');
var Loop = require('/client/clients/loop');

var readyFile = process.env.SEQUENCE_READY_FILE || '/review/server-ready.json';
var phase = process.env.SEQUENCE_PHASE || 'pre';
var ready = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
var results = [];
var outputPath = process.env.SEQUENCE_OUTPUT || (phase === 'post'
  ? '/review/sdk-post-restart.json'
  : '/review/sdk-results.json');

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
      id: data.id || null,
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

function loadPreResults() {
  return JSON.parse(fs.readFileSync('/review/sdk-results.json', 'utf8'));
}

function preRow(pre, face, id) {
  var rows = pre.results || [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].face === face && rows[i].id === id) return rows[i];
  }
  return null;
}

function rawPost(port, headers, body) {
  return new Promise(function (resolve) {
    var payload = body === undefined ? '' : JSON.stringify(body);
    var requestHeaders = {
      host: '127.0.0.1:' + port,
      'content-type': 'application/x-amz-json-1.1',
      'content-length': Buffer.byteLength(payload),
      connection: 'close',
    };
    Object.keys(headers || {}).forEach(function (key) {
      requestHeaders[key] = headers[key];
    });
    var req = http.request({
      host: '127.0.0.1',
      port: port,
      path: '/',
      method: 'POST',
      headers: requestHeaders,
    }, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString('utf8');
        var parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (error) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    req.on('error', function (error) {
      resolve({ status: 0, error: { message: error.message }, body: null });
    });
    req.end(payload);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function memberIdByAccount(data, accountId) {
  var member = memberByAccount(data, accountId);
  return member && (member.id || member._id) || null;
}

function storeLoops(face) {
  var path = '/review/' + face + '-store.json';
  return JSON.parse(fs.readFileSync(path, 'utf8')).loops || [];
}

function survivingLoopId(face) {
  var live = storeLoops(face).filter(function (loop) {
    return loop.isDeleted !== true && loop.robot;
  });
  return live.length ? live[0]._id : null;
}

function deletedLoopIds(face) {
  return storeLoops(face).filter(function (loop) { return loop.isDeleted === true; }).map(function (loop) { return loop._id; });
}

async function runPostFace(face, port, fixture, pre) {
  var owner = makeClient(port, fixture.owner);
  var listed = await invoke(owner, 'listMembers', {});
  record(face, 'post-01-list-members', 'listMembers', 'owner', {}, listed);

  var listedLoops = await invoke(owner, 'list', {});
  record(face, 'post-02-list-loops', 'list', 'owner', {}, listedLoops);

  var deleted = deletedLoopIds(face);
  var clearLoopId = deleted[0];
  var getAfterClear = await invoke(owner, 'getRobot', { loopId: clearLoopId });
  record(face, 'post-03-get-after-clear', 'getRobot', 'owner', { loopId: clearLoopId }, getAfterClear);

  var removeLoopId = deleted[1] || deleted[0];
  var getAfterRemove = await invoke(owner, 'getRobot', { loopId: removeLoopId });
  record(face, 'post-04-get-after-remove-loop', 'getRobot', 'owner', { loopId: removeLoopId }, getAfterRemove);

  var inviteLoopId = survivingLoopId(face);
  var nextEmail = face + '-post-restart@synthetic.invalid';
  var nextInvite = await invoke(owner, 'inviteMember', {
    loopId: inviteLoopId, email: nextEmail, firstName: 'Post', lastName: 'Restart',
  });
  record(face, 'post-05-next-invite', 'inviteMember', 'owner', { loopId: inviteLoopId, email: nextEmail }, nextInvite);
  await sleep(1500);
  var listedAfterInvite = await invoke(owner, 'listMembers', {});
  record(face, 'post-06-list-after-next-invite', 'listMembers', 'owner', {}, listedAfterInvite);

  var childInvite = await invoke(owner, 'inviteMember', {
    loopId: inviteLoopId, firstName: 'Child', lastName: 'Fixture', isChild: true,
  });
  record(face, 'post-07-invite-child', 'inviteMember', 'owner', { loopId: inviteLoopId, isChild: true }, childInvite);
  var parentId = memberIdByAccount(childInvite.data, fixture.owner.id);
  var childMember = null;
  var members = childInvite.data && childInvite.data.members || [];
  for (var i = 0; i < members.length; i += 1) {
    var account = members[i].account || {};
    if (account.isChild === true || account.firstName === 'Child') childMember = members[i];
  }
  var childId = childMember && (childMember.id || childMember._id);
  var guardian = await invoke(owner, 'setLegalGuardian', {
    loopId: inviteLoopId, childId: childId, parentId: parentId,
  });
  record(face, 'post-08-set-legal-guardian', 'setLegalGuardian', 'owner', {
    loopId: inviteLoopId, childId: childId, parentId: parentId,
  }, guardian);

  var listedAfterGuardian = await invoke(owner, 'listMembers', {});
  record(face, 'post-09-list-after-guardian', 'listMembers', 'owner', {}, listedAfterGuardian);
  var agreementId = null;
  var persisted = storeLoops(face);
  for (var li = 0; li < persisted.length; li += 1) {
    var persistedMembers = persisted[li].members || [];
    for (var mi = 0; mi < persistedMembers.length; mi += 1) {
      if (persistedMembers[mi].agreementId) agreementId = persistedMembers[mi].agreementId;
    }
  }

  var unsignedAgreementForged = await rawPost(port, {
    'x-amz-target': 'Loop_20160324.UpdateAgreementStatus',
    'x-amz-credentials': JSON.stringify({ id: fixture.owner.id, isAdmin: true }),
  }, { agreementId: agreementId });
  results.push({
    face: face,
    id: 'post-10-unsigned-update-agreement-forged-header',
    sdkMethod: 'rawUpdateAgreementStatus',
    actor: 'anonymous-forged-header',
    params: { agreementId: agreementId },
    error: unsignedAgreementForged.status === 200 ? null : { statusCode: unsignedAgreementForged.status, body: unsignedAgreementForged.body },
    statusCode: unsignedAgreementForged.status,
    body: unsignedAgreementForged.body,
    threw: false,
  });

  var unsignedAgreement = await rawPost(port, {
    'x-amz-target': 'Loop_20160324.UpdateAgreementStatus',
  }, { agreementId: agreementId });
  results.push({
    face: face,
    id: 'post-11-unsigned-update-agreement-repeat',
    sdkMethod: 'rawUpdateAgreementStatus',
    actor: 'anonymous',
    params: { agreementId: agreementId },
    error: unsignedAgreement.status === 200 ? null : { statusCode: unsignedAgreement.status, body: unsignedAgreement.body },
    statusCode: unsignedAgreement.status,
    memberStatus: null,
    ownerRobot: null,
    body: unsignedAgreement.body,
    threw: false,
  });

  var ordinary = [
    ['post-12-unsigned-list-loops', 'Loop_20160324.ListLoops', {}],
    ['post-13-unsigned-invite', 'Loop_20160324.InviteLoopMember', { loopId: inviteLoopId, email: 'forged@synthetic.invalid' }],
    ['post-14-unsigned-set-legal-guardian', 'Loop_20160324.SetLegalGuardian', {
      loopId: inviteLoopId, childId: childId, parentId: parentId,
    }],
  ];
  for (var k = 0; k < ordinary.length; k += 1) {
    var unsignedOrdinary = await rawPost(port, { 'x-amz-target': ordinary[k][1] }, ordinary[k][2]);
    results.push({
      face: face,
      id: ordinary[k][0],
      sdkMethod: 'rawUnsigned',
      actor: 'anonymous',
      params: ordinary[k][2],
      error: { statusCode: unsignedOrdinary.status, body: unsignedOrdinary.body },
      statusCode: unsignedOrdinary.status,
      body: unsignedOrdinary.body,
      threw: false,
    });
  }

  var forged = await rawPost(port, {
    'x-amz-target': 'Loop_20160324.ListLoops',
    'x-amz-credentials': JSON.stringify({ id: fixture.owner.id, isAdmin: true }),
  }, {});
  results.push({
    face: face,
    id: 'post-15-forged-x-amz-credentials-list',
    sdkMethod: 'rawForgedCredentials',
    actor: 'forged-internal-metadata',
    params: {},
    error: { statusCode: forged.status, body: forged.body },
    statusCode: forged.status,
    body: forged.body,
    threw: false,
  });

  var listedFinal = await invoke(owner, 'listMembers', {});
  record(face, 'post-16-list-after-callback', 'listMembers', 'owner', {}, listedFinal);
}

(async function () {
  if (phase === 'post') {
    var pre = loadPreResults();
    await runPostFace('account', ready.accountPort, ready.account, pre);
    await runPostFace('classic', ready.classicPort, ready.classic, pre);
    var postReport = {
      kind: 'a04-gate6-original-sdk-post-restart',
      node: process.version,
      clientVersion: require('/client/package.json').version,
      clientPackageSha256: sha256(fs.readFileSync('/client/package.json')),
      candidateRevision: ready.candidateRevision,
      restartCount: ready.restartCount || 0,
      transports: ready.transports || null,
      callCount: results.length,
      results: results,
    };
    fs.writeFileSync(outputPath, JSON.stringify(postReport, null, 2) + '\n');
    console.log(JSON.stringify({
      phase: 'post',
      node: postReport.node,
      clientVersion: postReport.clientVersion,
      calls: postReport.callCount,
      outputPath: outputPath,
    }));
    return;
  }
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

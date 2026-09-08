'use strict';

// Small supplemental control for the source loadMembers projection.  The
// larger source control records sorted keys; this one preserves Object.keys
// order and the JSON-observable null/undefined distinction.
const Account = require('/source/compiled/schemes/account.js');
const Controller = require('/source/compiled/controllers/loop.ctrl.js').default;

function Id(value) { this.value = String(value); }
Id.prototype.toString = function toString() { return this.value; };
Id.prototype.equals = function equals(other) { return other != null && String(other) === this.value; };
function id(value) { return value instanceof Id ? value : new Id(value); }

function toJSON() {
  const members = this.members.map((member) => {
    const result = Object.assign({}, member);
    result.id = result._id;
    delete result._id;
    delete result.invitationCode;
    result.memberId = result.accountId;
    return result;
  });
  return {
    _id: this._id,
    owner: this.owner,
    robot: this.robot,
    members,
    name: this.name,
    created: this.created,
    updated: this.updated,
    isDeleted: false,
    isSuspended: false,
  };
}

function account(value, fields) { return Object.assign({ _id: id(value) }, fields); }

async function run() {
  const owner = id('order-owner');
  const robot = id('order-robot');
  const loop = {
    _id: id('order-loop'), owner, robot, name: 'order-control',
    created: new Date(1700000000000), updated: undefined,
    isDeleted: false, isSuspended: false,
    members: [
      { _id: id('order-owner-member'), accountId: owner, status: 'accepted', enrolled: { face: false, voice: false } },
      { _id: id('order-robot-member'), accountId: robot, status: 'accepted', enrolled: { face: false, voice: false } },
    ],
  };
  loop.toJSON = toJSON;
  const records = new Map([
    [owner.toString(), account(owner, {
      birthday: null, email: 'owner@example.invalid', facebookAccessToken: undefined,
      firstName: 'Owner', gender: null, lastName: 'Owner', phoneNumber: null, photoUrl: null,
    })],
    [robot.toString(), account(robot, {
      birthday: null, email: null, facebookAccessToken: null,
      firstName: undefined, gender: null, lastName: null, phoneNumber: null, photoUrl: null,
      friendlyId: 'order-robot',
    })],
  ]);
  Account.records = records;
  Account.calls = [];
  const ctrl = Object.create(Controller.prototype);
  const human = await ctrl.populateLoop(loop, false);
  const humanAccount = human.members[0].account;

  // Recreate the document for the robot call because populateLoop mutates the
  // toJSON result's member objects in place.
  loop.toJSON = toJSON;
  const robotView = await ctrl.populateLoop(loop, true);
  const robotAccount = robotView.members[1].account;
  process.stdout.write(`${JSON.stringify({
    sourceRevision: '6cea43470825657d6a5722162f28c8f233153ee2',
    humanKeys: Object.keys(humanAccount),
    humanHasFacebookAccessToken: Object.prototype.hasOwnProperty.call(humanAccount, 'facebookAccessToken'),
    humanFacebookAccessToken: humanAccount.facebookAccessToken,
    robotKeys: Object.keys(robotAccount),
    robotHasFacebookAccessToken: Object.prototype.hasOwnProperty.call(robotAccount, 'facebookAccessToken'),
    robotFacebookAccessToken: robotAccount.facebookAccessToken,
    calls: Account.calls,
  }, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

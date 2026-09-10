# jiborobot/srv-robots-ws:src/clients/account.client.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

import { Boom, Wreck } from '@jibo/server';
import querystring from 'querystring';

class AccountClient {
  constructor({ registry }) {
    this.registry = registry;
  }
  wreckRequest(method, uri, payload) {
    return new Promise((resolve, reject) => {
      Wreck[method](uri, { json: true, payload }, function (err, res, payload) {
        if (err) {
          return reject(err);
        }
        if (payload && payload.error) {
          return reject(Boom.create(payload.statusCode, payload.message));
        }
        resolve(payload);
      });
    });
  }
  getBase() {
    const accountBase = this.registry.get('account');
    if (!accountBase) {
      throw Boom.serverUnavailable('Account service not found');
    }
    return accountBase;
  }
  async listRobots(ownerId, owned) {
    const request = {
      ownerId
    };
    if (owned) {
      request.owned = true;
    }
    const query = querystring.stringify(request);
    return await this.wreckRequest('get', `http://${this.getBase()}/robots?${query}`);
  }
}

export default AccountClient;

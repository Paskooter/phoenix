# jiborobot/srv-robots-read-ws:src/clients/account.client.js@decbbf7e959af3dabe2384940cb316b0689a18b4

import { Boom, BaseClient } from '@jibo/server';
import querystring from 'querystring';

class AccountClient extends BaseClient {
  constructor({ registry }) {
    super();
    this.registry = registry;
  }
  getBase() {
    const accountBase = this.registry.get('account');
    if (!accountBase) {
      throw Boom.serverUnavailable('Account service not found');
    }
    return accountBase;
  }
  async listRobots(ownerId) {
    const query = querystring.stringify({ ownerId });
    return await this.wreckGet({uri: `http://${this.getBase()}/robots?${query}`});
  }
}

export default AccountClient;

// A-18 probe #2: production STS provider path (createLpsStsProvider + lpsNewCredentials)
// with a fixed clock. Independently confirms the bucketPath template and 0-based month
// against the pinned sts.ctrl.ts. Run from anywhere inside the repo:
//
//     node docs/parity/evidence/2026-09-10/a18-oauth-lps/lps-provider-probe.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const { createLpsStsProvider, lpsBucketPath, lpsNewCredentials } =
  await import(join(ROOT, 'packages/account/src/lps.js'));

const out = {};

const now = new Date('2025-03-15T12:00:00Z'); // March -> getMonth() === 2
out.fixedClockPath = lpsBucketPath('friendly-1', 'acct-1', now);
out.expectedFromSource = 'lps/robot=friendly-1/account=acct-1/year=2025/month=2/day=15/session=' + now.getTime() + '/';
out.monthIsZeroBased = out.fixedClockPath === out.expectedFromSource;

let assumedArgs;
const provider = createLpsStsProvider({
  assumeRole: async (params) => {
    assumedArgs = params;
    return { Credentials: { AccessKeyId: 'AK', Expiration: 'E', SecretAccessKey: 'SK', SessionToken: 'ST' } };
  },
  config: { server: { bucketName: 'bucket-x', lps: { robotRole: 'arn:role', region: 'us-east-1' } } },
});
out.assumeRoleShape = await provider.newCredentials('acct-9', 'friendly-9');
out.assumeRoleArgs = assumedArgs;
out.assumeRoleArgsExpected = { ExternalId: 'friendly-9_acct-9', RoleArn: 'arn:role', RoleSessionName: 'friendly-9_acct-9' };

const direct = await lpsNewCredentials(async () => ({ Credentials: { AccessKeyId: 'A', Expiration: 'X', SecretAccessKey: 'S', SessionToken: 'T' } }),
  { roleArn: 'arn:role', bucketName: 'b', region: 'r', accountId: 'a', friendlyId: 'f', now });
out.directResponse = direct;

try { await createLpsStsProvider({ config: {} }).newCredentials('a', 'f'); out.unconfigured = 'NO THROW'; }
catch (e) { out.unconfigured = { code: e.code, statusCode: e.statusCode, message: e.message }; }

console.log(JSON.stringify(out, null, 2));

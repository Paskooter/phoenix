import { preflightSigV4, verifySigV4, sendJson } from '@phoenix/common';
import { userFromSession } from '../portal/session.js';
import { ChatError } from './broker.js';

// Private parsing avoids shared-parser syntax errors that can quote speech/keys.
export async function readPrivateJson(req, timeoutMs, withBytes = false) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) throw new ChatError('json_required', 415);
  if (Number(req.headers['content-length']) > 16384) throw new ChatError('request_too_large', 413);
  const bytes = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted);
      if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const data = chunk => { size += chunk.length; if (size > 16384) finish(new ChatError('request_too_large', 413)); else chunks.push(chunk); };
    const end = () => finish(); const aborted = () => finish(new ChatError('request_cancelled', 400));
    const timer = setTimeout(() => finish(new ChatError('request_body_timeout', 408)), timeoutMs);
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted);
  });
  try { const body = JSON.parse(bytes.toString('utf8')); return withBytes ? { body, bytes } : body; }
  catch { throw new ChatError('invalid_json'); }
}

export function freeChatRoutes(store, broker) {
  const wrap = handler => {
    const fn = async ctx => {
      ctx.res.setHeader('cache-control', 'no-store');
      try { broker.allowAddress(ctx.req.socket.remoteAddress); return await handler(ctx); }
      catch (error) {
        const safe = error instanceof ChatError ? error : new ChatError('chat_unavailable', 503);
        if (ctx.res.destroyed) return;
        if (!ctx.req.complete) ctx.res.setHeader('connection', 'close');
        if (safe.retryAfter) ctx.res.setHeader('retry-after', String(safe.retryAfter));
        return sendJson(ctx.res, safe.status, { error: { code: safe.code } });
      } finally { ctx.req.resume(); }
    };
    fn.rawRequest = true; return fn;
  };
  const owner = handler => wrap(async ctx => {
    const account = userFromSession(store, ctx.req);
    if (!account) throw new ChatError('auth_required', 401);
    broker.human(account); const version = account.sessionVersion ?? 0;
    const recheck = () => {
      const current = userFromSession(store, ctx.req);
      if (!current || current._id !== account._id || (current.sessionVersion ?? 0) !== version) throw new ChatError('auth_required', 401);
      return broker.human(current);
    };
    return handler(ctx, recheck);
  });
  const robot = handler => wrap(async ctx => {
    const { req } = ctx;
    const options = { method: req.method, path: req.originalUrl || req.url, headers: req.headers,
      allowNativeClientPayloadHash: true, resolveCredentials: accessKey => {
        const account = store.accountByAccessKeyId(accessKey);
        return account?.friendlyId && account.isActive === true && !account.isDeleted ? account : null;
      } };
    try { preflightSigV4(options); } catch { throw new ChatError('invalid_auth', 401); }
    const { body, bytes } = await readPrivateJson(req, broker.config.bodyTimeoutMs, true);
    let robotAccount;
    try { robotAccount = verifySigV4({ ...options, body: bytes }).credentials; } catch { throw new ChatError('invalid_auth', 401); }
    const robotId = robotAccount._id; const accessKey = robotAccount.accessKeyId; const secret = robotAccount.secretAccessKey;
    const resolve = () => {
      const current = store.accounts.get(robotId);
      if (!current || current.isActive !== true || current.isDeleted || !current.friendlyId
        || current.accessKeyId !== accessKey || current.secretAccessKey !== secret) throw new ChatError('invalid_auth', 401);
      const loops = [...store.loops.values()].filter(loop => String(loop.robot) === String(robotId) && !loop.isDeleted);
      if (loops.length !== 1) throw new ChatError('robot_not_linked', 403);
      return broker.current(String(loops[0].owner));
    };
    const account = resolve(); const version = account.sessionVersion ?? 0;
    const recheck = () => {
      const current = resolve();
      if (current._id !== account._id || (current.sessionVersion ?? 0) !== version) throw new ChatError('invalid_auth', 401);
      return current;
    };
    return handler(ctx, body, recheck);
  });
  return {
    'GET /api/free-chat': owner((_ctx, recheck) => broker.status(recheck())),
    'PUT /api/free-chat': owner(async ({ req }, recheck) => { const body = await readPrivateJson(req, broker.config.bodyTimeoutMs); return broker.setSettings(recheck(), body); }),
    'PUT /api/free-chat/key': owner(async ({ req }, recheck) => { const body = await readPrivateJson(req, broker.config.bodyTimeoutMs); return broker.setKey(recheck(), body); }),
    'POST /api/free-chat/robot/settings': robot((_ctx, body, recheck) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ChatError('invalid_settings');
      return Object.keys(body).length ? broker.setSettings(recheck(), body) : broker.status(recheck());
    }),
    'POST /api/free-chat/robot/complete': robot(async ({ res }, body, recheck) => {
      const controller = new AbortController(); const close = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', close);
      try { return await broker.complete(recheck(), body, recheck, controller.signal); }
      finally { res.off('close', close); }
    }),
  };
}

export function freeChatConfigFromEnv(env = process.env) {
  return { defaultEnabled: env.PHOENIX_FREE_CHAT_ENABLED !== 'false', ledgerFile: env.PHOENIX_FREE_CHAT_LEDGER,
    provider: { apiKey: env.PHOENIX_FREE_CHAT_API_KEY },
    encryptionKey: env.PHOENIX_FREE_CHAT_ENCRYPTION_KEY ? Buffer.from(env.PHOENIX_FREE_CHAT_ENCRYPTION_KEY, 'hex') : undefined };
}

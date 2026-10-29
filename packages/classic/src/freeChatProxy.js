import { sendJson } from '@phoenix/common';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Fixed Account hop; never use a caller's destination or forward cookies and
// asserted identities. Account verifies the original signed method/path/body.
export function freeChatProxyRoutes(accountBase) {
  const route = operation => {
    const fn = async ({ req, res }) => {
      res.setHeader('cache-control', 'no-store');
      const controller = new AbortController(); let timer;
      const close = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', close);
      const fail = (code, status) => { if (!res.headersSent && !res.destroyed) sendJson(res, status, { error: { code } }); };
      try {
        if (typeof req.headers.authorization !== 'string' || !req.headers.authorization.startsWith('AWS4-HMAC-SHA256 ')) return fail('invalid_auth', 401);
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) return fail('json_required', 415);
        if (Number(req.headers['content-length']) > 16384) return fail('request_too_large', 413);
        const bytes = await new Promise((resolve, reject) => {
          const chunks = []; let size = 0;
          const done = error => {
            clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted);
            if (error) reject(error); else resolve(Buffer.concat(chunks));
          };
          const data = chunk => { size += chunk.length; if (size > 16384) done(new Error('size')); else chunks.push(chunk); };
          const end = () => done(); const aborted = () => done(new Error('aborted'));
          timer = setTimeout(() => done(new Error('timeout')), 5000);
          req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted);
        });
        const headers = {};
        for (const name of ['authorization', 'host', 'content-type', 'x-amz-date', 'x-amz-content-sha256', 'x-free-chat-request']) {
          if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
        }
        timer = setTimeout(() => controller.abort(), 25000);
        const destination = new URL('/api/free-chat/robot/' + operation, accountBase());
        const response = await new Promise((resolve, reject) => {
          const client = destination.protocol === 'https:' ? httpsRequest : httpRequest;
          const request = client(destination, { method: 'POST', headers, signal: controller.signal }, upstream => {
            const chunks = []; let size = 0;
            upstream.on('data', chunk => { size += chunk.length; if (size > 65536) { request.destroy(); reject(new Error('size')); } else chunks.push(chunk); });
            upstream.on('error', reject); upstream.on('aborted', () => reject(new Error('peer')));
            upstream.on('end', () => resolve({ status: upstream.statusCode, headers: upstream.headers, bytes: Buffer.concat(chunks) }));
          });
          request.on('error', reject); request.end(bytes);
        });
        const value = JSON.parse(response.bytes.toString('utf8'));
        // The peer's safe, content-free errors only. Never relay arbitrary bodies.
        if (response.status !== 200) {
          const code = value?.error?.code;
          if (!/^[a-z_]{1,60}$/.test(code || '')) throw new Error('peer');
          const retry = response.headers['retry-after']; if (/^\d{1,4}$/.test(retry || '')) res.setHeader('retry-after', retry);
          return fail(code, response.status);
        }
        return sendJson(res, 200, value);
      } catch { return fail('chat_unavailable', 503); }
      finally { clearTimeout(timer); res.off('close', close); req.resume(); }
    };
    fn.rawRequest = true; return fn;
  };
  return { 'POST /api/free-chat/robot/complete': route('complete'), 'POST /api/free-chat/robot/settings': route('settings') };
}

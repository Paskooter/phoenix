import { createHash } from 'node:crypto';

export function normalizeHttp(row) {
  if (!row) return row;
  const value = structuredClone(row);
  delete value.headers.date;
  let body;
  try { body = JSON.parse(value.body); } catch { return value; }
  if (body.type === 'ERROR' && typeof body.ts === 'number' && typeof body.msgID === 'string') {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.msgID)) throw new Error('Invalid error message UUID');
    const expectedEtag = `W/"${Buffer.byteLength(value.body).toString(16)}-${createHash('sha1').update(value.body).digest('base64').slice(0, 27)}"`;
    if (value.headers.etag !== expectedEtag) throw new Error('ETag does not cover error body');
    body.msgID = '<uuid>';
    body.ts = '<time>';
    value.body = JSON.stringify(body);
    value.headers.etag = '<validated-body-etag>';
  }
  return value;
}

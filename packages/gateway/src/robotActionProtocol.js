// A narrow, ephemeral native BE channel. Identity comes from the authenticated
// upgrade, never from a receiver frame or an announcement's text.
export const ROBOT_ACTION_PATH = '/v1/robot-actions';
export const ROBOT_ACTION_VERSION = 1;
export const MAX_ROBOT_ACTION_FRAME_BYTES = 8192;
export const MAX_ANNOUNCEMENT_TEXT = 300;
export const MAX_ROBOT_ACTION_TIMEOUT_MS = 45_000;
export const ROBOT_ACTION_STATUS_MAX_AGE_MS = 30_000;
export const ROBOT_ACTION_CODES = new Set([
  'invalid_request', 'expired', 'busy', 'interrupted', 'speech_failed',
  'timeout', 'disconnected', 'unavailable',
]);

export const actionError = (code) => ({ outcome: 'error', code });
export const actionUncertain = (code = 'confirmation_lost') => ({ outcome: 'uncertain', code });

export function robotIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['id', 'accessKeyId', 'friendlyId']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 200
      || /[\u0000-\u001f\u007f]/.test(value[key])) return null;
  }
  return { id: value.id, accessKeyId: value.accessKeyId, friendlyId: value.friendlyId };
}

export const sameRobotIdentity = (a, b) => !!a && !!b
  && a.id === b.id && a.accessKeyId === b.accessKeyId && a.friendlyId === b.friendlyId;

export const isRequestId = (value) => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

export function validateAnnouncement(value, now) {
  if (value && Object.hasOwn(value, 'volume')) return 'unsupported_volume';
  if (!value || !robotIdentity(value.identity) || !isRequestId(value.requestId)
    || typeof value.authorizationId !== 'string' || value.authorizationId.length !== 73
    || !isRequestId(value.authorizationId.slice(0, 36)) || value.authorizationId[36] !== ':'
    || value.authorizationId.slice(37).toLowerCase() !== value.requestId.toLowerCase()
    || typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_ANNOUNCEMENT_TEXT
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)
    || !Number.isSafeInteger(value.deadline) || value.deadline < 0
    || value.deadline > now + MAX_ROBOT_ACTION_TIMEOUT_MS) {
    return 'invalid_request';
  }
  return value.deadline <= now ? 'expired' : null;
}

export function validReceiverFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.v !== ROBOT_ACTION_VERSION) return false;
  const keys = frame.type === 'ready' ? ['v', 'type', 'capabilities', 'busy', 'active_request_id']
    : frame.type === 'status' ? ['v', 'type', 'busy', 'active_request_id']
      : frame.type === 'action_result' ? ['v', 'type', 'request_id', 'outcome', 'confirmed', 'code'] : null;
  if (!keys || Object.keys(frame).some((key) => !keys.includes(key))) return false;
  if (frame.type === 'ready' || frame.type === 'status') {
    // Ordinary native busy state is distinct from retained announcement speech.
    // The latter restores admission after either endpoint's process replacement.
    if (typeof frame.busy !== 'boolean' || (frame.active_request_id !== null
      && (!isRequestId(frame.active_request_id) || !frame.busy))) return false;
    return frame.type === 'status' || (Array.isArray(frame.capabilities)
      && frame.capabilities.length === 1 && frame.capabilities[0] === 'announce');
  }
  return isRequestId(frame.request_id) && ['completed', 'rejected', 'uncertain'].includes(frame.outcome)
    && (frame.confirmed === undefined || typeof frame.confirmed === 'boolean')
    && (frame.code === undefined || ROBOT_ACTION_CODES.has(frame.code));
}

export function receiverResult(frame) {
  if (frame.outcome === 'completed' && frame.confirmed === true) return { outcome: 'success', confirmed: true };
  // Only these rejections describe a definite refusal before speech begins.
  if (frame.outcome === 'rejected' && frame.confirmed !== true
    && ['invalid_request', 'expired', 'busy', 'unavailable'].includes(frame.code)) return actionError(frame.code);
  return actionUncertain(frame.code || 'confirmation_lost');
}

// A route-local observer; common HTTP parsing, response and error behavior stay
// unchanged. Handler completion is not proof that the peer received the reply.
import { createParserBoundary, PARSER_REQUEST_HEADER } from '@phoenix/common';

export function observeParserRoute(handler) {
  return async (context) => {
    const { req, res } = context;
    const boundary = createParserBoundary('parser', req.headers[PARSER_REQUEST_HEADER]);
    const cleanup = () => {
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);
    };
    const onFinish = () => { cleanup(); boundary.response(res.statusCode); };
    const onClose = () => {
      cleanup();
      if (!res.writableFinished) boundary.interrupt('peer_disconnect');
    };
    res.once('finish', onFinish);
    res.once('close', onClose);
    try {
      const result = await handler(context);
      boundary.complete('ok');
      return result;
    } catch (error) {
      boundary.complete('error');
      throw error;
    }
  };
}

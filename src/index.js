import { runCheck } from './check.js';
import { HttpError, errorResponse } from './http.js';
import { requestLinkCode, verifyLinkCode } from './linking.js';
import {
  addPushDevice,
  confirmSubscription,
  deleteSubscription,
  getPushKey,
  getStatus,
  getSubscription,
  oneClickUnsubscribe,
  removePushDevice,
  requestSubscription,
  testPush,
  updateSubscription,
} from './subscriptions.js';

// Method + path -> handler. Static files in public/ are served by Workers
// Assets before this code runs, so only API paths reach the router.
const routes = {
  'POST /api/subscriptions': requestSubscription,
  'POST /api/subscriptions/confirm': confirmSubscription,
  'GET /api/subscription': getSubscription,
  'PATCH /api/subscription': updateSubscription,
  'DELETE /api/subscription': deleteSubscription,
  'GET /api/status': getStatus,
  'GET /api/push/key': getPushKey,
  'POST /api/subscription/push': addPushDevice,
  'DELETE /api/subscription/push': removePushDevice,
  'POST /api/subscription/push/test': testPush,
  'POST /api/link/request': requestLinkCode,
  'POST /api/link/verify': verifyLinkCode,
  'POST /api/unsubscribe': oneClickUnsubscribe,
};

const knownPaths = new Set(Object.keys(routes).map((r) => r.split(' ')[1]));

export async function handleRequest(request, env, ctx) {
  const { pathname } = new URL(request.url);
  try {
    const handler = routes[`${request.method} ${pathname}`];
    if (handler) return await handler(request, env, ctx);
    if (knownPaths.has(pathname)) throw new HttpError(405, 'Method not allowed.');
    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
    return env.ASSETS.fetch(request);
  } catch (err) {
    return errorResponse(err);
  }
}

export default {
  fetch: handleRequest,

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
};

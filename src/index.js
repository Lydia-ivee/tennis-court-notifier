import { runCheck } from './check.js';
import { HttpError, errorResponse } from './http.js';
import {
  confirmSubscription,
  deleteSubscription,
  getSubscription,
  oneClickUnsubscribe,
  requestSubscription,
} from './subscriptions.js';

// Method + path -> handler. Static files in public/ are served by Workers
// Assets before this code runs, so only API paths reach the router.
const routes = {
  'POST /api/subscriptions': requestSubscription,
  'POST /api/subscriptions/confirm': confirmSubscription,
  'GET /api/subscription': getSubscription,
  'DELETE /api/subscription': deleteSubscription,
  'POST /api/unsubscribe': oneClickUnsubscribe,
};

const knownPaths = new Set(Object.keys(routes).map((r) => r.split(' ')[1]));

export async function handleRequest(request, env) {
  const { pathname } = new URL(request.url);
  try {
    const handler = routes[`${request.method} ${pathname}`];
    if (handler) return await handler(request, env);
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

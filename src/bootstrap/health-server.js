import http from 'node:http';
import { safeError } from '../shared/redaction.js';

export function createHealthState() {
  return {
    live: true,
    ready: false,
    status: 'NOT_READY',
    startedAt: new Date().toISOString(),
    checks: {},
    workers: {},
    overview: {},
    lastError: null,
  };
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export async function startHealthServer({ port, statusToken, state }) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET') return writeJson(response, 405, { ok: false });
    if (url.pathname === '/livez') return writeJson(response, state.live ? 200 : 503, { ok: state.live });
    if (url.pathname === '/readyz') {
      return writeJson(response, state.ready ? 200 : 503, {
        ok: state.ready,
        status: state.status,
      });
    }
    if (url.pathname === '/statusz') {
      if (request.headers.authorization !== `Bearer ${statusToken}`) {
        return writeJson(response, 401, { ok: false });
      }
      return writeJson(response, 200, {
        ok: state.ready,
        status: state.status,
        startedAt: state.startedAt,
        checks: state.checks,
        workers: state.workers,
        overview: state.overview,
        lastError: state.lastError ? safeError(state.lastError) : null,
      });
    }
    return writeJson(response, 404, { ok: false });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  return server;
}

export async function closeHealthServer(server) {
  if (!server?.listening) return;
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

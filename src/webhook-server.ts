/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance.
 */
import http from 'http';

import type { Chat } from 'chat';

import { log } from './log.js';

const DEFAULT_PORT = 3000;

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

/**
 * Custom (non-Chat-SDK) webhook route. Receives the RAW request body bytes —
 * not a Web `Request` whose stream has already been consumed — so handlers
 * that must verify signatures over the exact bytes (e.g. GitHub's
 * `X-Hub-Signature-256` HMAC) can do so. Returns a Web `Response`.
 */
export type CustomRouteHandler = (body: Buffer, headers: Record<string, string>, method: string) => Promise<Response>;

const routes = new Map<string, WebhookEntry>();
const customRoutes = new Map<string, CustomRouteHandler>();
let server: http.Server | null = null;

// Reject absurdly large bodies before buffering them — defense against memory
// abuse on the public-facing (tunnelled) webhook port.
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB

/** Buffer the full request body, capped at MAX_BODY_BYTES. */
async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function flattenHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }
  return headers;
}

/** Build a Web API Request from an already-buffered body. */
function toWebRequest(req: http.IncomingMessage, body: Buffer): Request {
  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers: flattenHeaders(req),
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string): void {
  routes.set(adapterName, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${adapterName}` });
}

/**
 * Register a custom (non-Chat-SDK) webhook route at an exact path, e.g.
 * `/webhook/github-deploy`. Checked before the `/webhook/{adapterName}`
 * dispatch. Starts the server if it isn't already running.
 */
export function registerWebhookRoute(routePath: string, handler: CustomRouteHandler): void {
  customRoutes.set(routePath, handler);
  ensureServer();
  log.info('Webhook route registered', { path: routePath });
}

/** Force the webhook server to start even with no Chat SDK adapters. */
export function startWebhookServer(): void {
  ensureServer();
}

function ensureServer(): void {
  if (server) return;

  const port = parseInt(process.env.WEBHOOK_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      log.warn('Rejected oversized webhook body', { url, err });
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload Too Large');
      return;
    }

    // Custom routes (exact path) take precedence over adapter dispatch.
    const custom = customRoutes.get(pathname);
    if (custom) {
      try {
        const webRes = await custom(body, flattenHeaders(req), req.method || 'GET');
        await fromWebResponse(webRes, res);
      } catch (err) {
        log.error('Custom webhook handler error', { path: pathname, err });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }

    // Route: /webhook/{adapterName}
    const match = url.match(/^\/webhook\/([^/?]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const adapterName = match[1];
    const entry = routes.get(adapterName);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Unknown adapter: ${adapterName}`);
      return;
    }

    try {
      const webReq = toWebRequest(req, body);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
      const handler = webhooks[entry.adapterName];
      const webRes = await handler(webReq, {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
      });
      await fromWebResponse(webRes, res);
    } catch (err) {
      log.error('Webhook handler error', { adapter: adapterName, url: req.url, err });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()], customRoutes: [...customRoutes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    customRoutes.clear();
    log.info('Webhook server stopped');
  }
}

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { assertPublicHost, isBlockedHostname, type Resolver } from '../net/ssrf.js';

export interface PolicyProxyOptions {
  allowPrivate: boolean;
  resolver?: Resolver;
  /** Host-level scope decision; subresources from public third parties are normally allowed. */
  isHostAllowed: (hostname: string) => boolean;
  /** Cache resolved addresses for this long. Short, so a rebinding name is re-checked. */
  dnsTtlMs?: number;
}

export interface ProxyRefusal {
  host: string;
  port: number;
  reason: string;
}

/**
 * Local forward proxy that enforces the SSRF policy at the connection level for
 * the browser. Every CONNECT (HTTPS) and plain-HTTP request names a host; the
 * proxy resolves it through WebMorph's resolver, refuses blocked and private
 * targets, and dials the exact address it checked. Chromium never resolves DNS
 * itself, redirect hops cannot escape it, and WebSockets go through it too.
 */
export class PolicyProxy {
  private server?: http.Server;
  private readonly cache = new Map<string, { address: string; family: number; expires: number }>();
  readonly refusals: ProxyRefusal[] = [];
  readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: PolicyProxyOptions) {}

  get url(): string {
    const addr = this.server?.address() as AddressInfo | null;
    if (!addr) throw new Error('proxy not started');
    return `http://127.0.0.1:${addr.port}`;
  }

  async start(): Promise<string> {
    if (this.server) return this.url;
    const server = http.createServer((req, res) => void this.handleHttp(req, res));
    server.on('connect', (req, socket, head) => void this.handleConnect(req, socket as net.Socket, head));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    return this.url;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private refuse(host: string, port: number, reason: string): void {
    if (this.refusals.length < 100) this.refusals.push({ host, port, reason });
  }

  /** Resolve and check a host; returns the address to dial or a refusal reason. */
  private async check(host: string, port: number): Promise<{ address: string } | { error: string }> {
    const lower = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (!this.options.allowPrivate && isBlockedHostname(lower)) return { error: 'blocked host' };
    if (!this.options.isHostAllowed(lower)) return { error: 'host not allowed by scope policy' };
    const cached = this.cache.get(lower);
    if (cached && cached.expires > Date.now()) return { address: cached.address };
    try {
      const addresses = await assertPublicHost(lower, { allowPrivate: this.options.allowPrivate, resolver: this.options.resolver });
      const first = addresses[0]!;
      this.cache.set(lower, { address: first.address, family: first.family, expires: Date.now() + (this.options.dnsTtlMs ?? 30_000) });
      return { address: first.address };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    void port;
  }

  private async handleConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const [hostRaw, portRaw] = splitHostPort(req.url ?? '');
    const port = Number(portRaw || 443);
    const verdict = await this.check(hostRaw, port);
    if ('error' in verdict) {
      this.refuse(hostRaw, port, verdict.error);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = net.connect({ host: verdict.address, port });
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('proxy: absolute URL required');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('proxy: only http is forwarded here');
      return;
    }
    const port = Number(target.port || 80);
    const verdict = await this.check(target.hostname, port);
    if ('error' in verdict) {
      this.refuse(target.hostname, port, verdict.error);
      res.writeHead(403, { connection: 'close' }).end('refused by policy');
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    for (const h of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']) delete headers[h];
    headers['host'] = target.host;
    const upstream = http.request({ host: verdict.address, port, path: `${target.pathname}${target.search}`, method: req.method, headers, setHost: false }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.once('error', () => {
      if (!res.headersSent) res.writeHead(502, { connection: 'close' });
      res.end();
    });
    req.pipe(upstream);
  }
}

function splitHostPort(s: string): [string, string] {
  const m = s.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  return m ? [m[1]!, m[2] ?? ''] : [s, ''];
}

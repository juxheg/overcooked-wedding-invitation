/* ============================================================================
 * E2E 测试服务器（仅本地测试用，不部署）
 * 运行：node scripts/e2e_rsvp_server.mjs
 *
 * 端口 8788：端点模式——/config.js 在内存中把 rsvpEndpoint 注入为 '/api/rsvp'
 *           （不修改仓库文件，公开模板默认保持关闭）
 * 端口 8789：演示模式——原样返回 config.js（rsvpEndpoint 留空）
 * /api/rsvp、/api/rsvps：转发给真实的 edge-functions 处理器 + 内存 MockKV
 * 控制端点（仅本机）：
 *   POST /_e2e/fail?on=1 | ?off   模拟后端故障（/api/rsvp 直接 500）
 *   GET  /_e2e/kv                  查看 KV 当前内容
 *   POST /_e2e/reset               清空 KV（含限流计数）
 * ========================================================================== */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rsvpApi from '../edge-functions/api/rsvp.js';
import * as rsvpsApi from '../edge-functions/api/rsvps.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TOKEN = 'e2e-test-token-0123456789abcdef';

class MemoryKV {
  constructor() { this.map = new Map(); }

  async put(key, value) { this.map.set(key, String(value)); }

  async get(key, opts) {
    const value = this.map.get(key);
    if (value === undefined) return null;
    const type = typeof opts === 'string' ? opts : opts && opts.type;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async delete(key) { this.map.delete(key); }

  async list({ prefix = '', limit = 256, cursor } = {}) {
    let keys = Array.from(this.map.keys()).filter((k) => k.startsWith(prefix)).sort();
    if (cursor) keys = keys.filter((k) => k >= cursor);
    const page = keys.slice(0, limit);
    const complete = keys.length <= limit;
    return { complete, cursor: complete ? null : keys[limit], keys: page.map((key) => ({ key })) };
  }
}

const kv = new MemoryKV();
globalThis.RSVP_KV = kv;
let failMode = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(res, urlPath, inject) {
  const clean = (urlPath === '/' ? '/index.html' : urlPath).split('?')[0];
  const file = path.join(PUBLIC_DIR, clean);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    let data = await readFile(file);
    if (inject && clean === '/config.js') {
      data = Buffer.from(data.toString('utf8').replace("rsvpEndpoint: ''", "rsvpEndpoint: '/api/rsvp'"));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(clean)] || 'application/octet-stream' });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function callHandler(handler, req, res, href) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const hasBody = !['GET', 'HEAD'].includes(req.method) && body.length > 0;
  const request = new Request(href, {
    method: req.method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1', // E2E 全部同 IP，限流用 /_e2e/reset 复位
    },
    body: hasBody ? body.toString('utf8') : undefined,
  });
  const response = await handler({ request, env: { RSVP_KV: kv, RSVP_TOKEN: TOKEN } });
  const headers = Object.fromEntries(response.headers);
  headers['access-control-allow-origin'] = '*'; // 方便测试页面内 fetch 校验
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function makeServer(inject) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/rsvp' && req.method === 'POST') {
        if (failMode) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"simulated failure"}');
          return;
        }
        await callHandler(rsvpApi.onRequestPost, req, res, url.href);
        return;
      }
      if (url.pathname === '/api/rsvps' && req.method === 'GET') {
        await callHandler(rsvpsApi.onRequestGet, req, res, url.href);
        return;
      }
      if (url.pathname === '/_e2e/fail' && req.method === 'POST') {
        failMode = url.searchParams.get('on') === 'off' ? false : true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ failMode }));
        return;
      }
      if (url.pathname === '/_e2e/kv' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Object.fromEntries(kv.map), null, 2));
        return;
      }
      if (url.pathname === '/_e2e/reset' && req.method === 'POST') {
        kv.map.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"reset":true}');
        return;
      }
      await serveStatic(res, url.pathname, inject);
    } catch (error) {
      console.error('[E2E SERVER]', error);
      res.writeHead(500);
      res.end(String((error && error.message) || error));
    }
  });
}

makeServer(true).listen(8788);
makeServer(false).listen(8789);
console.log('E2E server ready:');
console.log('  http://localhost:8788  (端点模式: rsvpEndpoint=/api/rsvp)');
console.log('  http://localhost:8789  (演示模式: 原样 config.js)');

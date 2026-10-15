/**
 * Tiny static server for the SPP smoke test.
 *
 * Serves:
 *   /sdk/*               → third_party/spp-sdk (the source-built runtime)
 *   /circuits.json       → the pinned circuit lock
 *   /circuits/*          → third_party/spp-circuits (pinned ceremony artifacts)
 *   /deployments.json    → the pinned testnet deployment config
 *   /friendbot?addr=…    → testnet faucet proxy (avoids page CORS concerns)
 *   everything else      → scripts/spp-smoke/*
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const SDK = join(ROOT, 'third_party', 'spp-sdk');
const CIRCUITS = join(ROOT, 'third_party', 'spp-circuits');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.r1cs': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveFile(res, filePath, type) {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': type ?? MIME[extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // The wasm glue uses fetch() for circuits; same-origin so this is belt
      // and braces, but harmless.
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export function startServer(port = 8788) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/friendbot') {
      const addr = url.searchParams.get('addr') ?? '';
      if (!/^[A-Z2-7]{56}$/.test(addr)) {
        res.writeHead(400).end(JSON.stringify({ error: 'invalid address' }));
        return;
      }
      try {
        const response = await fetch(
          `https://friendbot.stellar.org/?addr=${encodeURIComponent(addr)}`,
        );
        const body = await response.text();
        res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(body);
      } catch (error) {
        res.writeHead(502).end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (url.pathname === '/circuits.json') {
      if (await serveFile(res, join(CIRCUITS, 'circuits.json'))) return;
      res.writeHead(404).end('not found');
      return;
    }

    if (url.pathname.startsWith('/circuits/')) {
      // The deployment's pinned ceremony artifacts (vendored in the repo).
      const relative = normalize(url.pathname.replace(/^\/circuits\//, ''));
      const filePath = join(ROOT, 'third_party', 'spp-circuits', relative);
      if (!filePath.startsWith(join(ROOT, 'third_party'))) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (await serveFile(res, filePath)) return;
      res.writeHead(404).end('not found');
      return;
    }

    if (url.pathname.startsWith('/sdk/')) {
      const relative = normalize(url.pathname.replace(/^\/sdk\//, ''));
      const filePath = join(SDK, relative);
      if (!filePath.startsWith(SDK)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (await serveFile(res, filePath)) return;
      res.writeHead(404).end('not found');
      return;
    }

    if (url.pathname === '/deployments.json') {
      if (await serveFile(res, join(HERE, 'deployments.json'))) return;
      res.writeHead(404).end('not found');
      return;
    }

    const relative = normalize(url.pathname.replace(/^\//, ''));
    const filePath = join(HERE, relative);
    if (filePath.startsWith(HERE) && (await serveFile(res, filePath))) return;
    res.writeHead(404).end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

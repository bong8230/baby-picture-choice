// Entry point: load config.json, open the store, finish any interrupted finalize, and listen on
// 127.0.0.1 only. Tailscale serve/funnel (port 10000) proxies to this address.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from './src/routes.js';
import { createStore } from './src/store.js';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

export async function main() {
  let config;
  try {
    config = JSON.parse(await readFile(join(APP_DIR, 'config.json'), 'utf8'));
  } catch (e) {
    console.error(`cannot read config.json (copy config.example.json): ${e.message}`);
    process.exit(1);
  }
  if (!config.adminLogin) console.error('WARNING: config.adminLogin is empty; admin pages are disabled');
  const port = Number.isInteger(config.port) ? config.port : 8790;

  const store = createStore(APP_DIR);
  try {
    const n = await store.resumeFinalize();
    if (n) console.log(`resumed finalize for ${n} week(s)`);
  } catch (e) {
    // Never block boot: a stuck week retries on its next state load.
    console.error('resumeFinalize failed (will retry on next load):', e);
  }

  const server = createServer({ rootDir: APP_DIR, config, store });
  // This Windows host sometimes fails listen() with a spurious EFAULT; retry a few times.
  for (let i = 0; ; i++) {
    try {
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, HOST, () => { server.off('error', fail); ok(); });
      });
      break;
    } catch (e) {
      if (e.code !== 'EFAULT' || i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  console.log(`listening on http://${HOST}:${port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

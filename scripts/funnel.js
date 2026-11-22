import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = '10000';
const TARGET = 'http://127.0.0.1:8790';
const mode = process.argv[2];

// Run tailscale; returns { ok, out }. Never exits, so the guard can still run after a failure.
function ts(args) {
  try {
    return { ok: true, out: execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    console.error(`tailscale ${args.join(' ')} failed:\n${e.stderr || e.message}`);
    return { ok: false, out: '' };
  }
}

function serveStatus() {
  const r = ts(['serve', 'status', '--json']);
  if (!r.ok) {
    console.error('cannot read serve status; aborting');
    process.exit(1);
  }
  const out = r.out.trim();
  return out ? JSON.parse(out) : {};
}

const isPort = (key) => key.split(':').pop() === PORT;

// Everything except port 10000, for TCP and Web entries (and any other top-level keys).
function others(cfg) {
  const rest = {};
  for (const [section, val] of Object.entries(cfg || {})) {
    if (section === 'TCP' || section === 'Web' || section === 'AllowFunnel') {
      const kept = Object.entries(val || {}).filter(([k]) => !isPort(k));
      // Empty sections equal absent ones (tailscale emits "AllowFunnel": {} after funnel off).
      if (kept.length) rest[section] = Object.fromEntries(kept);
    } else {
      rest[section] = val;
    }
  }
  return rest;
}

function state10000(cfg) {
  const webKey = Object.keys(cfg.Web || {}).find(isPort);
  const hasTcp = Object.keys(cfg.TCP || {}).includes(PORT);
  const funnelKey = Object.entries(cfg.AllowFunnel || {}).find(([k, v]) => isPort(k) && v);
  if (funnelKey) return 'funnel';
  if (webKey || hasTcp) return 'tailnet';
  return 'off';
}

if (!['on', 'off', 'status'].includes(mode)) {
  console.error('usage: node scripts/funnel.js <on|off|status>');
  process.exit(2);
}

const before = serveStatus();
let commandsOk = true;

if (mode === 'on') {
  commandsOk = ts(['funnel', '--bg', `--https=${PORT}`, TARGET]).ok;
} else if (mode === 'off') {
  // Failure is expected when funnel is not on; only a problem if the final state says so.
  const offOk = ts(['funnel', `--https=${PORT}`, 'off']).ok;
  const serveOk = ts(['serve', '--bg', `--https=${PORT}`, TARGET]).ok;
  commandsOk = serveOk;
  if (!offOk && state10000(before) === 'funnel') {
    // Funnel was on and turning it off failed: retry once.
    console.error('funnel off failed while funnel was ON; retrying once');
    ts(['funnel', `--https=${PORT}`, 'off']);
    ts(['serve', '--bg', `--https=${PORT}`, TARGET]);
  }
}

const after = serveStatus();
let failed = !commandsOk;

if (!isDeepStrictEqual(others(before), others(after))) {
  failed = true;
  console.error('!!!!!!!! WARNING: serve config on ports other than 10000 CHANGED !!!!!!!!');
  console.error('before:', JSON.stringify(others(before), null, 2));
  console.error('after: ', JSON.stringify(others(after), null, 2));
  console.error('Restore manually: 443 -> http://127.0.0.1:18951 and 8443 -> http://127.0.0.1:8787.');
  console.error('NEVER run `tailscale serve reset`.');
}

const state = state10000(after);
console.log(`port ${PORT}: ${state}`);

const expected = { on: 'funnel', off: 'tailnet' }[mode];
if (expected && state !== expected) {
  failed = true;
  console.error(`!!!!!!!! ERROR: expected port ${PORT} to be '${expected}' but it is '${state}' !!!!!!!!`);
}

// Off: revoke finished vote links. Runs even if the funnel step failed (revoking is always safe).
let revokeFailed = false;
if (mode === 'off') {
  try {
    const n = await createStore(ROOT).revokeDoneTokens();
    console.log(`revoked ${n} finished vote link(s)`);
  } catch (e) {
    console.error(`!!!!!!!! ERROR: revoking finished vote links failed: ${e.message} !!!!!!!!`);
    revokeFailed = true;
  }
}

process.exit(failed || revokeFailed ? 1 : 0);

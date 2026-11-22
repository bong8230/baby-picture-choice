import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const PORT = '10000';
const TARGET = 'http://127.0.0.1:8790';
const mode = process.argv[2];

function ts(args, { allowFail = false } = {}) {
  try {
    return execFileSync('tailscale', args, { encoding: 'utf8', shell: false });
  } catch (e) {
    if (allowFail) return '';
    console.error(`tailscale ${args.join(' ')} failed:\n${e.stderr || e.message}`);
    process.exit(1);
  }
}

function serveStatus() {
  const out = ts(['serve', 'status', '--json']).trim();
  return out ? JSON.parse(out) : {};
}

function funnelStatus() {
  const out = ts(['funnel', 'status', '--json'], { allowFail: true }).trim();
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

if (mode === 'on') {
  ts(['funnel', '--bg', `--https=${PORT}`, TARGET]);
} else if (mode === 'off') {
  ts(['funnel', `--https=${PORT}`, 'off'], { allowFail: true });
  ts(['serve', '--bg', `--https=${PORT}`, TARGET]);
}

const after = serveStatus();

if (!isDeepStrictEqual(others(before), others(after))) {
  console.error('!!!!!!!! WARNING: serve config on ports other than 10000 CHANGED !!!!!!!!');
  console.error('before:', JSON.stringify(others(before), null, 2));
  console.error('after: ', JSON.stringify(others(after), null, 2));
  process.exit(1);
}

console.log(`port ${PORT}: ${state10000(after)}`);

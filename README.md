# baby-picture-choice

Weekly baby-photo candidates are voted on by tournament from phones.
PC Node server (127.0.0.1:8790, zero runtime deps) exposed via Tailscale.

## Setup
Copy `config.example.json` to `config.json` and set `adminLogin`.

## Tailscale port 10000
- `npm run funnel:on` : public (Funnel) while voting
- `npm run funnel:off` : tailnet only
- `npm run funnel:status` : show current state of port 10000

The script never touches other serve ports (443, 8443) and aborts with exit 1 if they change.

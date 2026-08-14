# Security

Codex Deck can execute commands and approve file changes in the workspaces attached to its sessions. Treat every reachable HTTP / WebSocket endpoint as a control plane.

## Supported versions

This project is pre-1.0. Security fixes land on the default branch.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue that includes exploit details, tokens, or session data.

## Deployment notes

- Keep `REMOTE_TOKEN` (or `--token`) enabled whenever the process listens beyond loopback.
- Do not use `--no-token` on untrusted networks.
- The Codex runtime control socket is bound to `127.0.0.1` on purpose. Do not proxy or publish that port.
- API keys and OAuth material must stay on the host. They are not returned to the browser.
- `.env` and `.data/` are local secrets. They are gitignored and must not be committed or shared.
- For a public hostname, put an identity layer in front of Deck (for example Cloudflare Access) in addition to the built-in token.

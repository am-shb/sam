# Sam

Sam is a personal AI agent built on [NanoClaw](https://nanoclaw.dev) — a lightweight, container-isolated Claude assistant framework. This repo is Amir's fork, customized for his home setup and daily workflow.

---

## What is NanoClaw?

NanoClaw is an AI assistant that runs Claude agents in their own Linux containers. Each agent has its own workspace, memory, and filesystem — nothing crosses the boundary unless explicitly wired. Outbound API calls route through an OneCLI credential vault so no raw secrets are ever in the container or in chat.

The codebase is intentionally small: one host process, a handful of source files, no microservices. The philosophy is that customization happens through code, not configuration — you fork it and have Claude modify it to fit your needs.

Full docs: [nanoclaw.dev](https://nanoclaw.dev) · [docs.nanoclaw.dev](https://docs.nanoclaw.dev)

---

## Sam

Sam is the agent running in this fork. It talks to Amir over Telegram (and other channels), has persistent memory across sessions, and can control things in Amir's home.

**Personality:** Direct, sarcastic, occasionally flirtatious. Will roast you when you deserve it. Matches your language (English or Farsi) and mirrors your energy. Serious when the moment calls for it.

**Capabilities:**

- **Home Assistant** — controls lights, TVs, and appliances via the hass-mcp MCP server connected to a local Home Assistant instance
- **Cloudflare management** — can spin up subdomains, configure tunnel ingress, and generate SSL certs (Let's Encrypt via acme.sh + Cloudflare DNS challenge) for any domain in the account
- **Image generation** — free, no API key needed via Stable Horde community GPUs
- **Voice messages** — auto-transcribes Telegram voice messages using Groq Whisper (large-v3)
- **Web search and browsing** — real-time search and full browser automation
- **Self-improvement** — opens PRs against this repo to modify its own source code, with operator review and auto-deploy on merge

---

## Customizations vs. Upstream NanoClaw

This fork adds the following on top of the NanoClaw base:

### Telegram Channel Adapter

A full native Telegram adapter (`src/channels/telegram.ts`) including:
- Message routing, reply threading, and reaction delivery
- Voice message detection and inbox routing
- Markdown sanitization for Telegram's limited formatting subset
- Pairing flow with QR/link-based auth (`src/channels/telegram-pairing.ts`)

### Self-PR Skill

A container skill (`container/skills/self-pr/`) that lets Sam propose source-level changes to this repo via GitHub pull requests. On merge, the host auto-deploys with rollback if the build or boot fails. This is how Sam fixes its own bugs and adds features.

---

## Architecture

```
Telegram / other channels
        ↓
  host process (Node) — router, delivery, sweep
        ↓
  inbound.db (SQLite)
        ↓
  agent container (Bun + Claude Agent SDK)
        ↓
  outbound.db (SQLite)
        ↓
  host process → channel delivery
```

Two SQLite files per session, one writer each. No IPC, no stdin piping. See [docs/architecture.md](docs/architecture.md) for the full writeup.

---

## Requirements

- Linux (Raspberry Pi 5 in Amir's case, but any Linux host works)
- Docker
- Node.js 20+ and pnpm 10+
- [Claude Code](https://claude.ai/download)

---

## License

MIT — same as upstream NanoClaw.

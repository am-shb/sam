# Sam

Sam is a personal AI agent built on [NanoClaw](https://nanoclaw.dev) — a lightweight, container-isolated Claude assistant framework. This repo is Amir's fork.

---

## What is NanoClaw?

NanoClaw runs Claude agents in isolated Linux containers. Each agent has its own workspace, persistent memory, and filesystem. Outbound API calls route through an OneCLI credential vault so no secrets live in the container or in chat.

The codebase is small by design — one host process, no microservices. Customization happens through code, not config: fork it and have Claude modify it to fit your needs.

Full docs: [nanoclaw.dev](https://nanoclaw.dev) · [docs.nanoclaw.dev](https://docs.nanoclaw.dev)

---

## Sam

Sam is the agent running in this fork. It talks to Amir over Telegram, has persistent memory across sessions, and can interact with external services and home infrastructure.

**Personality:** Direct, sarcastic, occasionally flirtatious. Matches your language (English or Farsi) and mirrors your energy.

---

## Customizations vs. Upstream NanoClaw

### Telegram Channel Adapter

Native Telegram integration (`src/channels/telegram.ts`) with message routing, voice message handling, reply threading, and Markdown sanitization.

### Self-PR Skill

A skill that lets Sam propose source-level changes to this repo via GitHub pull requests. On merge, the host auto-deploys with rollback if the build fails.

---

## Requirements

- Linux (Raspberry Pi 5 or any Linux host)
- Docker, Node.js 20+, pnpm 10+
- [Claude Code](https://claude.ai/download)

---

## License

MIT — same as upstream NanoClaw.

# Sam

A customized fork of [NanoClaw](https://nanoclaw.dev) — an AI assistant that runs agents in Docker containers with strong isolation and security.

## What is Sam?

Sam is a Claude-powered assistant deployed on your infrastructure. It can:
- **Respond on Telegram & custom channels** (via Telegram adapter)
- **Access your Home Assistant** for home automation
- **Interact with Cloudflare** for DNS and security
- **Generate images** using Stable Diffusion
- **Transcribe voice** via Deepgram
- **Create pull requests** to update documentation and code

## Key customizations over NanoClaw

- **Telegram adapter** — native Telegram integration for direct messaging
- **Self-PR skill** — Sam can create and manage pull requests autonomously (like the README you're reading now)

## Quick start

```bash
git clone https://github.com/am-shb/sam.git
cd sam
bash nanoclaw.sh
```

The installer walks you through setup: Node, pnpm, Docker, OneCLI credentials, and agent container build.

## Architecture

```
messaging apps → router → inbound.db → agent container → outbound.db → delivery → messaging apps
```

A single host process orchestrates per-session containers. Agents run isolated in Docker with only explicitly mounted directories visible. Credentials never reach the container — requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli).

## Requirements

- macOS or Linux (Windows via WSL2)
- Node.js 20+ and pnpm 10+ (installer provides these)
- [Docker Desktop](https://docker.com/products/docker-desktop) or Docker Engine
- [Claude Code](https://claude.ai/download) for `/customize` and skill installation

## Philosophy

**Small enough to understand.** One process, a few source files, no microservices.

**Secure by isolation.** Agents run in containers and only see explicitly mounted directories.

**Designed for you.** Customize the code directly — the codebase is small enough that changes are safe.

## Learn more

- [NanoClaw docs](https://docs.nanoclaw.dev) — full documentation
- [NanoClaw GitHub](https://github.com/nanocoai/nanoclaw) — upstream project
- [Architecture details](docs/architecture.md)

## License

MIT

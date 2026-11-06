<p align="center">
    <img src='/public/logo.png' />
</p>

[简体中文](README_zh.md) | English

# PPTist — Agent-oriented multi-user fork

**This repository is a fork of [pipipi-pikachu/PPTist](https://github.com/pipipi-pikachu/PPTist).** It keeps the upstream Vue 3 + TypeScript web editor and adds a self-hosted backend (`server/`) built for AI-agent workflows: multi-user API keys, server-side document storage, a remote MCP endpoint, server-side export, and an admin console. This fork is not affiliated with or endorsed by upstream, and its changes have not been merged upstream.

## What this fork adds

Implemented under `server/` (Fastify + better-sqlite3) unless noted:

- **Multi-user isolation**: each user owns their documents; access is authenticated per request.
- **Credentials**: user API keys (`pk_…`) for agents and the REST API, plus per-document edit / read-only tokens (`X-Doc-Token` header, `#t=` URL hash) for the web client. Keys are shown only once at creation; admin surfaces only ever display key prefixes.
- **Quotas and storage**: per-user quotas (document count, document size, exports per day). Documents, revisions, uploaded assets and export files live under `DATA_DIR` — SQLite `app.db` (WAL), `assets/`, `exports/`.
- **Collaboration**: versioned documents with three-way merge on `baseVersion` (conflicts return 409), SSE push (`GET /api/docs/:id/events`), comments/notes.
- **Remote MCP**: `POST /mcp` (Streamable HTTP, stateless) exposes tools for creating, editing and exporting presentations — `create_presentation`, `add_slides`, `update_elements`, `batch_edit`, `get_changes`, `export_presentation`, and more; `get_authoring_guide` serves the authoring schema (`doc/AI_PPT_SCHEMA.md`) in sections.
- **Server-side export**: headless Chromium (Playwright) renders PPTX / PDF / PNG via the app's own export runtime; JSON export does not use a browser.
- **Admin**: standalone `/admin` console (separate Vite entry `admin.html`, Vue 3 + Naive UI) plus the `pptist-admin` CLI for users, keys, quotas and online SQLite backups.
- **Agent landing page**: visiting `/` without a `doc` parameter shows an MCP integration guide for agents instead of the editor (`src/views/McpHome`).

## Upstream editor (unchanged core)

- Vue 3 + TypeScript, no UI component library dependency
- Common Office PPT elements: text, image, shape, line, chart, table, video, audio, formula
- Slide/page editing, transitions and element animations, slideshow tools, basic mobile editing and preview
- Browser-side PPTX / JSON / image / PDF import & export
- Upstream's own online demo (hosted by upstream, not this fork): <https://pipipi-pikachu.github.io/PPTist/>

## Document links

- Edit link: `https://<your-host>/?doc=<docId>#t=<edit-token>`
- Read-only link: `https://<your-host>/?doc=<docId>&mode=view#t=<view-token>`
- `/` without `doc` → MCP guide page; `?mode=export` is the headless export runtime used internally by the server.

## Quick start

### Local development (Node.js >= 20)

```bash
# frontend — Vite dev server at http://127.0.0.1:5173, proxies /api /assets /exports /mcp to :3100
npm install
npm run dev

# backend — http://0.0.0.0:3100
npm --prefix server install
npm --prefix server run dev
```

### Self-host with Docker Compose (image includes Chromium)

```bash
mkdir -p data            # create it yourself so the non-root container user can write
docker compose up -d     # app only, http://127.0.0.1:3100
curl http://127.0.0.1:3100/api/health

docker compose exec app pptist-admin user create <name>   # prints the pk_ key once — save it
```

`docker compose --profile https up -d` additionally starts Caddy for automatic HTTPS — first set your real domain in `Caddyfile` and `PUBLIC_BASE_URL` in `docker-compose.yml`. The `https` profile is off by default; a plain `docker compose up -d` only starts the app. Full deployment notes: [server/README.md](server/README.md).

### Connect an agent (remote MCP)

```yaml
mcp_servers:
  pptist:
    url: https://pptist.example.com/mcp   # replace with your deployment's public URL
    headers:
      Authorization: Bearer pk_...        # a real key is issued by pptist-admin, shown once
```

### Admin console

- Set the first admin password via the `ADMIN_INITIAL_PASSWORD` environment variable (≥10 chars, only seeds when the database has none) or with `pptist-admin passwd`.
- Entry: `GET /admin` in production; `http://localhost:5173/admin.html` under Vite dev.

## Operations notes

- Serve over HTTPS in production; `ADMIN_SECURE_COOKIES` is derived from `PUBLIC_BASE_URL`. Set `TRUST_PROXY=1` only behind a trusted reverse proxy.
- Keep secrets, user keys and the `data/` directory out of git — `.env*` files are git-ignored; `server/.env.example` lists the supported variables with placeholders only.
- `pptist-admin backup <file>` performs an online SQLite backup. Backup scheduling and off-site copies are left to the deployer; nothing is scheduled automatically.

## Documentation

- Server: environment variables, `pptist-admin` CLI, REST/MCP API reference, deployment — [server/README.md](server/README.md)
- Upstream development docs — [doc/](doc/) (project structure & data schema, canvas, custom elements, AIPPT)

## Issues

- Bugs or feature requests about this fork (server, MCP, admin, deployment) → [Issues in this repository](https://github.com/CI2VO5IXZ7/PPTist/issues)
- Bugs in the upstream editor → [pipipi-pikachu/PPTist Issues](https://github.com/pipipi-pikachu/PPTist/issues)

## License

[AGPL-3.0](LICENSE) | Copyright © 2020-PRESENT [pipipi-pikachu](https://github.com/pipipi-pikachu)

AGPL-3.0 covers the whole repository including this fork's additions: if you modify the code and let others interact with it over a network, you must publish the complete corresponding source under AGPL-3.0, keep copyright notices intact, and may not add further restrictions. The upstream author separately offers independent commercial licenses — see the upstream README for terms and contact details. This fork is not an official upstream product.

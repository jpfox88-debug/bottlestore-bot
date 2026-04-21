# Jeffrey — The Bottle Store AI Sommelier

AI sommelier chatbot for The Bottle Store UAE. Two-step (classify + search) recommendation over a live CMS inventory, with an admin-managed promotions layer.

## Components

| File | Purpose |
| --- | --- |
| `bot-api.js` | Express server: `/api/bot/message`, `/api/inventory`, `/api/promotions` |
| `inventory-connector.js` | CMS fetch, 5-min cache, smart scored search |
| `bottlestore-bot.html` | Customer-facing chat widget (GitHub Pages) |
| `promotions-admin.html` | Password-gated admin page for featured products |
| `promotions.json` | Fallback store (local dev); production uses `/data/promotions.json` |

## Deployment (Render)

### Environment variables

Set these in the Render dashboard under **Environment → Environment Variables**:

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Claude API — powers Haiku classifier + Sonnet recommender |
| `CMS_API_TOKEN` | yes | Bearer token for the CMS product feed |
| `ADMIN_PASSWORD` | yes | Shared secret for `/api/promotions` POST/DELETE. If unset, all admin writes return 401 (fail-closed) |
| `ELEVENLABS_KEY` | optional | ElevenLabs API key for avatar-mode TTS |
| `ELEVENLABS_VOICE_ID` | optional | Voice to use (e.g. `FX7Ed0mBTbZ495AXR8ky`) |
| `SIMLI_API_KEY` | optional | Simli avatar API key |
| `SIMLI_AGENT_ID` | optional | Simli agent (e.g. `d2a5c7c6-fed9-4f55-bcb3-062f7cd20103`) |
| `PORT` | auto | Set by Render automatically |

### Persistent disk

Promotions are stored on a Render persistent disk so they survive redeploys. Configure under **Disks**:

- **Name:** `jeffrey-data` (or any name)
- **Mount path:** `/data`
- **Size:** 1 GB is plenty

The server detects `/data` at startup and uses `/data/promotions.json`. If the disk isn't attached, it falls back to the repo-local `promotions.json` — convenient for local dev but **not safe for production**, because Render's container filesystem is ephemeral and any promotions added via the admin UI will be wiped on the next redeploy.

Check the server logs on boot for `[Promotions] Storage: /data/promotions.json` to confirm the disk is being used.

## Admin panel

`promotions-admin.html` is a standalone page — host it anywhere (GitHub Pages alongside `bottlestore-bot.html` works). On load it prompts for the admin password, stores it in `sessionStorage`, and calls the Render API directly.

Promotions with a matching trigger word are injected into Jeffrey's system prompt so they get recommended first.

## Local development

```
npm install
ANTHROPIC_API_KEY=... CMS_API_TOKEN=... ADMIN_PASSWORD=... node bot-api.js
```

Server listens on `PORT` (default 3000). Health check at `/health`.

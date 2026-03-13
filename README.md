# Swamp Toad

An audience with an ancient being.

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

```bash
cp .env.example .env
```

Edit `.env` and add your Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at [console.anthropic.com](https://console.anthropic.com/).

**3. Run**

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

For development with auto-reload (Node 18+):

```bash
npm run dev
```

---

## Rate Limits

| Limit | Value |
|---|---|
| Per IP, per day | 10 requests |
| All users, per day | 500 requests |
| Max tokens per response | 150 |
| Max question length | 500 characters |

Both counters reset at midnight server time. No database needed — limits are in-memory and reset on server restart.

---

## Project Structure

```
swamp-toad/
├── server.js      # Express backend, rate limiting, Claude API
├── index.html     # Complete frontend (single file)
├── package.json
├── .env           # Your secrets (never commit this)
├── .env.example   # Template
└── README.md
```

---

## Deployment

Works on any Node.js host. Set `ANTHROPIC_API_KEY` and optionally `PORT` as environment variables.

For production, consider adding `helmet` for HTTP security headers and running behind a reverse proxy (nginx, Caddy).

---

## Model

Uses `claude-sonnet-4-20250514`. To swap models, edit the `model` field in `server.js`.

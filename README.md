# Shopping Assistant

AI-powered shopping assistant on Cloudflare Workers. Uses OpenAI agents with tool calling to provide conversational product discovery, real-time inventory checking, and order status lookup against a Commerce Layer catalog.

## Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **AI:** OpenAI Agents SDK (`gpt-5-nano`, direct OpenAI API)
- **Search:** Vectorize + LangChain (`bge-small-en-v1.5` embeddings)
- **E-commerce:** Commerce Layer API
- **Language:** TypeScript

## API

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/chat?q=` | Conversational shopping assistant (SSE stream) |
| `GET` | `/search?q=` | Direct semantic product search |
| `POST` | `/mcp` | MCP server (Streamable HTTP) — exposes tools for MCP clients |
| `GET` | `/reindex` | Re-index Commerce Layer SKUs into Vectorize |
| `DELETE` | `/clear-index` | Wipe the vector index |

## Setup

### Prerequisites

- Node.js, Yarn
- Cloudflare account with Workers, Vectorize, and AI enabled
- Commerce Layer account
- OpenAI API key

### Environment Variables

Set these as Cloudflare Worker secrets:

- `OPENAI_API_KEY` — OpenAI API key
- `CL_CLIENT_ID` / `CL_CLIENT_SECRET` — Commerce Layer OAuth credentials
- `CL_DOMAIN` — Commerce Layer domain (e.g. `yourstore.commercelayer.io`)

### Development

```bash
yarn install
yarn dev          # Start local dev server at http://localhost:8787
```

### Deploy

```bash
yarn deploy
```

### Re-generate Types

Run after changing bindings in `wrangler.jsonc`:

```bash
yarn cf-typegen
```

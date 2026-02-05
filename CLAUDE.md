# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Workers shopping assistant that integrates OpenAI agents with Commerce Layer e-commerce APIs. Uses semantic vector search for product discovery and multi-layer caching for inventory checks.

## Commands

```bash
yarn dev             # Local dev server (wrangler dev) at http://localhost:8787
yarn deploy          # Deploy to Cloudflare Workers
yarn cf-typegen      # Regenerate TypeScript types from wrangler.jsonc (run after changing bindings)
```

No test runner or linter is configured.

## Business Features

- **Conversational product discovery** — Customers describe what they're looking for in natural language and the AI agent finds matching products via semantic search against the Commerce Layer catalog
- **Real-time inventory checking** — The agent automatically checks stock levels across all warehouse locations for matched products and reports availability and quantity
- **Product catalog indexing** — Admin endpoint (`/reindex`) syncs SKUs from Commerce Layer into a vector index, embedding product names, descriptions, and attributes for semantic matching
- **Multi-location stock aggregation** — Stock quantities are summed across all Commerce Layer stock locations for a given SKU, giving a unified availability view

## Architecture

### Source Files (`src/`)

- **`index.ts`** — Entrypoint. Fetch handler with HTTP route dispatch, re-exports `MyDurableObject` and `Env` for Cloudflare
- **`types.ts`** — Shared types: `Env`, `StockResult`, `CommerceLayerSKU`
- **`durable-object.ts`** — `MyDurableObject` class and `getDurableObject` factory
- **`commerce-layer.ts`** — Commerce Layer API helpers: `getCommerceLayer` (authenticated fetch), `skuToText` (SKU→embeddable text)
- **`vector-store.ts`** — Vectorize operations: `getVectorStore`, `similaritySearch`, `clearIndex`, `reindexProducts`
- **`agent.ts`** — OpenAI agent setup, tool definitions (`search_products`, `check_stock`), and `handleResponse`

### HTTP Routes (fetch handler)

- `GET /chat?q={input}` — AI shopping assistant via OpenAI agent with tool calling
- `GET /search?q={query}` — Direct semantic product search
- `GET /reindex` — Re-index all Commerce Layer SKUs into Vectorize
- `DELETE /clear-index` — Wipe the vector index

### Durable Object (`MyDurableObject`)

Manages stateful operations with a 4-tier caching strategy for Commerce Layer API calls:

1. Inflight request deduplication (prevents thundering herd)
2. In-memory cache
3. Durable Object persistent storage (60s TTL)
4. Commerce Layer API fallback

Also handles OAuth token lifecycle (client credentials flow) with in-memory + storage caching.

### OpenAI Agent

- Model: `gpt-5-nano` via Cloudflare AI Gateway proxy
- Framework: `@openai/agents` with tool calling
- Tools: `search_products` (vector similarity search) and `check_stock` (inventory via Durable Object)
- Tool parameters validated with Zod schemas

### Vector Search

- LangChain's `CloudflareVectorizeStore` with `@cf/baai/bge-small-en-v1.5` embeddings
- SKU data (name, description, weight, image URL) converted to text and embedded
- Similarity search returns top 2 results

## Infrastructure Bindings (wrangler.jsonc)

- `AI` — Cloudflare Workers AI (embeddings)
- `VECTORIZE_INDEX` — Vectorize database (product vectors)
- `MY_DURABLE_OBJECT` — Durable Object (caching, token management)

## Environment Variables

- `CLOUDFLARE_API_KEY` — Cloudflare API key for AI Gateway
- `CL_CLIENT_ID` / `CL_CLIENT_SECRET` — Commerce Layer OAuth credentials
- `CL_DOMAIN` — Commerce Layer domain (e.g., `madras.commercelayer.io`)

## Code Style

- TypeScript strict mode, tabs, single quotes, semicolons, 140 char print width (Prettier)
- Package manager: Yarn

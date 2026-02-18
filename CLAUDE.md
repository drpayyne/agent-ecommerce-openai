# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cloudflare Workers shopping assistant that integrates OpenAI agents with Commerce Layer e-commerce APIs. Uses semantic vector search for product discovery, multi-layer caching for inventory checks, and SSE streaming for real-time chat responses.

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
- **Order status lookup** — Customers can ask about their order status; the agent fetches the most recent order (or a specific order by number) from Commerce Layer and reports status, payment, and fulfillment details conversationally
- **SSE streaming chat UI** — `shopper.html` provides a browser-based chat interface that streams agent responses in real-time via Server-Sent Events, with both `fetch` and `EventSource` implementations (currently using EventSource)
- **Voice input transcription (realtime STT)** — `shopper.html` can capture microphone audio, stream raw PCM to Speechmatics Realtime WebSocket API, receive finalized transcripts, and submit transcript text as chat queries

## Architecture

### Source Files (`src/`)

- **`index.ts`** — Entrypoint. Fetch handler with HTTP route dispatch, CORS handling, re-exports `MyDurableObject` for Cloudflare
- **`types.ts`** — Shared types: `Env`, `StockResult`, `CommerceLayerSKU`, `OrderStatusResult`
- **`instructions.ts`** — System prompt / agent instructions for the shopping assistant
- **`durable-object.ts`** — `MyDurableObject` class (token management, 4-tier stock caching, session storage) and `getDurableObject` factory
- **`session.ts`** — Replay-safe session layer: `ChatMessage` schema, `SessionStore` interface, `DurableObjectSessionStore` (DO-backed impl), `buildRunInput` (history → id-free `AgentInputItem[]`), `extractAssistantText` (stream event → text)
- **`commerce-layer.ts`** — Commerce Layer API helpers: `getCommerceLayer` (authenticated fetch), `skuToText` (SKU to embeddable text), `getOrderStatus` (order lookup by number or email)
- **`vector-store.ts`** — Vectorize operations: `getVectorStore`, `similaritySearch`, `clearIndex`, `reindexProducts`
- **`agent.ts`** — OpenAI agent setup, tool definitions (`search_products`, `check_stock`, `check_order_status`), SSE streaming via `handleResponse`
- **`mcp.ts`** — MCP server factory: `createMcpServer` exposes the same three tools (`search_products`, `check_stock`, `check_order_status`) over Streamable HTTP via `@modelcontextprotocol/sdk`

### Frontend

- **`shopper.html`** — Standalone chat UI served separately (not by the Worker). Connects to `http://localhost:8787` by default. Two SSE streaming implementations: `streamWithFetch` (manual SSE parsing over ReadableStream) and `streamWithEventSource` (browser EventSource API). Includes a mic button that captures browser audio, transcribes through Speechmatics Realtime WebSocket STT, and sends the transcript to `/chat`.

### HTTP Routes (fetch handler)

- `GET /chat?q={input}` — AI shopping assistant via OpenAI agent with SSE streaming response
- `GET /search?q={query}` — Direct semantic product search (returns JSON)
- `POST /mcp` — MCP server endpoint (Streamable HTTP transport) exposing `search_products`, `check_stock`, `check_order_status` tools
- `GET /reindex` — Re-index all Commerce Layer SKUs into Vectorize
- `DELETE /clear-index` — Wipe the vector index

### Durable Object (`MyDurableObject`)

Manages stateful operations with a 4-tier caching strategy for Commerce Layer stock API calls:

1. Inflight request deduplication (prevents thundering herd)
2. In-memory cache (60s TTL)
3. Durable Object persistent storage (60s TTL)
4. Commerce Layer API fallback

Also handles OAuth token lifecycle (client credentials flow) with in-memory + storage caching and a 5-minute expiry buffer.

Additionally stores replay-safe conversation history as `ChatMessage[]` keyed by `session:{conversationId}`, used by `DurableObjectSessionStore` to persist chat context across turns. Only semantic content (user/assistant text + timestamps) is stored — no provider IDs, reasoning items, or status fields.

### OpenAI Agent

- Model: `gpt-5-nano` (direct OpenAI API; AI Gateway proxy code exists but is commented out)
- Framework: `@openai/agents` with tool calling
- Tools: `search_products` (vector similarity search), `check_stock` (inventory via Durable Object), `check_order_status` (order lookup from Commerce Layer)
- Tool parameters validated with Zod schemas
- Replay-safe session: history stored as clean `ChatMessage[]` in DO (no provider IDs/reasoning); rebuilt as id-free `AgentInputItem[]` via `buildRunInput()` each turn; SDK `Session` interface bypassed entirely
- Streaming: events buffered in memory per turn; user+assistant messages committed atomically only after successful run completion; client disconnect is handled gracefully (stream drains to completion before commit)
- Responses streamed as SSE (`text/event-stream`) with `data: [DONE]` terminator

### Vector Search

- LangChain's `CloudflareVectorizeStore` with `@cf/baai/bge-small-en-v1.5` embeddings
- SKU data (name, description, weight, image URL) converted to text and embedded
- Similarity search returns top 10 results with scores

## Infrastructure Bindings (wrangler.jsonc)

- `AI` — Cloudflare Workers AI (embeddings, remote mode)
- `VECTORIZE` — Vectorize database named `madras-company-products` (product vectors, remote mode)
- `MY_DURABLE_OBJECT` — Durable Object with SQLite storage (caching, token management, session storage)
- Observability is enabled

## Environment Variables

- `OPENAI_API_KEY` — OpenAI API key (used directly; AI Gateway path is commented out)
- `CLOUDFLARE_API_KEY` — Cloudflare API key (unused in active code; retained for AI Gateway reactivation)
- `CL_CLIENT_ID` / `CL_CLIENT_SECRET` — Commerce Layer OAuth client credentials
- `CL_DOMAIN` — Commerce Layer domain (e.g., `madras.commercelayer.io`)

## Dependencies

- `@openai/agents` — OpenAI agent framework with tool calling
- `openai` — OpenAI client SDK
- `@langchain/cloudflare` — LangChain bindings for Vectorize and Workers AI embeddings
- `@langchain/core` — LangChain core abstractions
- `zod` — Schema validation for agent tool parameters
- `@modelcontextprotocol/sdk` — MCP server SDK for Streamable HTTP transport
- `agents` — Cloudflare Agents SDK (`createMcpHandler` for Workers-compatible MCP serving)

## Code Style

- TypeScript strict mode, 2-space indent, single quotes, semicolons, 120 char print width, trailing commas in ES5 contexts (Prettier + EditorConfig)
- Package manager: Yarn

## Known Issues

See `docs/security-review.md` and `docs/performance-review.md` for detailed findings. Key items:

- No authentication on any endpoint (including destructive admin routes and `/mcp`)
- Hardcoded email in order status lookups (in both `agent.ts` and `mcp.ts`)
- Wildcard CORS (`*`)
- No rate limiting
- ~~No pagination on SKU fetch during reindex~~ (fixed: `fetchAll` follows `links.next` for full pagination)
- ~~Unhandled errors in SSE streaming IIFE~~ (fixed: errors caught, buffer discarded on failure)

## Development

After tasks, ensure CLAUDE.md is up to date and accurate. Run `yarn cf-typegen` to update types.

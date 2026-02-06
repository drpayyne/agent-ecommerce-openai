# Security & PII Review

Last reviewed: 2026-02-06

## Critical

### SEC-1: No authentication on any endpoint

**File:** `src/index.ts:19-63`

Every endpoint is publicly accessible with no authentication:

- `GET /reindex` — triggers a full re-index of all Commerce Layer SKUs (admin operation)
- `DELETE /clear-index` — wipes the entire vector index (destructive admin operation)
- `GET /search` — queries the product catalog
- `GET /chat` — invokes the OpenAI agent, consuming API credits

Anyone on the internet can call `/clear-index` to destroy search functionality or spam `/chat` to burn through OpenAI credits.

**Recommendation:** Protect `/reindex` and `/clear-index` with an API key or admin token at minimum. Add user authentication for `/chat` to scope order lookups and enable rate limiting per user.

---

### SEC-2: Hardcoded email exposes order data to all visitors

**File:** `src/agent.ts:62`

```typescript
const result = await getOrderStatus(env, token, 'agent@madras.co', order_number || undefined);
```

The email `agent@madras.co` is hardcoded in the `check_order_status` tool. Every anonymous visitor who asks about order status receives real order data belonging to this account. There is no user identity verification — the system cannot distinguish between users.

This is both a **security** and **PII** issue: real customer order numbers, statuses, payment details, and fulfillment details are exposed to unauthenticated users and forwarded to OpenAI's API.

**Recommendation:** Remove the hardcoded email. Require user authentication and use the authenticated user's email for order lookups.

---

### SEC-3: Wildcard CORS allows all origins

**File:** `src/index.ts:6-9`

```typescript
const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
};
```

Any website can make cross-origin requests to all endpoints, including the destructive `/clear-index`. Combined with the lack of authentication (SEC-1), a malicious page could silently call admin endpoints on behalf of any visitor.

**Recommendation:** Restrict `Access-Control-Allow-Origin` to the specific origin(s) where the frontend is served. For local development, allow `http://localhost:*`.

---

## High

### SEC-4: Cloudflare account ID hardcoded in source

**File:** `src/agent.ts:78`

```typescript
baseURL: 'https://gateway.ai.cloudflare.com/v1/c1a07233ad604ce4871cb64a332c8408/openai/openai',
```

The Cloudflare AI Gateway URL containing the account ID is committed to version control. While account IDs are not secrets, exposing them reveals infrastructure details and makes it harder to rotate configurations.

**Recommendation:** Move the AI Gateway base URL to an environment variable (e.g., `AI_GATEWAY_URL`).

---

### SEC-5: No prompt injection protection

**Files:** `src/index.ts:57-59`, `src/agent.ts:108`

User input from the `q` query parameter is passed directly to the OpenAI agent with no sanitization, length validation, or guardrails. An attacker could craft prompts to override system instructions, extract the system prompt, or manipulate tool calls.

**Recommendation:** Add input length limits (e.g., 1000 characters). Add guardrails to agent instructions warning against instruction override attempts. Consider a prompt injection detection layer.

---

### SEC-6: No rate limiting

**File:** `src/index.ts` (all endpoints)

No rate limiting exists on any endpoint. An attacker can:

- Spam `/chat` to burn OpenAI API credits (cost attack)
- Repeatedly call `/reindex` to exhaust Commerce Layer API quota
- Loop `/clear-index` to keep search permanently broken (DoS)
- Flood `/search` to consume Workers AI embedding compute

**Recommendation:** Add rate limiting via Cloudflare's Rate Limiting Rules or the `RateLimit` binding available to Workers.

---

### SEC-7: Unhandled SSE stream errors leave connections open

**File:** `src/agent.ts:122-130`

```typescript
(async () => {
	for await (const event of result) {
		if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
			await writer.write(encoder.encode(`data: ${JSON.stringify(event.data.delta)}\n\n`));
		}
	}
	await writer.write(encoder.encode('data: [DONE]\n\n'));
	await writer.close();
})();
```

The streaming IIFE has no error handling. If the OpenAI stream throws (network failure, token limit, etc.), the `writer` is never closed, the client hangs indefinitely, and no error is communicated. This is also a resource leak.

**Recommendation:** Wrap in try/catch/finally. Send an error SSE event on failure and always close the writer in the `finally` block.

---

## Medium

### SEC-8: User queries logged in URL parameters

**Files:** `src/index.ts:39,57`, `shopper.html:258`

User queries are sent as GET `q` parameters. With Cloudflare observability enabled (`wrangler.jsonc:41`), full request URLs — including queries — are captured in logs. Users may type PII (names, order numbers, addresses) into the chat.

**Recommendation:** Switch `/chat` to accept POST requests with the query in the body. Use the `streamWithFetch` implementation (already written) instead of EventSource, which is limited to GET.

---

### SEC-9: Error messages may leak internal API details

**Files:** `src/commerce-layer.ts:11`, `src/durable-object.ts:47,107`

```typescript
if (!res.ok) throw new Error(`CL API error: ${res.status} ${await res.text()}`);
```

Commerce Layer API error responses are included verbatim in thrown errors. These can propagate to clients (there is no global error handler in `index.ts`), potentially exposing internal API details, token errors, or rate limit information.

**Recommendation:** Catch errors at the HTTP handler level and return generic messages to clients. Log detailed errors server-side only.

---

### SEC-10: No input length validation

**File:** `src/index.ts:57-59`

The `q` query parameter has no length limit. Extremely long inputs can consume excessive OpenAI tokens (cost attack) or cause memory pressure on the Worker. The same applies to `/search` on line 39.

**Recommendation:** Validate maximum query length (e.g., 1000 characters) before processing.

---

### SEC-11: EventSource prevents authentication headers

**File:** `shopper.html:201-225`

The default streaming implementation uses `EventSource`, which does not support custom headers. This makes it impossible to send authentication tokens or CSRF tokens, locking the frontend into unauthenticated GET requests.

**Recommendation:** Switch to the `streamWithFetch` approach (already implemented) and use POST requests with proper auth headers when authentication is added.

---

## Low

### SEC-12: Order data sent to third-party LLM without consent

**File:** `src/agent.ts:59-69`

Order status data (order number, status, payment status, fulfillment status) is returned as a tool result and forwarded to OpenAI's API via the Cloudflare AI Gateway. This constitutes sharing customer data with a third-party provider.

**Recommendation:** Add a privacy notice/consent mechanism. Consider summarizing order data server-side before sending to the LLM, or handle order lookups without LLM involvement.

---

### SEC-13: innerHTML usage in frontend

**File:** `shopper.html:244`

```javascript
bubble.innerHTML = '<em>thinking</em>';
```

Currently safe (static string), but establishes a pattern that could lead to XSS if extended to dynamic content. All other dynamic content correctly uses `textContent`.

**Recommendation:** Replace with `createElement('em')` + `createTextNode('thinking')` to eliminate all `innerHTML` usage.

---

### SEC-14: SKU data logged during reindex

**File:** `src/vector-store.ts:89`

```typescript
console.log(`Indexed SKU: ${sku.id} - ${sku.attributes.code}`);
```

SKU IDs and codes are logged to console. With observability enabled, this appears in Cloudflare's log stream. Low risk since it's product data, not customer data, but establishes verbose logging patterns.

**Recommendation:** Remove or gate behind a debug flag for production.

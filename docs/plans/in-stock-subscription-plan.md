# In-Stock Subscription with Human-in-the-Loop Approval

## Context

When a product is out of stock, the AI agent should offer back-in-stock notifications. The `subscribe_in_stock` tool uses the OpenAI Agents SDK's `needsApproval: true` to trigger a human-in-the-loop approval flow. The agent run is interrupted, the approval request is sent to the client via a custom SSE event, and the user confirms/declines via a new `/approve` endpoint. Market and customer IDs are placeholders for now.

**Key constraint:** Cloudflare Workers are stateless between requests, so `RunState` from the SDK cannot be persisted across the two requests. Instead, we store pending approval details in the Durable Object and execute the subscription directly on approval (bypassing a second agent run).

## Files to Modify (in order)

### 1. `src/types.ts` — Add new types

```typescript
export type InStockSubscriptionResult = {
  id: string;
  skuCode: string;
  status: string;
};

export type PendingApproval = {
  toolName: string;
  skuCode: string;
  skuId: string;
  customerEmail?: string;
  createdAt: number;
};
```

### 2. `src/commerce-layer.ts` — Extend for POST + add subscription helper

**2a.** Add optional `options` param to `getCommerceLayer()` for method/body support:
```typescript
export async function getCommerceLayer(
  env: Env, token: string, path: string,
  options?: { method?: string; body?: unknown }
)
```
- Add `Content-Type: application/vnd.api+json` header (harmless for GET, required for POST)
- Add `method: options?.method ?? 'GET'`
- Conditionally include `body: JSON.stringify(options.body)`
- Backward-compatible: existing callers unchanged

**2b.** Add `createInStockSubscription(env, token, skuId, skuCode, customerEmail?)`:
- `POST /api/in_stock_subscriptions` with JSON:API body
- Relationships: `market` (placeholder ID), `customer` (placeholder ID), `sku` (real ID from `skuId` param)
- Attributes: `sku_code`, `stock_threshold: 1`, optional `customer_email`
- Returns `InStockSubscriptionResult`

> **Note:** No `getSkuIdByCode()` helper needed — the vector store already stores the Commerce Layer SKU entity ID in metadata (`doc.metadata.id`). The `search_products` tool will be updated to include `sku_id` in its output, and the agent will pass it to `subscribe_in_stock`.

### 3. `src/durable-object.ts` — Add pending approval storage

Add three methods to `MyDurableObject`:
- `storePendingApproval(conversationId: string, approval: PendingApproval): Promise<void>` — stores at key `approval:{conversationId}`
- `loadPendingApproval(conversationId: string): Promise<PendingApproval | null>` — loads and returns
- `clearPendingApproval(conversationId: string): Promise<void>` — deletes

These use `this.ctx.storage.put/get/delete` directly (no caching needed — approvals are one-shot).

### 4. `src/instructions.ts` — Update agent behavior

- Change "three things" → "four things", add "Signing up for back-in-stock notifications"
- Add tool guidance: "When a product is out of stock, offer the customer a back-in-stock notification. If they want it, call `subscribe_in_stock`. The system will handle confirmation with the customer automatically — just call the tool when the customer expresses interest."
- Update out-of-stock edge case: offer two options (notification signup OR search alternatives)
- Add response examples for the notification offer

### 5. `src/agent-openai.ts` — Add `subscribe_in_stock` tool + handle interruptions

**5a.** Update `search_products` tool output to include SKU entity ID:
```typescript
// In the search_products execute function, add sku_id to the returned objects:
const products = results.map(([doc, score]) => ({
  name: doc.metadata.name,
  description: doc.metadata.description,
  sku_code: doc.metadata.code,
  sku_id: doc.metadata.id,   // Commerce Layer SKU entity ID from vector store
  score: score,
}));
```

**5b.** New tool with `needsApproval: true` — accepts `sku_id` directly (no API lookup needed):
```typescript
const subscribeInStockTool = tool({
  name: 'subscribe_in_stock',
  description: 'Subscribe a customer to be notified when an out-of-stock product is back. Call when the customer wants a back-in-stock notification.',
  parameters: z.object({
    sku_code: z.string().describe('The SKU code of the out-of-stock product'),
    sku_id: z.string().describe('The Commerce Layer SKU entity ID (from search_products results)'),
    customer_email: z.string().optional().describe('Customer email for notification'),
  }),
  needsApproval: true,
  async execute({ sku_code, sku_id, customer_email }) {
    const stub = getDurableObject(env);
    const token = await stub.getCommerceLayerToken();
    try {
      const result = await createInStockSubscription(env, token, sku_id, sku_code, customer_email);
      return { success: true, subscriptionId: result.id, skuCode: result.skuCode, status: result.status };
    } catch (err) {
      return { success: false, message: 'Failed to create subscription.' };
    }
  },
});
```

**5c.** Modify the streaming loop in `handleResponse()` to detect `tool_approval_requested` events and check `result.interruptions` after stream:

```
Stream iteration:
  - Existing: stream output_text_delta as SSE data
  - New: detect run_item_stream_event with name 'tool_approval_requested'
    → capture the approval item (tool name + arguments)

After stream:
  - If result.interruptions is non-empty:
    1. Parse each interruption's name and arguments
    2. Store pending approval in DO via stub.storePendingApproval()
    3. Send SSE: event: tool_approval\ndata: {toolName, skuCode, ...}\n\n
    4. Save partial conversation (user message + any assistant text before the tool call)
    5. End with data: [DONE]\n\n
  - If no interruptions:
    → existing flow (extract assistant text, commit to session)
```

### 6. `src/index.ts` — Add `/approve` endpoint

New route: `GET /approve?conversation_id=...&approved=true|false`

Flow:
1. Parse `conversation_id` and `approved` from query params
2. Load pending approval from DO via `stub.loadPendingApproval(conversationId)`
3. If not found → return 404 error
4. If `approved === 'true'`:
   - Get CL token from DO
   - Call `createInStockSubscription()` using `skuId` from the stored `PendingApproval`
   - Append to session: user "yes" + assistant confirmation message
   - Clear pending approval from DO
   - Return SSE stream with confirmation text
5. If `approved === 'false'`:
   - Append to session: user "no" + assistant acknowledgment
   - Clear pending approval from DO
   - Return SSE stream with acknowledgment text
6. Both paths return `text/event-stream` with the same SSE format as `/chat` for frontend consistency

### 7. `shopper.html` — Handle approval UI

**7a.** Add CSS for approval buttons (inline in chat, styled as action buttons)

**7b.** In both `streamWithFetch` and `streamWithEventSource`:
- Handle the `tool_approval` named event
- Parse the event data to get `toolName` and `skuCode`
- Create an inline approval UI in the chat:
  ```
  "Would you like to be notified when [SKU] is back in stock?"
  [Yes, notify me]  [No thanks]
  ```

**7c.** Button click handlers:
- Send `GET /approve?conversation_id=...&approved=true|false`
- Stream the response into a new assistant bubble (reusing the existing streaming logic)
- Disable buttons after click to prevent double-submission

### 8. `CLAUDE.md` — Update documentation

- Add "Back-in-stock notification subscription" to Business Features
- Add `subscribe_in_stock` to the Tools list under OpenAI Agent
- Add `/approve` to HTTP Routes
- Add `storePendingApproval`, `loadPendingApproval`, `clearPendingApproval` to DO description
- Add note under Known Issues: "Market and customer IDs are hardcoded placeholders in `createInStockSubscription`"

## Tool Call Trigger Logic

The `subscribe_in_stock` call is **LLM-driven**, not hardcoded. The agent decides based on conversation context and its instructions:

1. Agent calls `check_stock` on a SKU the customer asked about → returns `available: false` (quantity 0)
2. Agent's instructions tell it to offer two options: back-in-stock notification OR search for alternatives
3. Customer expresses interest in being notified (e.g., "yes, sign me up")
4. Agent calls `subscribe_in_stock` with the `sku_code` and `sku_id` from the earlier `search_products` result

It is not limited to the "top" search result — it applies to any SKU the agent checked stock on that came back unavailable. The agent uses conversation context to determine which SKU the customer is referring to.

## Future Enhancements

- **LLM-based approval interpretation:** Currently, approval is a binary button click (string check of `approved=true|false`). A future iteration could allow the user to respond in natural language (e.g., "yeah go ahead", "nah I'm good") and have the LLM interpret the intent as approval or rejection, removing the need for explicit buttons.

## Verification

1. `yarn dev` — start local dev server
2. Open `shopper.html` in browser
3. Ask: "Do you have the Cotton Poplin in red?"
4. Agent searches → finds product → checks stock → out of stock
5. Agent offers notification signup
6. Say: "Yes, sign me up for notifications"
7. Agent calls `subscribe_in_stock` → run interrupted → SSE `tool_approval` event fires
8. Frontend shows inline approval buttons
9. Click "Yes, notify me"
10. `/approve` endpoint creates subscription (will 422 with placeholder IDs — expected) → graceful error message
11. Verify session continuity: follow-up messages should have full conversation context

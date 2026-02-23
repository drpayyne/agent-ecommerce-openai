import { Agent, run, tool, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { getDurableObject } from './durable-object';
import { DurableObjectSessionStore, buildRunInput, extractAssistantText } from './session';
import type { StreamEvent } from './session';
import { similaritySearch } from './vector-store';
import { getOrderStatus } from './commerce-layer';
import type { StockResult, OrderStatusResult } from './types';
import { instructions } from './instructions';

/**
 * Creates tools for the AI agent to interact with the Commerce Layer
 * 1. search_products: Uses vector similarity search to find products matching a query
 * 2. check_stock: Checks stock availability for a given product SKU code using the Durable Object
 * 3. check_order_status: Checks the status of an order using the Durable Object and Commerce Layer API
 */
function createTools(env: Env) {
  const searchProducts = tool({
    name: 'search_products',
    description:
      'Search for products by name, description, or any relevant query. Returns matching products with their SKU codes.',
    parameters: z.object({
      query: z.string().describe('The search query to find products (e.g., "blue shirt", "running shoes")'),
    }),
    async execute({ query }) {
      const results = await similaritySearch(query, env);

      if (results.length === 0) {
        return { message: 'No products found matching your query.' };
      }

      const products = results.map(([doc, score]) => ({
        name: doc.metadata.name,
        description: doc.metadata.description,
        sku_code: doc.metadata.code,
        score: score,
      }));

      return { products };
    },
  });

  const checkStockTool = tool({
    name: 'check_stock',
    description: 'Check the stock availability and quantity for a specific product SKU code.',
    parameters: z.object({
      sku_code: z.string().describe('The SKU code of the product to check stock for'),
    }),
    async execute({ sku_code }) {
      const stub = getDurableObject(env);
      const stockInfo: StockResult = await stub.checkStock(sku_code);
      return stockInfo;
    },
  });

  const checkOrderStatusTool = tool({
    name: 'check_order_status',
    description:
      'Check the status of an order. Can look up a specific order by number, or fetch the most recent order.',
    parameters: z.object({
      order_number: z
        .string()
        .describe('The order number to look up. Pass an empty string to return the most recent order.'),
    }),
    async execute({ order_number }) {
      const stub = getDurableObject(env);
      const token = await stub.getCommerceLayerToken();
      const result: OrderStatusResult | null = await getOrderStatus(
        env,
        token,
        'agent@madras.co',
        order_number || undefined
      );

      if (!result) {
        return { message: 'No orders found.' };
      }

      return result;
    },
  });

  return [searchProducts, checkStockTool, checkOrderStatusTool];
}

export async function handleResponse(env: Env, input: string, conversationId?: string): Promise<Response> {
  const openaiClient = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
  });

  setDefaultOpenAIClient(openaiClient);

  const tools = createTools(env);

  // Cast needed: DurableObjectStub<MyDurableObject> causes TS2589 (excessively deep type instantiation)
  // when ChatMessage flows through the RPC proxy types.
  const stub = getDurableObject(env) as any;
  const store = new DurableObjectSessionStore(stub);
  const sessionId = conversationId ?? crypto.randomUUID();

  const agent = new Agent({
    name: 'Shopping Assistant',
    model: 'gpt-5-nano',
    instructions,
    tools,
  });

  // Load durable history and build a replay-safe input array.
  // Every item is id-free — no provider-linked look-ups, no reasoning items.
  const history = await store.load(sessionId);
  const runInput = buildRunInput(history, input);

  // Stream the agent run without the SDK's Session — we handle persistence ourselves.
  const result = await run(agent, runInput, { stream: true });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const bufferedEvents: StreamEvent[] = [];
    let clientConnected = true;

    /** Write an SSE chunk, silently marking the client as disconnected on failure. */
    const sseWrite = async (chunk: string) => {
      if (!clientConnected) return;
      try {
        await writer.write(encoder.encode(chunk));
      } catch {
        clientConnected = false;
      }
    };

    try {
      await sseWrite(`event: conversation_id\ndata: ${JSON.stringify(sessionId)}\n\n`);

      // Iterate the full stream — even if the client disconnects we continue
      // draining so the agent run completes and we can commit the result.
      for await (const event of result) {
        bufferedEvents.push(event as StreamEvent);

        if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
          await sseWrite(`data: ${JSON.stringify(event.data.delta)}\n\n`);
        }
      }

      // Run completed — extract assistant text and commit atomically.
      const assistantText = extractAssistantText(bufferedEvents);
      if (assistantText) {
        const now = Date.now();
        await store.append(sessionId, [
          { role: 'user', text: input, createdAt: now },
          { role: 'assistant', text: assistantText, createdAt: now },
        ]);
      }

      await sseWrite('data: [DONE]\n\n');
    } catch (err) {
      // Run failed — discard buffer, don't commit partial results.
      console.error('Agent run error:', err);
      await sseWrite(`event: error\ndata: ${JSON.stringify('An error occurred while streaming the response.')}\n\n`);
      await sseWrite('data: [DONE]\n\n');
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

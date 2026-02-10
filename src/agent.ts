import { Agent, run, tool, setDefaultOpenAIClient, OpenAIConversationsSession } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { getDurableObject } from './durable-object';
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

  // const openaiClient = new OpenAI({
  //   apiKey: env.CLOUDFLARE_API_KEY,
  //   baseURL: 'https://gateway.ai.cloudflare.com/v1/c1a07233ad604ce4871cb64a332c8408/openai/openai',
  // });

  setDefaultOpenAIClient(openaiClient);

  const tools = createTools(env);

  const session = new OpenAIConversationsSession({
    conversationId,
    client: openaiClient,
  });

  const agent = new Agent({
    name: 'Shopping Assistant',
    model: 'gpt-5-nano',
    instructions,
    tools,
  });

  // Stream the agent run. Tool calls (search, stock check) execute server-side first;
  // once they finish the model generates its final text response, which we stream as SSE.
  const result = await run(agent, input, { stream: true, session });

  // We iterate over StreamedRunResult events directly rather than using toTextStream(),
  // because toTextStream() returns a standard-lib ReadableStream<string> whose type is
  // incompatible with the Workers Response constructor (lib.dom vs @cloudflare/workers-types).
  //
  // Each text delta is sent as an SSE message: `data: "<json-encoded text>"\n\n`
  // The double newline is the SSE spec's message delimiter. A final `data: [DONE]\n\n`
  // signals the end of the stream. Content-Type: text/event-stream tells browsers and
  // proxies not to buffer the response body.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const sessionId = await session.getSessionId();

      await writer.write(encoder.encode(`event: conversation_id\ndata: ${JSON.stringify(sessionId)}\n\n`));

      for await (const event of result) {
        if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
          await writer.write(encoder.encode(`data: ${JSON.stringify(event.data.delta)}\n\n`));
        }
      }

      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      console.error('SSE stream error:', err);
      try {
        await writer.write(
          encoder.encode(`event: error\ndata: ${JSON.stringify('An error occurred while streaming the response.')}\n\n`)
        );
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch {
        /* client already disconnected, nothing to do */
      }
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

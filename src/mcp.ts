import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDurableObject } from './durable-object';
import { similaritySearch } from './vector-store';
import { getOrderStatus } from './commerce-layer';
import type { StockResult, OrderStatusResult } from './types';

export function createMcpServer(env: Env) {
  const server = new McpServer({
    name: 'madras-company-tools',
    version: '1.0.0',
  });

  server.registerTool(
    'search_products',
    {
      description:
        'Search for products by name, description, or any relevant query. Returns matching products with their SKU codes.',
      inputSchema: {
        query: z.string().describe('The search query to find products (e.g., "blue shirt", "running shoes")'),
      },
    },
    async ({ query }) => {
      const results = await similaritySearch(query, env);

      if (results.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ message: 'No products found matching your query.' }) },
          ],
        };
      }

      const products = results.map(([doc, score]: [any, number]) => ({
        name: doc.metadata.name,
        description: doc.metadata.description,
        sku_code: doc.metadata.code,
        score,
      }));

      return { content: [{ type: 'text' as const, text: JSON.stringify({ products }) }] };
    }
  );

  server.registerTool(
    'check_stock',
    {
      description: 'Check the stock availability and quantity for a specific product SKU code.',
      inputSchema: {
        sku_code: z.string().describe('The SKU code of the product to check stock for'),
      },
    },
    async ({ sku_code }) => {
      const stub = getDurableObject(env);
      const stockInfo: StockResult = await stub.checkStock(sku_code);
      return { content: [{ type: 'text' as const, text: JSON.stringify(stockInfo) }] };
    }
  );

  server.registerTool(
    'check_order_status',
    {
      description:
        'Check the status of an order. Can look up a specific order by number, or fetch the most recent order.',
      inputSchema: {
        order_number: z
          .string()
          .describe('The order number to look up. Pass an empty string to return the most recent order.'),
      },
    },
    async ({ order_number }) => {
      const stub = getDurableObject(env);
      const token = await stub.getCommerceLayerToken();
      const result: OrderStatusResult | null = await getOrderStatus(
        env,
        token,
        'agent@madras.co',
        order_number || undefined
      );

      if (!result) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'No orders found.' }) }] };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
  );

  return server;
}

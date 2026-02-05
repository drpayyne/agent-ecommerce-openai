import { Agent, run, tool, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { getDurableObject } from './durable-object';
import { similaritySearch } from './vector-store';
import { getOrderStatus } from './commerce-layer';
import type { StockResult, OrderStatusResult } from './types';

/**
 * Creates tools for the AI agent to interact with the Commerce Layer
 * 1. search_products: Uses vector similarity search to find products matching a query
 * 2. check_stock: Checks stock availability for a given product SKU code using the Durable Object
 * 3. check_order_status: Checks the status of an order using the Durable Object and Commerce Layer API
 */
function createTools(env: Env) {
	const searchProducts = tool({
		name: 'search_products',
		description: 'Search for products by name, description, or any relevant query. Returns matching products with their SKU codes.',
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
		description: 'Check the status of an order. Can look up a specific order by number, or fetch the most recent order.',
		parameters: z.object({
			order_number: z.string().describe('The order number to look up. Pass an empty string to return the most recent order.'),
		}),
		async execute({ order_number }) {
			const stub = getDurableObject(env);
			const token = await stub.getCommerceLayerToken();
			const result: OrderStatusResult | null = await getOrderStatus(env, token, 'agent@madras.co', order_number || undefined);

			if (!result) {
				return { message: 'No orders found.' };
			}

			return result;
		},
	});

	return [searchProducts, checkStockTool, checkOrderStatusTool];
}

export async function handleResponse(env: Env, input: string): Promise<Response> {
	const openaiClient = new OpenAI({
		apiKey: env.CLOUDFLARE_API_KEY,
		baseURL: 'https://gateway.ai.cloudflare.com/v1/c1a07233ad604ce4871cb64a332c8408/openai/openai',
	});

	setDefaultOpenAIClient(openaiClient);

	const tools = createTools(env);

	const agent = new Agent({
		name: 'Shopping Assistant',
		model: 'gpt-5-nano',
		instructions: `You are a helpful shopping assistant. You help customers find products, check stock availability, and check order status.

When a customer asks about a product:
1. First use search_products tool to find matching products
2. Then use check_stock tool with the SKU code to check availability
3. Respond in natural, conversational language - weave the product name, what it is, what it's good for, and stock availability into flowing sentences. Never use labels like "Product:", "Description:", or "In stock:" - just talk naturally like a friendly store assistant would.

Example good response: "Great news! We have the 100% Cotton Poplin in red - it's a lovely plain cotton fabric that works beautifully for dressmaking, quilting, or crafting projects. We've got plenty in stock with 99 units available. Want me to reserve some for you?"

When a customer asks about their order status:
1. Use check_order_status tool, passing the order number if the customer provided one
2. Respond conversationally mentioning the order number, status, payment status, and fulfillment status
3. Never use labels like "Status:" - weave the information naturally into your response

Keep responses warm, helpful, and conversational.`,
		tools,
	});

	const result = await run(agent, input);

	return new Response(result.finalOutput);
}

import { CloudflareVectorizeStore, CloudflareWorkersAIEmbeddings } from '@langchain/cloudflare';
import { DurableObject } from 'cloudflare:workers';
import { Agent, run, tool, setDefaultOpenAIClient } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

export interface Env {
	CLOUDFLARE_API_KEY: string;
	CL_CLIENT_ID: string;
	CL_CLIENT_SECRET: string;
	CL_DOMAIN: string;
	VECTORIZE_INDEX: Vectorize;
	AI: Ai;
	MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
}

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

type StockResult = { skuCode: string; quantity: number; available: boolean };

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject<Env> {
	private token: string | null = null;
	private tokenExpiresAt: number = 0;
	private stockCache: Map<string, { data: StockResult; expiresAt: number }> = new Map();
	private inflightStock: Map<string, Promise<StockResult>> = new Map();

	async getCommerceLayerToken(): Promise<string> {
		const now = Date.now();

		// Return cached token if still valid (with 5 min buffer)
		if (this.token && this.tokenExpiresAt > now + 5 * 60 * 1000) {
			return this.token;
		}

		// Try to load from storage
		const stored = await this.ctx.storage.get<{ token: string; expiresAt: number }>('cl_token');
		if (stored && stored.expiresAt > now + 5 * 60 * 1000) {
			this.token = stored.token;
			this.tokenExpiresAt = stored.expiresAt;
			return this.token;
		}

		// Fetch new token
		const res = await fetch('https://auth.commercelayer.io/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				grant_type: 'client_credentials',
				client_id: this.env.CL_CLIENT_ID,
				client_secret: this.env.CL_CLIENT_SECRET,
			}),
		});

		if (!res.ok) throw new Error(`CL token error: ${res.status} ${await res.text()}`);

		const data = (await res.json()) as { access_token: string; expires_in: number };

		this.token = data.access_token;
		// expires_in is in seconds, convert to ms and add to current time
		this.tokenExpiresAt = now + data.expires_in * 1000;

		// Persist to storage
		await this.ctx.storage.put('cl_token', {
			token: this.token,
			expiresAt: this.tokenExpiresAt,
		});

		return this.token;
	}

	async checkStock(skuCode: string): Promise<StockResult> {
		// 1. Return existing inflight request (prevents thundering herd)
		const inflight = this.inflightStock.get(skuCode);
		if (inflight) return inflight;

		// 2. Check memory cache
		const cached = this.stockCache.get(skuCode);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.data;
		}

		// 3. Check storage cache
		const stored = await this.ctx.storage.get<{ data: StockResult; expiresAt: number }>(`stock:${skuCode}`);
		if (stored && stored.expiresAt > Date.now()) {
			this.stockCache.set(skuCode, stored);
			return stored.data;
		}

		// 4. Fetch from API with inflight tracking
		const promise = this.fetchStockFromAPI(skuCode);
		this.inflightStock.set(skuCode, promise);

		try {
			const result = await promise;
			const cacheEntry = { data: result, expiresAt: Date.now() + 60_000 };
			this.stockCache.set(skuCode, cacheEntry);
			await this.ctx.storage.put(`stock:${skuCode}`, cacheEntry);
			return result;
		} finally {
			this.inflightStock.delete(skuCode);
		}
	}

	private async fetchStockFromAPI(skuCode: string): Promise<StockResult> {
		const token = await this.getCommerceLayerToken();

		const res = await fetch(`https://${this.env.CL_DOMAIN}/api/stock_items?filter[q][code_eq]=${encodeURIComponent(skuCode)}`, {
			headers: {
				Accept: 'application/vnd.api+json',
				Authorization: `Bearer ${token}`,
			},
		});

		if (!res.ok) throw new Error(`CL API error: ${res.status} ${await res.text()}`);

		const response = (await res.json()) as {
			data: Array<{
				id: string;
				attributes: {
					sku_code: string;
					quantity: number;
				};
			}>;
		};

		if (!response.data || response.data.length === 0) {
			return { skuCode, quantity: 0, available: false };
		}

		// Sum quantities across all stock locations
		const totalQuantity = response.data.reduce((sum, item) => sum + (item.attributes.quantity || 0), 0);

		return {
			skuCode,
			quantity: totalQuantity,
			available: totalQuantity > 0,
		};
	}
}

type CommerceLayerSKU = {
	id: string;
	attributes: {
		code: string;
		name: string;
		description: string;
		image_url?: string;
		weight?: number;
		unit_of_weight?: string;
	};
};

function getDurableObject(env: Env) {
	const id = env.MY_DURABLE_OBJECT.idFromName('openai');
	return env.MY_DURABLE_OBJECT.get(id);
}

async function getCommerceLayer(env: Env, token: string, path: string) {
	const res = await fetch(`https://${env.CL_DOMAIN}${path}`, {
		headers: {
			Accept: 'application/vnd.api+json',
			Authorization: `Bearer ${token}`,
		},
	});

	if (!res.ok) throw new Error(`CL API error: ${res.status} ${await res.text()}`);
	return res.json();
}

function skuToText(sku: CommerceLayerSKU): string {
	// Commerce Layer SKU name/description are “internal usage”, but still useful for search indexing. :contentReference[oaicite:5]{index=5}
	const code = sku.attributes.code;
	const name = sku.attributes.name;
	const desc = sku.attributes.description;
	const weight = sku.attributes.weight ?? 0;
	const unitOfWeight = sku.attributes.unit_of_weight ?? '';

	return [`Name: ${name}`, `Description: ${desc}`, `SKU: ${code}`, weight && unitOfWeight && `Weight: ${weight} ${unitOfWeight}`]
		.filter(Boolean)
		.join('\n');
}

function getVectorStore(env: Env): CloudflareVectorizeStore {
	const embeddings = new CloudflareWorkersAIEmbeddings({
		binding: env.AI,
		model: '@cf/baai/bge-small-en-v1.5',
	});

	const store = new CloudflareVectorizeStore(embeddings, {
		index: env.VECTORIZE_INDEX,
	});

	return store;
}

async function similaritySearch(query: string, env: Env): Promise<any[]> {
	const store = getVectorStore(env);
	const results = await store.similaritySearchWithScore(query, 2);

	return results;
}

async function checkStock(env: Env, skuCode: string): Promise<StockResult> {
	const stub = getDurableObject(env);
	return stub.checkStock(skuCode);
}

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
			const stockInfo = await checkStock(env, sku_code);
			return stockInfo;
		},
	});

	return [searchProducts, checkStockTool];
}

async function clearIndex(env: Env): Promise<Response> {
	const embeddings = new CloudflareWorkersAIEmbeddings({
		binding: env.AI,
		model: '@cf/baai/bge-small-en-v1.5',
	});

	// Generate a dummy embedding to query for existing vectors
	const dummyEmbedding = await embeddings.embedQuery('search');

	let totalDeleted = 0;
	let hasMore = true;

	while (hasMore) {
		const results = await env.VECTORIZE_INDEX.query(dummyEmbedding, {
			topK: 100,
			returnMetadata: 'none',
		});

		if (results.matches.length === 0) {
			hasMore = false;
			break;
		}

		const ids = results.matches.map((match) => match.id);
		await env.VECTORIZE_INDEX.deleteByIds(ids);
		totalDeleted += ids.length;
	}

	return new Response(JSON.stringify({ status: 'index cleared', deletedCount: totalDeleted }), {
		headers: { 'Content-Type': 'application/json' },
	});
}

async function reindexProducts(env: Env): Promise<Response> {
	const store = getVectorStore(env);
	const stub = getDurableObject(env);
	const token = await stub.getCommerceLayerToken();
	const skus = (await getCommerceLayer(env, token, '/api/skus')) as { data: CommerceLayerSKU[] };

	if (!skus.data || skus.data.length === 0) {
		return new Response(JSON.stringify({ status: 'no skus found' }), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	for (const sku of skus.data) {
		const text = skuToText(sku);

		await store.addDocuments([
			{
				pageContent: text,
				metadata: {
					id: sku.id,
					code: sku.attributes.code,
					name: sku.attributes.name,
					description: sku.attributes.description,
					image_url: sku.attributes.image_url,
					weight: sku.attributes.weight,
					unit_of_weight: sku.attributes.unit_of_weight,
				},
			},
		]);

		console.log(`Indexed SKU: ${sku.id} - ${sku.attributes.code}`);
	}

	return new Response(JSON.stringify({ status: 'reindex completed' }), {
		headers: { 'Content-Type': 'application/json' },
	});
}

async function handleResponse(env: Env, input: string): Promise<Response> {
	const openaiClient = new OpenAI({
		apiKey: env.CLOUDFLARE_API_KEY,
		baseURL: 'https://gateway.ai.cloudflare.com/v1/c1a07233ad604ce4871cb64a332c8408/openai/openai',
	});

	setDefaultOpenAIClient(openaiClient);

	const tools = createTools(env);

	const agent = new Agent({
		name: 'Shopping Assistant',
		model: 'gpt-5-nano',
		instructions: `You are a helpful shopping assistant. You help customers find products and check stock availability.

When a customer asks about a product:
1. First use search_products tool to find matching products
2. Then use check_stock tool with the SKU code to check availability
3. Respond in natural, conversational language - weave the product name, what it is, what it's good for, and stock availability into flowing sentences. Never use labels like "Product:", "Description:", or "In stock:" - just talk naturally like a friendly store assistant would.

Example good response: "Great news! We have the 100% Cotton Poplin in red - it's a lovely plain cotton fabric that works beautifully for dressmaking, quilting, or crafting projects. We've got plenty in stock with 99 units available. Want me to reserve some for you?"

Keep responses warm, helpful, and conversational.`,
		tools,
	});

	const result = await run(agent, input);

	return new Response(result.finalOutput);
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/reindex') {
			return reindexProducts(env);
		}

		if (request.method === 'DELETE' && url.pathname === '/clear-index') {
			return clearIndex(env);
		}

		if (request.method === 'GET' && url.pathname === '/search') {
			const query = url.searchParams.get('q');

			if (!query) {
				return new Response(JSON.stringify({ error: 'Missing required query parameter: q' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const results = await similaritySearch(query, env);

			return Response.json(results);
		}

		if (request.method === 'GET' && url.pathname === '/chat') {
			const input = url.searchParams.get('q');

			return handleResponse(env, input ?? 'Within 20 words, explain ai agents');
		}

		return new Response('Cloudflare Durable Objects + Workers AI + Vectorize + Langchain + OpenAI', { status: 200 });
	},
} satisfies ExportedHandler<Env>;

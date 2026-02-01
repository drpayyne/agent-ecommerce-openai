import { CloudflareVectorizeStore, CloudflareWorkersAIEmbeddings } from '@langchain/cloudflare';
import { DurableObject } from 'cloudflare:workers';
import OpenAI from 'openai';

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

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject<Env> {
	private token: string | null = null;
	private tokenExpiresAt: number = 0;

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
	const skus = await getCommerceLayer(env, token, '/api/skus');

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

async function handleResponse(env: Env): Promise<Response> {
	const openai = new OpenAI({
		apiKey: env.CLOUDFLARE_API_KEY,
		baseURL: 'https://gateway.ai.cloudflare.com/v1/c1a07233ad604ce4871cb64a332c8408/openai/openai',
	});

	const response = await openai.responses.create({
		model: 'gpt-5-nano',
		instructions: 'You are a helpful assistant.',
		input: 'Within 20 words, explain ai agents',
	});

	return new Response(response.output_text);
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

		return handleResponse(env);
	},
} satisfies ExportedHandler<Env>;

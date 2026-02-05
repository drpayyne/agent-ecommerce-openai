import type { Env } from './types';
import { handleResponse } from './agent';
import { similaritySearch, clearIndex, reindexProducts } from './vector-store';

export { MyDurableObject } from './durable-object';
export type { Env } from './types';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Sync and embed all Commerce Layer SKUs into the vector index
		if (request.method === 'GET' && url.pathname === '/reindex') {
			return reindexProducts(env);
		}

		// Remove all vectors from the product index
		if (request.method === 'DELETE' && url.pathname === '/clear-index') {
			return clearIndex(env);
		}

		// Semantic similarity search against the product catalog
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

		// AI shopping assistant with product search and stock checking
		if (request.method === 'GET' && url.pathname === '/chat') {
			const input = url.searchParams.get('q');

			return handleResponse(env, input ?? 'Within 20 words, explain ai agents');
		}

		return new Response('Cloudflare Durable Objects + Workers AI + Vectorize + Langchain + OpenAI', { status: 200 });
	},
} satisfies ExportedHandler<Env>;

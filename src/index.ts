import { handleResponse } from './agent';
import { similaritySearch, clearIndex, reindexProducts } from './vector-store';

export { MyDurableObject } from './durable-object';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
};

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(corsHeaders)) {
		headers.set(key, value);
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		// Sync and embed all Commerce Layer SKUs into the vector index
		if (request.method === 'GET' && url.pathname === '/reindex') {
			return withCors(await reindexProducts(env));
		}

		// Remove all vectors from the product index
		if (request.method === 'DELETE' && url.pathname === '/clear-index') {
			return withCors(await clearIndex(env));
		}

		// Semantic similarity search against the product catalog
		if (request.method === 'GET' && url.pathname === '/search') {
			const query = url.searchParams.get('q');

			if (!query) {
				return withCors(
					new Response(JSON.stringify({ error: 'Missing required query parameter: q' }), {
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					})
				);
			}

			const results = await similaritySearch(query, env);

			return withCors(Response.json(results));
		}

		// AI shopping assistant with product search and stock checking
		if (request.method === 'GET' && url.pathname === '/chat') {
			const input = url.searchParams.get('q');

			return withCors(await handleResponse(env, input ?? 'Within 20 words, explain ai agents'));
		}

		return withCors(new Response('Cloudflare Durable Objects + Workers AI + Vectorize + Langchain + OpenAI', { status: 200 }));
	},
} satisfies ExportedHandler<Env>;

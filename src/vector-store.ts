import { CloudflareVectorizeStore, CloudflareWorkersAIEmbeddings } from '@langchain/cloudflare';
import { getDurableObject } from './durable-object';
import { getCommerceLayer, skuToText } from './commerce-layer';
import type { Env, CommerceLayerSKU } from './types';

export function getVectorStore(env: Env): CloudflareVectorizeStore {
	const embeddings = new CloudflareWorkersAIEmbeddings({
		binding: env.AI,
		model: '@cf/baai/bge-small-en-v1.5',
	});

	const store = new CloudflareVectorizeStore(embeddings, {
		index: env.VECTORIZE_INDEX,
	});

	return store;
}

export async function similaritySearch(query: string, env: Env): Promise<any[]> {
	const store = getVectorStore(env);
	const results = await store.similaritySearchWithScore(query, 2);

	return results;
}

export async function clearIndex(env: Env): Promise<Response> {
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

export async function reindexProducts(env: Env): Promise<Response> {
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

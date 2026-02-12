import { CloudflareVectorizeStore, CloudflareWorkersAIEmbeddings } from '@langchain/cloudflare';
import { getDurableObject } from './durable-object';
import { fetchAll, getCommerceLayer, skuToText } from './commerce-layer';
import type { CommerceLayerSKU } from './types';

function getEmbeddings(env: Env) {
  return new CloudflareWorkersAIEmbeddings({
    binding: env.AI,
    model: '@cf/baai/bge-small-en-v1.5',
  });
}

export function getVectorStore(env: Env): CloudflareVectorizeStore {
  const embeddings = getEmbeddings(env);

  // wrangler vectorize create madras-company-products --dimensions=384 --metric=cosine --description="Madras Company's products"
  // wrangler vectorize delete madras-company-products
  const store = new CloudflareVectorizeStore(embeddings, {
    index: env.VECTORIZE,
  });

  return store;
}

export async function similaritySearch(query: string, env: Env): Promise<any[]> {
  const store = getVectorStore(env);
  const results = await store.similaritySearchWithScore(query, 10);

  return results;
}

export async function clearIndex(env: Env): Promise<Response> {
  const embeddings = getEmbeddings(env);

  // Generate a dummy embedding to query for existing vectors
  const dummyEmbedding = await embeddings.embedQuery('search');

  let totalDeleted = 0;
  let hasMore = true;

  while (hasMore) {
    const results = await env.VECTORIZE.query(dummyEmbedding, {
      topK: 100,
      returnMetadata: 'none',
    });

    if (results.matches.length === 0) {
      hasMore = false;
      break;
    }

    const ids = results.matches.map((match) => match.id);
    await env.VECTORIZE.deleteByIds(ids);
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
  const skus = (await fetchAll(env, token, '/api/skus', { 'page[size]': '25' })) as CommerceLayerSKU[];

  if (!skus || skus.length === 0) {
    return new Response(JSON.stringify({ status: 'no skus found' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const documents = skus.map((sku) => ({
    pageContent: skuToText(sku),
    metadata: {
      id: sku.id,
      code: sku.attributes.code,
      name: sku.attributes.name,
      description: sku.attributes.description,
      image_url: sku.attributes.image_url,
      weight: sku.attributes.weight,
      unit_of_weight: sku.attributes.unit_of_weight,
    },
  }));

  await store.addDocuments(documents);

  console.log(`Indexed ${documents.length} SKUs`);

  return new Response(JSON.stringify({ status: 'reindex completed' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

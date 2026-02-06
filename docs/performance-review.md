# Performance Review

Last reviewed: 2026-02-06

## High

### PERF-1: Sequential N+1 SKU indexing

**File:** `src/vector-store.ts:71-88`

```typescript
for (const sku of skus.data) {
	const text = skuToText(sku);
	await store.addDocuments([{ pageContent: text, metadata: { ... } }]);
}
```

Each SKU is indexed individually — one embedding API call and one Vectorize upsert per SKU. For N SKUs this makes 2N sequential API calls. A catalog of 100 SKUs means 200 round trips.

**Recommendation:** Batch all documents into a single `addDocuments` call:

```typescript
const documents = skus.data.map(sku => ({
	pageContent: skuToText(sku),
	metadata: { id: sku.id, code: sku.attributes.code, ... },
}));
await store.addDocuments(documents);
```

---

### PERF-2: No pagination on SKU fetch

**File:** `src/vector-store.ts:63`

```typescript
const skus = (await getCommerceLayer(env, token, '/api/skus')) as { data: CommerceLayerSKU[] };
```

Commerce Layer APIs have a default page size (typically 10-25). Only the first page of SKUs is fetched, so most of the catalog is silently never indexed as it grows.

**Recommendation:** Paginate by following `meta.page_count` or `links.next` in the response. Loop through all pages until the full catalog is fetched.

---

## Medium

### PERF-3: Unbounded in-memory cache growth

**File:** `src/durable-object.ts:17`

```typescript
private stockCache: Map<string, { data: StockResult; expiresAt: number }> = new Map();
```

The `stockCache` Map grows without bound. Entries have a 60-second TTL but expired entries are never proactively evicted — they persist in memory until the same SKU is queried again. With many distinct SKU lookups, this accumulates indefinitely. Durable Object memory is capped at 128MB.

**Recommendation:** Add periodic eviction. Sweep expired entries on each `checkStock` call:

```typescript
for (const [key, entry] of this.stockCache) {
  if (entry.expiresAt <= Date.now()) this.stockCache.delete(key);
}
```

Alternatively, use an LRU cache with a max size.

---

### PERF-4: Blocking storage write on every cache miss

**File:** `src/durable-object.ts:90`

```typescript
await this.ctx.storage.put(`stock:${skuCode}`, cacheEntry);
```

Every fresh stock lookup blocks on a Durable Object storage write. Since the in-memory cache already serves the hot path, the storage write could be made non-blocking.

**Recommendation:** Use `this.ctx.waitUntil()` to fire-and-forget the storage write, or increase the storage TTL to reduce write frequency.

---

### PERF-5: Inefficient clearIndex implementation

**File:** `src/vector-store.ts:26-57`

```typescript
const dummyEmbedding = await embeddings.embedQuery('search');
while (hasMore) {
  const results = await env.VECTORIZE_INDEX.query(dummyEmbedding, { topK: 100 });
  // ...delete by IDs
}
```

Issues:

1. Generates a dummy embedding (unnecessary API call)
2. Queries by similarity to the word "search" — vectors semantically distant from "search" may never be returned
3. Deletes in batches of 100 with multiple round trips
4. Risk of infinite loop if `deleteByIds` doesn't immediately remove vectors from query results (eventual consistency)

**Recommendation:** Use a bulk delete or index clear API if Vectorize supports one. Otherwise, maintain a list of inserted IDs separately, or use a different query strategy.

---

## Low

### PERF-6: New OpenAI client and Agent created per request

**File:** `src/agent.ts:76-104`

A new `OpenAI` client, tool set, and `Agent` instance are created for every request. In the Workers model this is generally acceptable since each request runs in isolation, but `setDefaultOpenAIClient` called concurrently could cause race conditions if the isolate handles multiple requests.

**Recommendation:** Acceptable for now. Document as intentional. If performance becomes an issue, consider module-level caching.

---

### PERF-7: New vector store instance per search

**File:** `src/vector-store.ts:6-24`

`CloudflareWorkersAIEmbeddings` and `CloudflareVectorizeStore` are re-instantiated on every `similaritySearch` call. These are lightweight constructors so the impact is minimal, but it prevents any internal connection pooling.

**Recommendation:** Acceptable for now. Consider caching if profiling reveals overhead.

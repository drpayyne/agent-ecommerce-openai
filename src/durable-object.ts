import { DurableObject } from 'cloudflare:workers';
import type { StockResult } from './types';

export function getDurableObject(env: Env) {
  const id = env.MY_DURABLE_OBJECT.idFromName('openai');

  return env.MY_DURABLE_OBJECT.get(id);
}

/**
 * Cloudflare Durable Object for persisting Commerce Layer API tokens and caching stock information.
 * This helps reduce latency and API calls when checking stock availability for products.
 */
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

    const res = await fetch(
      `https://${this.env.CL_DOMAIN}/api/stock_items?filter[q][code_eq]=${encodeURIComponent(skuCode)}`,
      {
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${token}`,
        },
      }
    );

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

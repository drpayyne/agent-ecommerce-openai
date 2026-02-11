import type { CommerceLayerSKU, OrderStatusResult } from './types';

export async function getCommerceLayer(env: Env, token: string, path: string, params?: Record<string, string>) {
  const url = new URL(`https://${env.CL_DOMAIN}${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/vnd.api+json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) throw new Error(`CL API error: ${res.status} ${await res.text()}`);

  return res.json();
}

export async function fetchAll<T = any>(
  env: Env,
  token: string,
  path: string,
  params?: Record<string, string>
): Promise<T[]> {
  const headers = {
    Accept: 'application/vnd.api+json',
    Authorization: `Bearer ${token}`,
  };

  // First page — reuse getCommerceLayer for consistent URL building and error handling
  let data = (await getCommerceLayer(env, token, path, params)) as {
    data: T[];
    meta: {
      record_count: number;
      page_count: number;
    };
    links: { first: string; next: string; last: string };
  };
  const allItems: T[] = [...(data.data ?? [])];

  // Follow links.next until exhausted
  while (data.links?.next) {
    const res = await fetch(data.links.next, { headers });

    if (!res.ok) throw new Error(`CL API error: ${res.status} ${await res.text()}`);

    data = await res.json();

    allItems.push(...(data.data ?? []));
  }

  return allItems;
}

export async function getOrderStatus(
  env: Env,
  token: string,
  email: string,
  orderNumber?: string
): Promise<OrderStatusResult | null> {
  const params = new URLSearchParams();
  if (orderNumber) {
    params.set('filter[q][number_eq]', orderNumber);
  } else {
    params.set('filter[q][customer_email_eq]', email);
  }
  params.set('sort', '-created_at');
  params.set('page[size]', '1');

  const data: any = await getCommerceLayer(env, token, `/api/orders?${params.toString()}`);
  const orders = data.data;

  if (!orders || orders.length === 0) return null;

  const order = orders[0];
  return {
    orderNumber: order.attributes.number,
    status: order.attributes.status,
    paymentStatus: order.attributes.payment_status,
    fulfillmentStatus: order.attributes.fulfillment_status,
  };
}

export function skuToText(sku: CommerceLayerSKU): string {
  const code = sku.attributes.code;
  const name = sku.attributes.name;
  const desc = sku.attributes.description;
  const weight = sku.attributes.weight ?? 0;
  const unitOfWeight = sku.attributes.unit_of_weight ?? '';

  return [
    `Name: ${name}`,
    `Description: ${desc}`,
    `SKU: ${code}`,
    weight && unitOfWeight && `Weight: ${weight} ${unitOfWeight}`,
  ]
    .filter(Boolean)
    .join('\n');
}

import type { CommerceLayerSKU, OrderStatusResult } from './types';

export async function getCommerceLayer(env: Env, token: string, path: string) {
  const res = await fetch(`https://${env.CL_DOMAIN}${path}`, {
    headers: {
      Accept: 'application/vnd.api+json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) throw new Error(`CL API error: ${res.status} ${await res.text()}`);

  return res.json();
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

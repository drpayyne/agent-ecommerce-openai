import type { Env, CommerceLayerSKU } from './types';

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

export function skuToText(sku: CommerceLayerSKU): string {
	const code = sku.attributes.code;
	const name = sku.attributes.name;
	const desc = sku.attributes.description;
	const weight = sku.attributes.weight ?? 0;
	const unitOfWeight = sku.attributes.unit_of_weight ?? '';

	return [`Name: ${name}`, `Description: ${desc}`, `SKU: ${code}`, weight && unitOfWeight && `Weight: ${weight} ${unitOfWeight}`]
		.filter(Boolean)
		.join('\n');
}

import type { MyDurableObject } from './durable-object';

export interface Env {
	CLOUDFLARE_API_KEY: string;
	CL_CLIENT_ID: string;
	CL_CLIENT_SECRET: string;
	CL_DOMAIN: string;
	VECTORIZE_INDEX: Vectorize;
	AI: Ai;
	MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
}

export type StockResult = { skuCode: string; quantity: number; available: boolean };

export type CommerceLayerSKU = {
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

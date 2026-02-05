export type StockResult = { skuCode: string; quantity: number; available: boolean };

export type OrderStatusResult = {
	orderNumber: string;
	status: string;
	paymentStatus: string;
	fulfillmentStatus: string;
};

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

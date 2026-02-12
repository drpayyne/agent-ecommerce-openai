import CommerceLayer, {
  addresses,
  inventory_models,
  inventory_stock_locations,
  line_items,
  markets,
  orders,
  shipments,
  skus,
  stock_items,
  stock_locations,
  stock_reservations,
} from '@commercelayer/sdk';

CommerceLayer({
  accessToken: String(process.env.CL_ACCESS_TOKEN),
});

async function main() {
  const address = await addresses.retrieve('pyeuqDQjkp');

  // const skuList = await skus.list();

  // const stockLocations = await stock_locations.list();

  // const inventoryModel = await inventory_models.list();

  // const inventoryStockLocations = await inventory_stock_locations.list();

  // const stockItems = await stock_items.list();

  // const stockReservations = await stock_reservations.list();

  const redPoplinSku = await skus.list({
    filters: { code_eq: '100-cotton-poplin-plain-red', stock_items_quantity_gt: 0 },
  });

  const market = await markets.list({ filters: { name_eq: 'Mint Market' } });

  let order = await orders.create({
    market: market[0],
  });

  // // const orderList = await orders.list({ pageSize: 1, sort: { created_at: 'desc' } });
  // // console.log(orderList);

  // // const lineItems = await line_items.list();
  // // console.log(lineItems);

  await line_items.create({
    order,
    item: redPoplinSku[0],
    quantity: 1,
  });

  // orders.update({ id: order.id, customer_email: 'agent@madras.co' });

  const shipmentsList = await shipments.list({
    filters: { order_id_eq: order.id },
    include: ['available_shipping_methods', 'stock_location'],
  });
  console.log(shipmentsList);

  order = await orders.update({ id: order.id, billing_address: address, shipping_address: address });

  console.log(order);
}

main();

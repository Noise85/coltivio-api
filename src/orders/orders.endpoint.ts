import createHttpError from "http-errors";
import { ez } from "express-zod-api";
import { z } from "zod";
import { orderStatusSchema } from "../db/schema";
import { contactSchema } from "../contacts/contacts.endpoint";
import { paymentSchema } from "../payments/payment-schema";
import { paymentMethodSchema } from "../db/schema";
import { productSchema } from "../products/products.endpoint";
import { permissionFarmEndpoint } from "../endpoint-factory";

const ordersRead = permissionFarmEndpoint("commerce", "read");
const ordersWrite = permissionFarmEndpoint("commerce", "write");

export const orderSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  contactId: z.string(),
  status: orderStatusSchema,
  orderDate: ez.dateOut(),
  shippingDate: ez.dateOut().nullable(),
  notes: z.string().nullable(),
});

export const orderItemSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  orderId: z.string(),
  productId: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
});

export const orderItemWithProductSchema = orderItemSchema.extend({
  product: productSchema,
});

const orderWithRelationsSchema = orderSchema.extend({
  get contact() {
    return contactSchema;
  },
  items: z.array(orderItemWithProductSchema),
  get payments() {
    return z.array(paymentSchema);
  },
});

const orderWithContactSchema = orderSchema.extend({
  get contact() {
    return contactSchema;
  },
  items: z.array(orderItemWithProductSchema),
  get payments() {
    return z.array(paymentSchema);
  },
});

const orderItemInputSchema = z.object({
  productId: z.string(),
  quantity: z.number().positive(),
  unitPrice: z.number().nonnegative().optional(),
});

export const getOrderByIdEndpoint = ordersRead.build({
  method: "get",
  input: z.object({ orderId: z.string() }),
  output: orderWithRelationsSchema,
  handler: async ({ input, ctx: { orders } }) => {
    const order = await orders.getOrderById(input.orderId);
    if (!order) {
      throw createHttpError(404, "Order not found");
    }
    return order;
  },
});

const orderWithPaidFlagSchema = orderWithContactSchema.extend({
  paidInFull: z.boolean(),
});

export const getFarmOrdersEndpoint = ordersRead.build({
  method: "get",
  input: z.object({}),
  output: z.object({
    result: z.array(orderWithPaidFlagSchema),
    count: z.number(),
  }),
  handler: async ({ ctx: { orders, farmId } }) => {
    const rawResult = await orders.getOrdersForFarm(farmId);
    const result = rawResult.map((order) => {
      const orderTotal = order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
      const totalPaid = order.payments.reduce((sum, p) => sum + p.amount, 0);
      return { ...order, paidInFull: totalPaid >= orderTotal };
    });
    return {
      result,
      count: result.length,
    };
  },
});

export const getContactOrdersEndpoint = ordersRead.build({
  method: "get",
  input: z.object({ contactId: z.string() }),
  output: z.object({
    result: z.array(orderSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { orders } }) => {
    const result = await orders.getOrdersForContact(input.contactId);
    return {
      result,
      count: result.length,
    };
  },
});

export const getOrderItemsEndpoint = ordersRead.build({
  method: "get",
  input: z.object({ orderId: z.string() }),
  output: z.object({
    result: z.array(orderItemSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { orders } }) => {
    const result = await orders.getOrderItems(input.orderId);
    return {
      result,
      count: result.length,
    };
  },
});

export const createOrderEndpoint = ordersWrite.build({
  method: "post",
  input: z.object({
    contactId: z.string(),
    orderDate: ez.dateIn(),
    shippingDate: ez.dateIn().optional(),
    notes: z.string().optional(),
    status: z.enum(["pending", "confirmed"]).optional(),
    items: z.array(orderItemInputSchema).min(1),
  }),
  output: orderWithRelationsSchema,
  handler: async ({ input, ctx: { orders } }) => {
    const { items, ...orderData } = input;
    return orders.createOrder(orderData, items);
  },
});

export const confirmOrderEndpoint = ordersWrite.build({
  method: "post",
  input: z.object({ orderId: z.string() }),
  output: orderSchema,
  handler: async ({ input, ctx: { orders } }) => {
    return orders.confirmOrder(input.orderId);
  },
});

export const fulfillOrderEndpoint = ordersWrite.build({
  method: "post",
  input: z.object({ orderId: z.string() }),
  output: orderSchema,
  handler: async ({ input, ctx: { orders } }) => {
    return orders.fulfillOrder(input.orderId);
  },
});

export const cancelOrderEndpoint = ordersWrite.build({
  method: "post",
  input: z.object({ orderId: z.string() }),
  output: orderSchema,
  handler: async ({ input, ctx: { orders } }) => {
    return orders.cancelOrder(input.orderId);
  },
});

export const updateOrderEndpoint = ordersWrite.build({
  method: "patch",
  input: z.object({
    orderId: z.string(),
    notes: z.string().optional(),
    shippingDate: ez.dateIn().optional(),
  }),
  output: orderSchema,
  handler: async ({ input, ctx: { orders } }) => {
    const { orderId, ...data } = input;
    return orders.updateOrderNotes(orderId, data);
  },
});

export const addOrderItemEndpoint = ordersWrite.build({
  method: "post",
  input: z.object({
    orderId: z.string(),
    productId: z.string(),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative().optional(),
  }),
  output: orderItemWithProductSchema,
  handler: async ({ input, ctx: { orders } }) => {
    const { orderId, ...item } = input;
    return orders.addOrderItem(orderId, item);
  },
});

export const updateOrderItemEndpoint = ordersWrite.build({
  method: "patch",
  input: z.object({
    orderId: z.string(),
    orderItemId: z.string(),
    quantity: z.number().positive().optional(),
    unitPrice: z.number().nonnegative().optional(),
  }),
  output: orderItemSchema,
  handler: async ({ input, ctx: { orders } }) => {
    const { orderItemId, ...data } = input;
    return orders.updateOrderItem(orderItemId, data);
  },
});

export const removeOrderItemEndpoint = ordersWrite.build({
  method: "delete",
  input: z.object({ orderId: z.string(), orderItemId: z.string() }),
  output: z.object({ success: z.boolean() }),
  handler: async ({ input, ctx: { orders } }) => {
    await orders.removeOrderItem(input.orderItemId);
    return { success: true };
  },
});

const orderPaymentInputSchema = z.object({
  date: ez.dateIn(),
  amount: z.number().positive(),
  currency: z.string().default("CHF"),
  method: paymentMethodSchema,
  notes: z.string().optional(),
});

export const createOrderPaymentEndpoint = ordersWrite.build({
  method: "post",
  input: orderPaymentInputSchema.extend({ orderId: z.string() }),
  output: paymentSchema,
  handler: async ({ input, ctx: { orders, payments } }) => {
    const order = await orders.getOrderById(input.orderId);
    if (!order) throw createHttpError(404, "Order not found");
    const { orderId, ...paymentData } = input;
    return payments.createPayment({ ...paymentData, orderId, contactId: order.contactId, sponsorshipId: null });
  },
});

export const getOrderPaymentEndpoint = ordersRead.build({
  method: "get",
  input: z.object({ orderId: z.string(), paymentId: z.string() }),
  output: paymentSchema,
  handler: async ({ input, ctx: { payments } }) => {
    const payment = await payments.getPaymentById(input.paymentId);
    if (!payment || payment.orderId !== input.orderId) throw createHttpError(404, "Payment not found");
    return payment;
  },
});

export const updateOrderPaymentEndpoint = ordersWrite.build({
  method: "patch",
  input: orderPaymentInputSchema.partial().extend({ orderId: z.string(), paymentId: z.string() }),
  output: paymentSchema,
  handler: async ({ input, ctx: { payments } }) => {
    const { paymentId, orderId: _orderId, ...data } = input;
    return payments.updatePayment(paymentId, data);
  },
});

export const deleteOrderPaymentEndpoint = ordersWrite.build({
  method: "delete",
  input: z.object({ orderId: z.string(), paymentId: z.string() }),
  output: z.object({}),
  handler: async ({ input, ctx: { payments } }) => {
    await payments.deletePayment(input.paymentId);
    return {};
  },
});

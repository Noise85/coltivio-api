import { eq } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { orders, orderItems, farmIdColumnValue } from "../db/schema";
import { Contact } from "../contacts/contacts";
import { Payment } from "../payments/payments";
import { Product } from "../products/products";

export type OrderCreateInput = Omit<typeof orders.$inferInsert, "id" | "farmId" | "status"> & {
  status?: "pending" | "confirmed";
};
export type OrderUpdateInput = {
  notes?: string | null;
  shippingDate?: Date | null;
};
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;

export type OrderItemInput = {
  productId: string;
  quantity: number;
  unitPrice?: number; // overrides the product's pricePerUnit when provided
};

export type OrderItemWithProduct = OrderItem & {
  product: Product;
};

export type OrderWithRelations = Order & {
  contact: Contact;
  items: OrderItemWithProduct[];
  payments: Payment[];
};

export function ordersApi(rlsDb: RlsDb) {
  return {
    // Creates an order with items and decrements stock from products
    async createOrder(orderInput: OrderCreateInput, items: OrderItemInput[]): Promise<OrderWithRelations> {
      const result = await rlsDb.rls(async (tx) => {
        // First validate all products exist and have sufficient stock
        const productIds = items.map((item) => item.productId);

        const allProducts = await tx.query.products.findMany({
          where: { id: { in: productIds } },
        });

        // Create the order
        const [order] = await tx
          .insert(orders)
          .values({ ...farmIdColumnValue, ...orderInput, status: orderInput.status ?? "pending" })
          .returning({ id: orders.id });

        // Create order items and decrement stock
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const product = allProducts.find((product) => product.id === item.productId);
          if (!product) {
            throw new Error(`Product not found: ${item.productId}`);
          }

          // Create order item with price snapshot — caller can override the default product price
          await tx.insert(orderItems).values({
            ...farmIdColumnValue,
            orderId: order.id,
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice ?? product.pricePerUnit,
          });
        }

        return order;
      });
      const fullOrder = await this.getOrderById(result.id);
      return fullOrder!;
    },

    async getOrderById(id: string): Promise<OrderWithRelations | undefined> {
      return rlsDb.rls(async (tx) => {
        return tx.query.orders.findFirst({
          where: { id },
          with: {
            contact: true,
            items: {
              with: {
                product: true,
              },
            },
            payments: true,
          },
        });
      });
    },

    async getOrdersForFarm(
      farmId: string
    ): Promise<Array<Order & { contact: Contact; items: OrderItemWithProduct[]; payments: Payment[] }>> {
      return rlsDb.rls(async (tx) => {
        return tx.query.orders.findMany({
          where: { farmId },
          with: {
            contact: true,
            items: {
              with: {
                product: true,
              },
            },
            payments: true,
          },
        });
      });
    },

    async getOrdersForContact(contactId: string): Promise<Array<Order>> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(orders).where(eq(orders.contactId, contactId));
      });
    },

    async getOrderItems(orderId: string): Promise<OrderItem[]> {
      return rlsDb.rls(async (tx) => {
        return tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      });
    },

    async confirmOrder(id: string): Promise<Order> {
      return rlsDb.rls(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, id));
        if (!order) {
          throw new Error(`Order not found: ${id}`);
        }
        if (order.status !== "pending") {
          throw new Error(`Cannot confirm order with status "${order.status}". Only pending orders can be confirmed.`);
        }
        const [updated] = await tx.update(orders).set({ status: "confirmed" }).where(eq(orders.id, id)).returning();
        return updated;
      });
    },

    async fulfillOrder(id: string): Promise<Order> {
      return rlsDb.rls(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, id));
        if (!order) {
          throw new Error(`Order not found: ${id}`);
        }
        if (order.status !== "confirmed") {
          throw new Error(
            `Cannot fulfill order with status "${order.status}". Only confirmed orders can be fulfilled.`
          );
        }
        const [updated] = await tx.update(orders).set({ status: "fulfilled" }).where(eq(orders.id, id)).returning();
        return updated;
      });
    },

    // Cancels order and restores stock to products
    async cancelOrder(id: string): Promise<Order> {
      return rlsDb.rls(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, id));
        if (!order) {
          throw new Error(`Order not found: ${id}`);
        }
        if (order.status === "cancelled") {
          throw new Error("Order is already cancelled");
        }
        if (order.status === "fulfilled") {
          throw new Error("Cannot cancel a fulfilled order");
        }

        // Update order status
        const [updated] = await tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, id));
        return updated;
      });
    },

    async updateOrderNotes(id: string, data: OrderUpdateInput): Promise<Order> {
      return rlsDb.rls(async (tx) => {
        const [updated] = await tx.update(orders).set(data).where(eq(orders.id, id)).returning();
        return updated;
      });
    },

    async addOrderItem(orderId: string, item: OrderItemInput): Promise<OrderItemWithProduct> {
      return rlsDb.rls(async (tx) => {
        const product = await tx.query.products.findFirst({
          where: { id: item.productId },
        });
        if (!product) {
          throw new Error(`Product not found: ${item.productId}`);
        }

        const [inserted] = await tx
          .insert(orderItems)
          .values({
            ...farmIdColumnValue,
            orderId,
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice ?? product.pricePerUnit,
          })
          .returning();

        return { ...inserted, product };
      });
    },

    async updateOrderItem(orderItemId: string, data: { quantity?: number; unitPrice?: number }): Promise<OrderItem> {
      return rlsDb.rls(async (tx) => {
        const [updated] = await tx.update(orderItems).set(data).where(eq(orderItems.id, orderItemId)).returning();
        if (!updated) {
          throw new Error(`Order item not found: ${orderItemId}`);
        }
        return updated;
      });
    },

    async removeOrderItem(orderItemId: string): Promise<void> {
      await rlsDb.rls(async (tx) => {
        await tx.delete(orderItems).where(eq(orderItems.id, orderItemId));
      });
    },
  };
}

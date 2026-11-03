import { DataSource, In } from 'typeorm';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { OrderStatus } from '../../orders/entities/order-status.enum';
import { Order } from '../../orders/entities/order.entity';
import { ProductVariant } from '../../products/entities/product-variant.entity';
import { getSeededVariantStock } from './demo-seed';
import {
  assertSafeDemoSeedDatabase,
  type DemoSeedTarget,
  type ProductionDemoApproval,
} from './demo-seed-safety';

export interface RestockOptions {
  target: DemoSeedTarget;
  nodeEnvironment?: string;
  productionApproval?: ProductionDemoApproval;
  // Work everything out, change nothing.
  dryRun?: boolean;
}

export interface RestockChange {
  sku: string;
  before: number;
  after: number;
  // Units held by pending orders, left out of the restocked quantity.
  reserved: number;
}

export interface RestockSummary {
  dryRun: boolean;
  seededVariants: number;
  changed: number;
  stockBefore: number;
  stockAfter: number;
  reservedByPendingOrders: number;
  changes: RestockChange[];
}

// Brings the stock of the variants the demo seed owns back up to the quantities
// it seeds them with. Demo orders really take stock, so a busy public demo runs
// out of the popular sizes; this is the safe way to refill it.
//
// - Raises only: stock that is already at or above the seeded quantity is left
//   alone, so nothing an admin added is ever lowered.
// - A unit held by a PENDING order is not given back: that order can still
//   expire or be cancelled, which returns the unit, and refilling it too would
//   end above the seeded quantity. Confirmed and later orders have sold theirs.
// - Touches only `stock` of the seeded variants (found by SKU): no row is
//   created or deleted, and orders, items and payments are only read.
// - Variants are locked in ascending id, the order checkout and cancellation
//   use, and everything happens in one transaction.
export async function restockDemoVariants(
  dataSource: DataSource,
  options: RestockOptions,
): Promise<RestockSummary> {
  assertSafeDemoSeedDatabase(
    dataSource,
    options.target,
    options.nodeEnvironment,
    options.productionApproval,
  );
  const dryRun = options.dryRun ?? false;
  const seeded = new Map(
    getSeededVariantStock().map(({ sku, stock }) => [sku, stock]),
  );

  return dataSource.transaction(async (manager) => {
    const variants = await manager.getRepository(ProductVariant).find({
      where: { sku: In([...seeded.keys()]) },
      order: { id: 'ASC' },
      ...(dryRun ? {} : { lock: { mode: 'pessimistic_write' as const } }),
    });

    const reservedRows: Array<{ variantId: number; reserved: string }> =
      variants.length === 0
        ? []
        : await manager
            .getRepository(OrderItem)
            .createQueryBuilder('item')
            .innerJoin(Order, 'o', 'o.id = item.orderId')
            .select('item.variantId', 'variantId')
            .addSelect('SUM(item.quantity)', 'reserved')
            .where('o.status = :status', { status: OrderStatus.PENDING })
            .andWhere('item.variantId IN (:...ids)', {
              ids: variants.map((variant) => variant.id),
            })
            .groupBy('item.variantId')
            .getRawMany();
    const reservedByVariant = new Map(
      reservedRows.map((row) => [row.variantId, Number(row.reserved)]),
    );

    const changes: RestockChange[] = [];
    let stockBefore = 0;
    let stockAfter = 0;
    let reservedTotal = 0;
    for (const variant of variants) {
      const reserved = reservedByVariant.get(variant.id) ?? 0;
      reservedTotal += reserved;
      const wanted = Math.max(0, seeded.get(variant.sku)! - reserved);
      const after = Math.max(variant.stock, wanted);
      stockBefore += variant.stock;
      stockAfter += after;
      if (after === variant.stock) continue;

      changes.push({
        sku: variant.sku,
        before: variant.stock,
        after,
        reserved,
      });
      if (!dryRun) {
        await manager.update(
          ProductVariant,
          { id: variant.id },
          { stock: after },
        );
      }
    }

    return {
      dryRun,
      seededVariants: variants.length,
      changed: changes.length,
      stockBefore,
      stockAfter,
      reservedByPendingOrders: reservedTotal,
      changes,
    };
  });
}

export function parseRestockArguments(args: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const argument of args) {
    if (argument === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(
        `Unknown argument "${argument}". Only --dry-run is accepted.`,
      );
    }
  }
  return { dryRun };
}

export function resolveRestockTarget(
  nodeEnvironment: string | undefined,
): DemoSeedTarget {
  if (nodeEnvironment === 'production') return 'production';
  if (nodeEnvironment === 'test') return 'test';
  if (nodeEnvironment === undefined || nodeEnvironment === 'development') {
    return 'development';
  }
  throw new Error(
    `NODE_ENV must be development, test or production, not "${nodeEnvironment}"`,
  );
}

export function formatRestockSummary(summary: RestockSummary): string[] {
  const lines = [
    summary.dryRun
      ? 'Demo restock (dry run): nothing was changed.'
      : 'Demo restock completed.',
    `Seeded variants found: ${summary.seededVariants}`,
    `Variants raised: ${summary.changed} of ${summary.seededVariants}`,
    `Units held by pending orders (not refilled): ${summary.reservedByPendingOrders}`,
    `Total stock before: ${summary.stockBefore}`,
    `Total stock after: ${summary.stockAfter}`,
  ];
  for (const change of summary.changes) {
    lines.push(
      `  ${change.sku}: ${change.before} -> ${change.after}${
        change.reserved > 0
          ? ` (${change.reserved} held by pending orders)`
          : ''
      }`,
    );
  }
  return lines;
}

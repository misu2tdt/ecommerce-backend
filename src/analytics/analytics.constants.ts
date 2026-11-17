import { OrderStatus } from '../orders/entities/order-status.enum';

// An order counts as revenue once it has been paid: confirmed (only a successful
// payment confirms an order), processing, shipped and delivered. Pending orders
// are not paid yet and cancelled orders never will be, so both are left out.
export const REVENUE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

// The order lifecycle, for the status breakdown (every status is always listed).
export const ORDER_STATUS_SEQUENCE: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
];

export const ANALYTICS_CURRENCY = 'VND';
export const DEFAULT_ANALYTICS_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;
export const TOP_LIMIT_DEFAULT = 10;
export const TOP_LIMIT_MAX = 50;

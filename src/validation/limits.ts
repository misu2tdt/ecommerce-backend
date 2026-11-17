// Upper bounds for numbers that clients send. Without them a huge value, such as
// 99999999999 for an id or a quantity, reaches PostgreSQL, which refuses it with
// "out of range for type integer" and the API answers 500. With them the API
// answers 400 and says which field is wrong.

// The largest value of a PostgreSQL integer column, and so of every id.
export const INT_MAX = 2_147_483_647;

// Units of one product variant in one cart line or one order line.
export const MAX_QUANTITY_PER_LINE = 99;

// Different lines in one cart or one order.
export const MAX_LINES = 50;

// Units in stock, as an admin sets them.
export const MAX_STOCK = 1_000_000;

// Display position of an image or a variant.
export const MAX_POSITION = 10_000;

// The most a price, a coupon amount or a coupon minimum may be in a form, in VND
// (a trillion). With the limits above, the biggest order total is
// 1e12 x 99 x 50 = 4.95e15, still below the largest safe integer (about 9.007e15),
// so an order total can never overflow.
export const MAX_PRICE_VND = 1_000_000_000_000;

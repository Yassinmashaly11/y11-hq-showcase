import { BIG_SIZES, BusinessSettings } from './settings.js';

// Pure pricing logic: no database, so it is easy to test.

export interface PricingLine {
  size: string;
  quantity: number;
  typePrice: number;   // product_types.price
  typeCost: number;    // product_types.cost
  nameNumber: boolean;
  patch: boolean;
}

export interface PricedLine extends PricingLine {
  unitPrice: number;
  unitCost: number;
}

export interface SaleTotals {
  lines: PricedLine[];
  jerseyCount: number;
  squadDeal: boolean;
  whatsappDiscount: number; // taken off the order when the customer ordered on WhatsApp
  revenue: number;   // excludes shipping, after the WhatsApp discount
  cost: number;
  profit: number;
  shipping: number;  // charged to the customer and paid to the supplier, so profit-neutral
}

// Round to cents so 0.1 + 0.2 style errors never reach the database.
export const cents = (n: number) => Math.round(n * 100) / 100;

export function shippingFor(jerseys: number, s: BusinessSettings): number {
  if (jerseys <= 0) return 0;
  if (jerseys >= s.shipping.freeFrom) return 0;
  return jerseys === 1 ? s.shipping.one : s.shipping.two;
}

export function priceSale(lines: PricingLine[], s: BusinessSettings, opts: { chargeShipping: boolean; whatsapp?: boolean }): SaleTotals {
  const jerseyCount = lines.reduce((n, l) => n + l.quantity, 0);
  // Squad Deal: 4+ jerseys in one order = name & number free (you still pay the supplier for it)
  const squadDeal = jerseyCount >= s.squadDealMin;
  const e = s.extras;

  const priced = lines.map((l): PricedLine => {
    const big = BIG_SIZES.includes(l.size.toUpperCase());
    const unitPrice =
      l.typePrice +
      (l.nameNumber && !squadDeal ? e.nameNumberPrice : 0) +
      (l.patch ? e.patchPrice : 0) +
      (big ? e.bigSizePrice : 0);
    const unitCost =
      l.typeCost +
      (l.nameNumber ? e.nameNumberCost : 0) +
      (l.patch ? e.patchCost : 0) +
      (big ? e.bigSizeCost : 0);
    return { ...l, unitPrice: cents(unitPrice), unitCost: cents(unitCost) };
  });

  const full = cents(priced.reduce((n, l) => n + l.unitPrice * l.quantity, 0));
  // WhatsApp orders: a fixed amount off every jersey, on top of the Squad Deal. Your cost doesn't change.
  const whatsappDiscount = opts.whatsapp ? Math.min(full, cents(s.whatsappDiscount * jerseyCount)) : 0;
  const revenue = cents(full - whatsappDiscount);
  const cost = cents(priced.reduce((n, l) => n + l.unitCost * l.quantity, 0));
  return {
    lines: priced,
    jerseyCount,
    squadDeal,
    whatsappDiscount,
    revenue,
    cost,
    profit: cents(revenue - cost),
    shipping: opts.chargeShipping ? shippingFor(jerseyCount, s) : 0,
  };
}

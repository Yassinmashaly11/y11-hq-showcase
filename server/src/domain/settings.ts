// Business rules the CEO can change in Settings. These are the defaults for a new database
// (the costs are made-up starting values; your real ones are saved in your database's Settings).
export interface BusinessSettings {
  setSize: number;                 // jerseys per commission payment
  commissionPerSet: [number, number, number]; // Level 1, 2, 3
  levelTargets: { level2: number; level3: number }; // jerseys in one period
  periodMonths: number;            // how often everyone drops a level
  warningMonths: number;           // extra time a warned Level 1 gets
  inHandDays: number;              // when in-hand jerseys are due back
  squadDealMin: number;            // jerseys for free name & number
  extras: {
    nameNumberPrice: number; nameNumberCost: number;
    patchPrice: number; patchCost: number;
    bigSizePrice: number; bigSizeCost: number; // 2XL / 3XL
  };
  shipping: { one: number; two: number; freeFrom: number }; // order total, passed to supplier
  whatsappDiscount: number;        // off each jersey when the customer orders on WhatsApp
  lowStockAt: number;
  // One-time bonuses for jerseys sold in a single 2-month period. They stack.
  milestones: { jerseys: number; bonus: number }[];
  shiftMaxHours: number;           // shifts end automatically after this
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  setSize: 3,
  commissionPerSet: [24, 30, 36],
  levelTargets: { level2: 15, level3: 30 },
  periodMonths: 2,
  warningMonths: 1,
  inHandDays: 30,
  squadDealMin: 4,
  extras: {
    nameNumberPrice: 10, nameNumberCost: 3,
    patchPrice: 5, patchCost: 2,
    bigSizePrice: 5, bigSizeCost: 2,
  },
  shipping: { one: 8, two: 6, freeFrom: 3 },
  whatsappDiscount: 5,
  lowStockAt: 1,
  milestones: [
    { jerseys: 45, bonus: 25 },
    { jerseys: 60, bonus: 50 },
    { jerseys: 80, bonus: 100 },
  ],
  shiftMaxHours: 10,
};

export const BIG_SIZES = ['2XL', '3XL'];

export function mergeSettings(stored: Partial<BusinessSettings> | null | undefined): BusinessSettings {
  const s = stored ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    levelTargets: { ...DEFAULT_SETTINGS.levelTargets, ...(s.levelTargets ?? {}) },
    extras: { ...DEFAULT_SETTINGS.extras, ...(s.extras ?? {}) },
    shipping: { ...DEFAULT_SETTINGS.shipping, ...(s.shipping ?? {}) },
    milestones: [...(s.milestones ?? DEFAULT_SETTINGS.milestones)].sort((a, b) => a.jerseys - b.jerseys),
  };
}

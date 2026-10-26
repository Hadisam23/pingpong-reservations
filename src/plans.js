// Membership plans. These defaults are written to the membership_plans table by the
// migrations; after that the database is the source of truth (admin editing comes in Phase 7).
// Prices are placeholders: replace them with the club's real prices.
const DEFAULT_PLANS = [
  {
    id: 'dropin',
    name: 'Drop-in',
    priceMonthly: 0,
    tableDiscountPct: 0,
    bookingWindowDays: 3,
    monthlyTableCredits: 0,
    includedLessonsPerMonth: 0,
    summary: 'Standard table rates · book up to 3 days ahead',
    perks: [],
  },
  {
    id: 'club',
    name: 'Club',
    priceMonthly: 149,
    tableDiscountPct: 20,
    bookingWindowDays: 14,
    monthlyTableCredits: 4,
    includedLessonsPerMonth: 0,
    popular: true,
    summary: 'Member price on every table · book up to 14 days ahead',
    perks: ['Member price on every table', 'Book up to 14 days ahead', 'Join open play & leagues', 'Discount on lesson packages'],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 299,
    tableDiscountPct: 30,
    bookingWindowDays: 30,
    monthlyTableCredits: 0,
    includedLessonsPerMonth: 1,
    offPeakTablesFree: true,
    summary: 'Everything in Club · unlimited off-peak tables · 1 private lesson a month · book 30 days ahead',
    perks: [],
  },
];

function rowToPlan(row) {
  return {
    id: row.id,
    name: row.name,
    price: row.priceMonthly,
    tableDiscountPct: row.tableDiscountPct,
    bookingWindowDays: row.bookingWindowDays,
    monthlyTableCredits: row.monthlyTableCredits,
    includedLessonsPerMonth: row.includedLessonsPerMonth,
    offPeakTablesFree: !!row.offPeakTablesFree,
    summary: row.summary,
    perks: JSON.parse(row.perks),
    popular: !!row.popular,
  };
}

const listPlans = db => db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY sortOrder').all().map(rowToPlan);
const findPlan = (db, id) => {
  const row = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(id);
  return row ? rowToPlan(row) : null;
};

module.exports = { DEFAULT_PLANS, listPlans, findPlan };

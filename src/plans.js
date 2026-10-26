// Membership plans shown during onboarding. Phase 3 moves these into the database and
// Phase 6 connects paid plans to Stripe; until then a paid choice is saved as "pending".
// Prices are placeholders: replace them with the club's real prices.
const PLANS = [
  {
    id: 'dropin',
    name: 'Drop-in',
    price: 0,
    bookingWindowDays: 3,
    summary: 'Standard table rates · book up to 3 days ahead',
    perks: [],
  },
  {
    id: 'club',
    name: 'Club',
    price: 149,
    bookingWindowDays: 14,
    popular: true,
    summary: 'Member price on every table · book up to 14 days ahead',
    perks: ['Member price on every table', 'Book up to 14 days ahead', 'Join open play & leagues', 'Discount on lesson packages'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 299,
    bookingWindowDays: 30,
    summary: 'Everything in Club · unlimited off-peak tables · 1 private lesson a month · book 30 days ahead',
    perks: [],
  },
];

const findPlan = id => PLANS.find(p => p.id === id) || null;

module.exports = { PLANS, findPlan };

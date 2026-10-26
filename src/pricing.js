// Table prices: price rule for the duration (peak or off-peak) − plan discount − promo code.
// Pro members play off-peak for free (paid by the membership).
const { ApiError } = require('./service');
const { parseHHMM, weekday } = require('./time');

const round2 = n => Math.round(n * 100) / 100;

// Starting prices (placeholders): per duration, Sun–Thu peak from 17:00, Fri–Sat at the peak rate all day.
const DEFAULT_PRICE_RULES = [30, 60, 90].flatMap(duration => [
  { durationMin: duration, basePrice: duration * 40 / 60, peakPrice: duration * 60 / 60, peakStart: '17:00', peakEnd: '24:00', daysOfWeek: [0, 1, 2, 3, 4] },
  { durationMin: duration, basePrice: duration * 60 / 60, peakPrice: duration * 60 / 60, peakStart: '00:00', peakEnd: '24:00', daysOfWeek: [5, 6] },
]);

function createPricing(db, service) {
  const stmts = {
    rules: db.prepare('SELECT * FROM price_rules WHERE durationMin = ?'),
    durations: db.prepare('SELECT DISTINCT durationMin AS d FROM price_rules ORDER BY d'),
    promo: db.prepare('SELECT * FROM promo_codes WHERE code = ?'),
  };

  // The durations people can book online: the ones with a price rule.
  function durations() {
    const list = stmts.durations.all().map(r => r.d);
    return list.length ? list : [30, 60, 90];
  }

  function ruleFor(date, duration) {
    const dow = weekday(date);
    return stmts.rules.all(duration).find(r => JSON.parse(r.daysOfWeek).includes(dow)) || null;
  }

  function isPeak(rule, startMin) {
    if (!rule || !rule.peakStart) return false;
    const from = parseHHMM(rule.peakStart);
    const to = rule.peakEnd ? parseHHMM(rule.peakEnd) : 1440;
    return startMin >= from && startMin < to;
  }

  // plan: { id, name, tableDiscountPct, offPeakTablesFree } of an ACTIVE membership, or null
  function quote({ date, startMin, duration, plan }) {
    const rule = ruleFor(date, duration);
    let peak;
    let base;
    if (rule) {
      peak = isPeak(rule, startMin);
      base = peak ? rule.peakPrice : rule.basePrice;
    } else {
      // No rule for this day/duration: fall back to the hourly rates in settings
      const settings = service.getSettings();
      peak = settings.pricing.peakDays.includes(weekday(date))
        || (settings.pricing.peakStart !== null && startMin >= parseHHMM(settings.pricing.peakStart));
      base = service.quote(date, startMin, startMin + duration, 'casual');
    }
    base = round2(base);
    const free = !!(plan && plan.offPeakTablesFree && !peak);
    const memberDiscount = free ? base : round2(base * ((plan && plan.tableDiscountPct) || 0) / 100);
    return {
      base,
      peak,
      free,
      memberDiscount,
      memberLabel: plan && memberDiscount ? (free ? `${plan.name}: off-peak tables included` : `${plan.name} member discount`) : null,
      subtotal: round2(base - memberDiscount),
    };
  }

  // Checks a promo code and returns what it takes off `amount`.
  function promo(code, amount, now = new Date()) {
    const clean = String(code ?? '').trim().toUpperCase();
    if (!clean) return null;
    const row = stmts.promo.get(clean);
    const iso = now.toISOString();
    if (!row || iso < row.validFrom || iso > row.validTo) {
      throw new ApiError(400, 'invalid_promo', "That promo code isn't valid.", { field: 'promo' });
    }
    if (row.maxUses !== null && row.uses >= row.maxUses) {
      throw new ApiError(400, 'invalid_promo', 'That promo code has been used up.', { field: 'promo' });
    }
    const off = row.percentOff ? amount * row.percentOff / 100 : (row.amountOff || 0);
    return { code: clean, discount: round2(Math.min(amount, off)), label: row.percentOff ? `${row.percentOff}% off` : null };
  }

  const usePromo = code => db.prepare('UPDATE promo_codes SET uses = uses + 1 WHERE code = ?').run(code);

  return { durations, quote, promo, usePromo, isPeak, ruleFor };
}

module.exports = { createPricing, round2, DEFAULT_PRICE_RULES };

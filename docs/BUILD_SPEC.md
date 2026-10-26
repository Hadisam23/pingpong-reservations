# Build prompt: Rally Club — table tennis booking app

> Paste this whole file into Claude Code (or save it in the repo as `docs/BUILD_SPEC.md` and tell Claude Code: "Read docs/BUILD_SPEC.md and build it phase by phase").
> "Rally Club" and anything in [BRACKETS] are placeholders — replace them with your club's real name, prices and details.

---

## 0. Your role and how to work

You are building a complete, working table tennis club app where players can:
1. **Create an account** and pick a **membership**
2. **Reserve a table** (date → duration → time → table area → pay → QR check-in pass)
3. **Book a lesson** (private lesson with a coach, or join a group class / open play)
4. **Manage everything** (upcoming/past bookings, cancel/reschedule, credits, lesson packs, membership)

Plus an **admin/staff panel** so the club can run it (tables, coaches, schedules, prices, check-in).

How to work:
- First inspect the existing repo. If there's already an app, **keep its stack** and build on it. Tell me what you found and your plan before large changes.
- If starting from scratch, use: **Next.js (App Router) + TypeScript + Tailwind + Prisma + PostgreSQL + Auth.js + Stripe (test mode)**, built mobile-first as a PWA. (If I say I want native mobile, use **Expo + React Native** with the same backend.)
- Work in the phases in section 9. After each phase: run it, test it, fix what's broken, then summarize what works.
- Never hardcode secrets. Use `.env` and give me a `.env.example`.
- Seed the database with realistic demo data so every screen has something to show.

---

## 1. Design system (navy + white, ping-pong orange accent)

Put all of these in ONE place (Tailwind config / theme file / CSS variables) and use them everywhere. No random hex values in components.

### Colors
| Token | Value | Use |
|---|---|---|
| `navy-900` | `#0B1F3A` | Primary: buttons, headers, selected states, hero cards |
| `navy-700` | `#13305C` | Hover on navy |
| `navy-500` | `#1E3A8A` | Focus rings, links on hover |
| `white` | `#FFFFFF` | Cards, text on navy |
| `bg` | `#F4F6FA` | App background |
| `surface-2` | `#EEF2F8` | Subtle fills, segmented control track `#E6EBF2` |
| `border` | `#E2E8F0` | Card and input borders |
| `text` | `#0B1F3A` | Primary text |
| `text-muted` | `#5B6B82` | Secondary text (passes AA on white) |
| `text-on-navy-muted` | `#C7D2E3` | Secondary text on navy |
| `accent` | `#F97316` | The "ball" — badges, peak dots, success icon, one CTA highlight. **Fill only, never as text on white** (fails contrast). Put navy text on it. |
| `accent-text` | `#C2410C` | When orange text is needed on white |
| `accent-soft` | `#FFEDD5` / `#FFF7ED` | Orange tinted badges / callouts |
| `success` | `#15803D` | Discounts, confirmed |
| `danger` | `#B91C1C` | Cancel, log out, errors (border `#FECACA`) |

### Type
- Font: **Plus Jakarta Sans** (400/500/600/700/800).
- Scale: Display 40/800 · H1 28/800 · H2 22/800 · Section 17/800 · Body 15/500 · Small 13/500 · Caption 11–12/600.
- Headings use `letter-spacing: -0.02em`. Big numbers (times, scores, credits) are bold 800 — they're the heroes.

### Shape, spacing, depth
- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 48. Screen side padding: 20px.
- Radius: inputs/small buttons 12px · cards 18px · hero cards 22–24px · pills 999px.
- Shadows: navy primary button `0 8px 20px rgba(11,31,58,.25)`; hero card `0 14px 30px rgba(11,31,58,.25)`; bottom bars `0 -8px 24px rgba(11,31,58,.06)`.
- Decorative motif: a thin horizontal "table line" (`1px rgba(255,255,255,.1)`) across navy cards, and a small orange ball dot. Subtle, never cheesy.

### Buttons (build ONE `<Button>` component and use it everywhere)
- Variants:
  - **primary** — navy fill, white text, shadow
  - **inverse** — white fill, navy text (used on navy backgrounds)
  - **secondary** — white fill, 1.5px `border` color, navy text
  - **outline-on-navy** — transparent, 1.5px `rgba(255,255,255,.35)` border, white text
  - **ghost** — no border, navy text, underline on hover
  - **danger** — white fill, red border, red text
  - **accent** — orange fill, navy text (use at most once per screen)
- Sizes: sm 40px · md 48px · lg 56px tall. Min tap target 44px.
- States (all required): hover (navy → `navy-700`), pressed (`scale(.98)`), **visible focus ring** (`0 0 0 4px rgba(30,58,138,.25)`), disabled (40% opacity, no pointer), **loading** (spinner, keeps width, disabled).
- Optional leading/trailing icon. Transition 150ms.

### Other components to build
- **Chip / SlotButton** — states: available (white, border), selected (navy, white text), full (dashed border, grey fill, line-through, disabled), peak (small orange dot top-right).
- **DateStrip** — 7 day tiles (weekday small, date big); selected = navy.
- **SegmentedControl** — grey track, white raised selected segment.
- **Card**, **HeroCard (navy)**, **Badge** (table = navy-tint, lesson = orange-tint), **Input** with label + focus + error state, **Toggle**, **RadioCard**, **BottomActionBar** (summary on left, primary CTA on right), **TabBar** (5 tabs: Home, Tables, Lessons, Bookings, Profile; active = navy + bold, inactive = `text-muted`), **EmptyState**, **Skeleton loaders**, **Toast**.
- Icons: one stroke icon set (e.g. lucide), 2px stroke. **No emoji in the UI.**

---

## 2. Screens (match the design canvas)

### Player app
1. **Welcome** — full navy, logo, headline "Book a table. Book a coach. Play more.", buttons: Create account (inverse), I already have an account (outline-on-navy), "Book as a guest" link.
2. **Create account (step 1/3)** — progress bar, full name, email, phone, password (8+), skill level chips (Beginner/Intermediate/Advanced), agree-to-terms checkbox, Continue; Google / Apple sign-in buttons.
3. **Choose membership (step 2/3)** — radio cards: Drop-in (free), **Club** (badge "Most popular", navy selected card with benefits list), Pro. "Continue with [plan]" + "Skip for now". Paid plans → Stripe subscription checkout. (Step 3 = payment, or skipped for Drop-in.)
4. **Home** — greeting + membership pill + notification bell; **Next up** navy hero card (time big, table, players, Check-in pass + Manage buttons); quick actions grid (Book a table, Book a lesson, Open play, Membership); "Free tables today" time chips; tab bar.
5. **Book a table** — club/area subtitle, DateStrip (limited by membership booking window), Duration segmented (30/60/90), Start time grid (available/selected/full/peak legend), Table area radio (Main hall auto-assign / Private room), **BottomActionBar** showing live summary "Tue 27 · 18:00–19:00" + price + Continue.
6. **Checkout** — booking summary with Edit; Players (avatars, add player, **Split the cost** toggle); payment method (saved card / use table credit); promo code; price breakdown (base, member discount, your share); cancellation policy line; sticky "Pay [TOTAL] & confirm".
7. **Booking confirmed** — navy screen, orange check, "You're booked!", ticket card (date, time, where, booking #) with dashed tear line and **QR check-in code**; Add to calendar (.ics), Invite friends (share link), Done.
8. **My bookings** — Upcoming / Past tabs; credit counters (table credits, lesson pack); booking cards with type badge; Upcoming → Reschedule / Cancel; Past → Book again.
9. **Lessons** — Private lessons / Group classes tabs; level filter chips; coach cards (avatar, name, specialties, "Next free: …"); group class cards with capacity bar, "X spots left", **Join** or **Join waitlist** when full.
10. **Coach detail / book lesson** — navy header (avatar, name, certification, specialty chips); lesson type radio cards (Private 60, Semi-private 60, Video analysis 45); lesson-pack upsell callout; available slots for a day + "See other days"; sticky "Book Thu · 19:00" → Checkout (same checkout, lesson variant).
11. **Profile & membership** — avatar + name + level + Edit; navy membership card (plan, renewal, sessions this month, credits, booking window, Upgrade / Manage); settings list (Lesson packages, Payment methods, Family & guests, Notifications, Club rules, Help); Log out.

Also needed (not drawn, follow the same style): Log in, Forgot password, Notifications list, Edit profile, Manage membership (change plan / cancel at period end), Lesson packages purchase, Open play sign-up, Guest booking checkout (email + phone only).

### Admin / staff panel (desktop-first web, same design tokens)
- **Day calendar** — rows = tables, columns = time; blocks colored by type (booking / lesson / class / maintenance). Drag to create a block or maintenance hold.
- **Bookings** — search, filter, cancel/refund, mark no-show.
- **Check-in** — camera QR scanner + manual search; marks attendance.
- **Coaches** — profile, specialties, weekly availability, lesson types they offer, time off.
- **Classes & open play** — create recurring sessions with capacity, level, coach.
- **Pricing & plans** — base table prices per duration, peak hours, member discounts, plan definitions, booking windows, lesson pack sizes.
- **Members** — list, plan, credits, history; adjust credits manually.
- **Club settings** — opening hours, tables & areas, cancellation window, holiday closures.
- **Reports** — utilization by hour, revenue, no-show rate, active members.

---

## 3. Data model (Prisma-style, adapt to the stack)

- `User` — id, name, email (unique), phone, passwordHash?, role (`PLAYER | COACH | ADMIN`), skillLevel, stripeCustomerId, createdAt
- `MembershipPlan` — id, name, priceMonthly, tableDiscountPct, bookingWindowDays, monthlyTableCredits, includedLessonsPerMonth, perks[], stripePriceId, active
- `Membership` — id, userId, planId, status (`ACTIVE | PAST_DUE | CANCELED`), currentPeriodEnd, cancelAtPeriodEnd, stripeSubscriptionId
- `Area` — id, name ("Main hall", "Private room")
- `Table` — id, areaId, number, active
- `PriceRule` — id, durationMin, basePrice, peakPrice, peakStart, peakEnd, daysOfWeek
- `Coach` — id, userId, bio, certification, yearsCoaching, specialties[], photoUrl
- `CoachAvailability` — coachId, dayOfWeek, startTime, endTime (+ `CoachTimeOff` with date ranges)
- `LessonType` — id, name, durationMin, maxStudents, price
- `ClassSession` — id, title, level, coachId, tableIds[], startsAt, endsAt, capacity, price, recurrenceRule?
- `Booking` — id, userId, kind (`TABLE | LESSON | CLASS`), status (`HOLD | CONFIRMED | CANCELED | CHECKED_IN | NO_SHOW`), startsAt, endsAt, tableId?, coachId?, lessonTypeId?, classSessionId?, holdExpiresAt?, totalPrice, paymentMethod (`CARD | CREDIT | PACK | MEMBERSHIP`), stripePaymentIntentId?, checkInCode, createdAt
- `BookingParticipant` — bookingId, userId? / inviteEmail, shareAmount, paid
- `Waitlist` — classSessionId, userId, position, notifiedAt
- `CreditLedger` — userId, type (`TABLE_CREDIT | LESSON_PACK`), delta, reason, bookingId?, createdAt (balance = sum of deltas — never store a mutable balance only)
- `LessonPack` — id, userId, lessonsTotal, lessonsUsed, expiresAt
- `PromoCode` — code, percentOff / amountOff, validFrom, validTo, maxUses
- `Notification` — userId, type, title, body, readAt

---

## 4. Business rules (must be enforced on the server, not just the UI)

**No double booking — ever.**
- Use a DB-level guarantee: a PostgreSQL exclusion constraint on `(tableId, tstzrange(startsAt, endsAt))` for non-canceled bookings (or a serializable transaction that re-checks overlap). Same for coach time.
- When the user taps Continue on the booking screen, create a `HOLD` booking with `holdExpiresAt = now + 10 min`. Show a countdown on Checkout. Expired holds are released by a scheduled job (and ignored by availability queries).

**Availability**
- Slots come from opening hours, in 30-min steps, minus confirmed/held bookings, class sessions, maintenance blocks, closures.
- "Main hall – auto-assign" picks the lowest-numbered free table for the whole duration; the slot shows "full" only when no table is free for the whole duration.
- A coach slot is available only if the coach is available AND a table is free.
- Booking window: users can only see/book dates within their plan's `bookingWindowDays` (Drop-in 3, Club 14, Pro 30 — configurable). Show later dates disabled with a "Members can book further ahead" hint.

**Pricing**
- Price = PriceRule for duration (peak or off-peak) − plan discount − promo. Pro plan: off-peak tables free (use `MEMBERSHIP` payment).
- Split the cost: organizer pays their share; invited players get a link to pay theirs. If unpaid 2h before start, charge the organizer the rest (show this clearly).
- Table credits / lesson pack credits are spent through `CreditLedger` entries, refunded with a reverse entry.

**Cancellation**
- Free cancellation until 24h before (configurable). Full refund to the original method (card refund via Stripe, or credit back).
- Inside 24h: no refund (admin can override).
- Reschedule = cancel + rebook atomically, same rules.

**Classes**
- Capacity enforced in a transaction. When full → waitlist. When a spot frees up, notify waitlist #1, who has 2h to confirm before it moves to #2.

**Check-in**
- `checkInCode` = signed token (JWT/HMAC) with bookingId, userId, expiry = booking end. Valid from 15 min before start. Scanning marks `CHECKED_IN`. Not checked in 15 min after start → `NO_SHOW` (track it; optional penalty setting).

**Memberships**
- Stripe Subscriptions in test mode. Webhooks update `Membership.status`. Failed payment → `PAST_DUE` → member pricing off until fixed. Cancel = at period end.

---

## 5. Notifications
- Email (and push for PWA if possible): booking confirmed (with .ics), reminder 2h before, cancellation, waitlist spot opened, split-payment request, payment failed, membership renewing.
- In-app notification list with unread dot on the bell.

---

## 6. API / server actions (names are suggestions)
- `GET /availability/tables?date&duration&area`
- `GET /availability/coach/:id?date&lessonType`
- `POST /bookings/hold` → `POST /bookings/:id/confirm` (after payment) → `POST /bookings/:id/cancel` → `POST /bookings/:id/reschedule`
- `POST /classes/:id/join`, `POST /classes/:id/waitlist`
- `POST /checkin/scan`
- `POST /memberships/checkout`, `POST /memberships/cancel`, `POST /stripe/webhook`
- `POST /packs/purchase`, `POST /promo/validate`
- Admin CRUD for everything in section 2's admin panel.
- Validate every input with zod. Every booking mutation runs in a transaction.

---

## 7. Quality bar
- Mobile-first; looks great at 375–430px wide; admin works at 1280px+.
- Every list has a loading skeleton, an empty state and an error state with retry.
- Accessibility: real buttons/links, labels on inputs, focus rings, 4.5:1 text contrast, `aria-label` on icon-only buttons.
- Optimistic UI where safe (toggles), never for payments or bookings.
- Times shown in the club's time zone; store UTC.
- Prices formatted with the club currency from settings.

---

## 8. Tests
- Unit tests: price calculation, availability generation, cancellation window, credit ledger balance.
- Integration tests: two users trying to book the same table/time at once → exactly one succeeds. Class at capacity → waitlist. Hold expiry frees the slot.
- E2E (Playwright): sign up → choose Club → book a table → pay with Stripe test card `4242 4242 4242 4242` → see confirmation + QR → cancel → refund shows.

---

## 9. Build order (do these one by one, test after each)
1. **Foundation** — project setup, design tokens, Button + all base components, a `/styleguide` page showing every component and state.
2. **Auth & onboarding** — Welcome, Sign up (3 steps), Log in, Forgot password, Google sign-in, Profile basics.
3. **Data & seed** — schema, migrations, seed: 6 tables in 2 areas, 3 coaches with availability, 3 plans, price rules, a week of classes, demo users (player / coach / admin).
4. **Table booking** — availability engine, Book a table screen, holds, Checkout, Stripe payment, Confirmation + QR, My bookings, cancel/reschedule.
5. **Lessons & classes** — Lessons list, Coach detail, lesson booking through the same checkout, group classes, waitlist, lesson packs.
6. **Memberships** — plan selection, Stripe subscriptions + webhooks, member pricing, booking windows, credits.
7. **Admin panel** — calendar, check-in scanner, coaches, classes, pricing, members, settings, reports.
8. **Notifications** — emails, reminders, in-app list.
9. **Polish** — loading/empty/error states everywhere, animations (150–200ms), accessibility pass, responsive pass, run all tests, fix everything.

At the end give me: how to run it locally, the demo logins, the test card, and a list of anything still using placeholder content.

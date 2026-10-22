# Ping Pong Center — Reservation System (Build Prompt)

> This is the prompt/spec this project was built from. Hand it to a developer (or an AI coding
> agent) to rebuild, extend, or review the system.

---

## The prompt

Build a **table reservation system for a ping pong center**. Customers book a table online from
their phone in under a minute, without creating an account. Staff at the front desk run the day
from an admin screen: see who's coming, check people in, take walk-ins, block tables, and change
opening hours and prices.

### 1. The business it models

- The center has **N ping pong tables** (start with 6). Tables can be added, renamed, or taken out
  of service.
- It has **opening hours per day of the week** (e.g. Sun–Thu 10:00–23:00, Fri 09:00–16:00,
  Sat 12:00–23:00). Any day can be closed.
- Time is split into **slots** (default 30 min). A booking takes one table for a **duration**
  chosen from a fixed list (30 / 60 / 90 / 120 min) and must start on a slot boundary.
- **Pricing** is per hour with two rates: **off-peak** and **peak**. Peak is weekday evenings from
  a set time (default 17:00) plus whole peak days (default Fri + Sat). The price is calculated
  per slot, so a booking that crosses into peak time is priced correctly.
- Each reservation has a **session type**, each with its own price add-on and optional minimum length:
  casual play, training with the robot (+30/h), private coaching (+120/h), league match, and
  birthday/event (+50/h, minimum 2 h). Staff can edit the list.
- Everything runs in the **center's time zone** (default `Asia/Jerusalem`), not the server's or
  the browser's.

### 2. Booking rules (enforced on the server, never only in the UI)

1. **No double booking.** Two active bookings can never overlap on the same table. The overlap
   check and the insert happen in **one atomic transaction**, so two people tapping "Book" on the
   same slot at the same moment get exactly one success and one clear "just taken" error.
2. A booking must be **inside opening hours**, **aligned to the slot grid**, and use an
   **allowed duration**.
3. No booking **in the past**, and none more than **N days ahead** (default 14).
4. **Blocked time** (maintenance, tournaments, private events) on one table or on all tables can't
   be booked.
5. **Fair use:** at most **N upcoming bookings per phone number** (default 3).
6. **Cancellation:** customers can cancel themselves up to **N minutes before the start**
   (default 120). After that only staff can cancel.
7. Players per table: 1 to the max (default 4).

### 3. Customer experience (mobile-first web page, no login)

- Pick a **date** (chips for the next 14 days), pick a **duration**, then see a **grid of
  times × tables**. Free, taken, and past slots look clearly different, and a start time only
  lights up when the whole chosen duration fits.
- Pick the **session type**. Durations shorter than that type's minimum are disabled.
- Tap a slot → see a summary (table, date, start–end, **price**) → enter **name, phone, number of
  players** → **Book**.
- The confirmation shows a short **booking code** (e.g. `K7QX2M`) and a **private manage link**.
  The browser also remembers the customer's bookings so they can find them again.
- **Manage page:** open it with the private link, or with *booking code + phone number* (for people
  who lost the link). It shows the booking and status, and a **Cancel** button while cancelling is
  still allowed, with the deadline spelled out.
- Every error is readable ("That slot was just taken — pick another"), never a raw status code.

### 4. Staff / admin panel (password protected)

- **Day view:** a times × tables timeline with every booking (name, players, status color) and
  blocked periods. Step through days.
- **Booking actions:** check in, mark no-show, cancel, restore.
- **Walk-in booking:** staff can book for someone at the desk. Phone is optional, and the
  advance-window and per-phone limits are skipped, but double-booking protection still applies.
- **Block time:** pick a table (or all tables), a time range, and a reason. The panel warns about
  existing bookings that clash with the block. Blocks can be removed.
- **Settings:** center name, opening hours per weekday, slot size, durations, prices and peak
  rules, booking rules (advance days, cancel cutoff, per-phone limit, max players), and tables
  (add / rename / take out of service). A table can't be taken out of service while it still has
  upcoming bookings.

### 5. Technical requirements

- **Backend:** Node.js 20+, Express, SQLite (`better-sqlite3`), with the DB path set by env.
  Business logic lives in a service module that is separate from HTTP, so it can be tested directly.
- **Frontend:** plain HTML/CSS/JS served by the same server, no build step. Light and dark mode.
  Works at phone width.
- **API:** JSON. Errors look like `{ "error": { "code": "slot_taken", "message": "…" } }` with
  proper status codes (400 validation, 401 auth, 404 not found, 409 conflict).
- **Security:**
  - The admin API needs `Authorization: Bearer <ADMIN_PASSWORD>` and is compared in constant time.
    If no password is configured, the admin API is disabled.
  - Manage links carry a random secret token.
  - The public availability endpoint never exposes other customers' names or phones.
- **Data:** times are stored as `date` (YYYY-MM-DD) + minutes from midnight in center-local time.
  Booking statuses: `confirmed`, `checked_in`, `no_show`, `cancelled`. Cancelled bookings and
  no-shows free the slot.
- **Tests:** automated API tests covering pricing, overlaps, simultaneous booking attempts,
  validation, per-phone limits, blocks, manage/cancel rules, and admin auth.

### 6. Mobile app

- A **Capacitor iOS app** wraps the same customer, manage and front-desk pages, and calls the API
  through a configurable server URL. The server allows the app's origins through CORS.
- Native touches: safe areas for the notch and home indicator, the native share sheet for the
  booking link, and a success haptic.
- **Demo data:** a seeder creates 5 tables and random reservations of every type and status, from
  3 days back to 7 days ahead.
- **Tests:** an end-to-end suite runs the app bundle on an emulated iPhone. A script for macOS
  builds the app, runs it on the iOS Simulator, and checks that a booking made inside the app
  reaches the server.

### 7. Deliberately out of scope for v1 (next steps)

- Online payment / deposits (e.g. Stripe or a local payment provider)
- SMS / WhatsApp confirmations and reminders
- Customer accounts, memberships, punch cards
- Recurring bookings (weekly league night), coaching sessions with coach calendars
- Equipment rental (paddles / balls) as add-ons
- Multiple branches
- Rate limiting and brute-force protection on the public and admin endpoints

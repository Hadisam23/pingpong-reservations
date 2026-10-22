# 🏓 Ping Pong Center — Reservations

Online table booking for a ping pong center: customers book from their phone without creating an
account, and staff run the day from a front-desk panel. Ships as a website **and** a Capacitor iOS
app (`mobile/`).

See [SPEC.md](SPEC.md) for the full product spec (the build prompt this project was made from).

## Features

- **Customers** (`/`): pick a day, a duration, and a free time × table in the grid, see the price,
  then book with name + phone. They get a booking code and a private manage link.
- **Manage booking** (`/manage`): view or cancel using the private link, or with the booking code +
  phone number.
- **Front desk** (`/admin`): day timeline across all tables, check-in / no-show / cancel / restore,
  walk-in bookings, blocking time (one table or all), and settings (hours, prices, peak times,
  rules, tables).
- **Rules enforced on the server:**
  - no overlapping bookings, checked atomically in a transaction
  - bookings must be inside opening hours and on the slot grid
  - booking window (default 14 days ahead)
  - per-phone limit on upcoming bookings
  - online-cancellation cutoff
  - blocked time can't be booked
- **Session types:**
  - Casual play
  - Training with robot (+₪30/h)
  - Private coaching (+₪120/h)
  - League match
  - Birthday / event (+₪50/h, at least 2 h)

  You can edit them under Admin → Settings.
- **Pricing:** off-peak and peak rates per hour, priced slot by slot (peak from a time of day plus
  whole peak days).

## Run it

```bash
npm install
ADMIN_PASSWORD=choose-something npm start   # http://localhost:3000
npm test                                     # API test suite
npm run seed                                 # demo data: 5 tables + random reservations of every type
```

`npm run seed` **replaces all bookings** in `DB_PATH`. Pass `-- --seed 42` to get the same data
every time.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | – | Required to enable the admin panel and API |
| `DB_PATH` | `./data/pingpong.db` | SQLite file. Point it at a persistent volume in production |
| `BASE_URL` | request host | Public URL used in manage links (e.g. `https://book.mycenter.com`) |
| `CORS_ORIGINS` | – | Extra allowed origins, comma separated. The app's own origins (`capacitor://localhost`, `http(s)://localhost`) are always allowed |

## Mobile app (Capacitor, iOS)

The app bundles the same pages (`public/`) and talks to the backend at `API_URL`.

```bash
cd mobile
npm install
API_URL=http://localhost:3000 npm run sync   # build www/ and copy it into ios/
npm run open                                  # open in Xcode, or:
npm run ios                                   # build + run on a simulator/device
```

On a physical iPhone, set `API_URL` to your Mac's LAN IP (e.g. `http://192.168.1.20:3000`). For
release builds, use your deployed HTTPS server.

### Tests

| Command | Where | What it does |
|---|---|---|
| `npm run test:e2e` | any OS | Runs the app bundle on an emulated iPhone (Playwright) against a seeded backend: booking with types and prices, the party minimum length, my-bookings, manage/cancel, the "slot just taken" race, the front desk, and the in-app self-test. Set `E2E_BROWSER=webkit` to use the Safari engine. |
| `npm run test:ios` | macOS + Xcode | Starts a seeded backend, builds the app with a built-in self-test, boots an iOS Simulator, installs and launches the app, then checks that the booking made **inside the app** reached the server. Screenshots go to `mobile/shots/`. Set `DEVICE="iPhone 16"` to pick a simulator. |

The e2e test needs the root dependencies too (`npm install` in the repo root).

Five tables and default opening hours/prices are created on first start. Change them in **Admin → Settings**.

## API

Errors always look like `{ "error": { "code": "slot_taken", "message": "…" } }`.

### Public

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Center name, hours, durations, prices, rules, today's date |
| GET | `/api/availability?date=YYYY-MM-DD` | Slots (with price/peak/past) and busy ranges per table |
| POST | `/api/bookings` | `{ tableId, date, start: "HH:MM", duration, type, name, phone, players }` → booking, `manageToken`, `manageUrl` |
| GET | `/api/bookings/:code?token=…` or `?phone=…` | View a booking |
| POST | `/api/bookings/:code/cancel` | `{ token }` or `{ phone }` |

### Admin (`Authorization: Bearer <ADMIN_PASSWORD>`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/day?date=` | Tables, hours, all bookings (with contact details), blocks |
| POST | `/api/admin/bookings` | Walk-in booking (phone optional, no advance/per-phone limits) |
| PATCH | `/api/admin/bookings/:code` | `{ status: confirmed \| checked_in \| no_show \| cancelled }` |
| POST | `/api/admin/blocks` | `{ tableId \| null, date, start, end, reason }`; response lists clashing bookings |
| DELETE | `/api/admin/blocks/:id` | Remove a block |
| GET/PUT | `/api/admin/settings` | Read / update settings (partial updates are merged) |
| GET/POST | `/api/admin/tables` | List / add tables |
| PATCH | `/api/admin/tables/:id` | `{ name, active }`. Can't deactivate a table with upcoming bookings |

## Project layout

```
server.js            entry point (env config, graceful shutdown)
src/app.js           Express app: routes, admin auth, error handling
src/service.js       booking rules: availability, pricing, create/cancel, admin actions
src/settings.js      default settings + validation
src/time.js          date/time helpers (center time zone)
src/db.js            SQLite schema
src/seed.js          random demo data
scripts/seed.js      `npm run seed`
public/              booking page, manage page, admin panel (plain HTML/CSS/JS)
test/                API + seed tests (node:test)
mobile/              Capacitor app: ios/ project, build script, e2e + simulator tests
```

## Next steps

Payments/deposits, SMS or WhatsApp confirmations and reminders, recurring bookings (league nights),
coach calendars, equipment rental add-ons, rate limiting, and multiple branches.

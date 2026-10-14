-- Y11 HQ database schema.
-- Money is stored as NUMERIC(10,2) (exact cents, never floating point).

CREATE TABLE IF NOT EXISTS users (
  id                SERIAL PRIMARY KEY,
  username          TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  full_name         TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('owner', 'associate')),
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  can_see_stock     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Level state (associates only)
  level             INT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  period_start      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- start of the current 2-month period
  period_jerseys    INT NOT NULL DEFAULT 0,              -- jerseys sold this period (resets at each check)
  set_progress      INT NOT NULL DEFAULT 0,              -- jerseys toward the next set of 3 (carries over)
  skip_next_check   BOOLEAN NOT NULL DEFAULT TRUE,       -- new associates skip their first check
  warning_deadline  TIMESTAMPTZ,                         -- set when a Level 1 associate is warned
  pending_removal   BOOLEAN NOT NULL DEFAULT FALSE,      -- missed the warning deadline; waiting for the CEO
  removed_at        TIMESTAMPTZ
);

-- Jersey types and their prices: fan short sleeve, player long sleeve, etc.
CREATE TABLE IF NOT EXISTS product_types (
  id     SERIAL PRIMARY KEY,
  code   TEXT UNIQUE NOT NULL,
  name   TEXT NOT NULL,
  price  NUMERIC(10,2) NOT NULL,  -- what the customer pays
  cost   NUMERIC(10,2) NOT NULL   -- what the supplier charges you
);

-- A specific jersey, e.g. "Real Madrid Away 25/26"
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  team        TEXT NOT NULL,
  kit         TEXT NOT NULL,
  season      TEXT,
  type_id     INT NOT NULL REFERENCES product_types(id),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One size of a jersey, with the main stock you hold
CREATE TABLE IF NOT EXISTS variants (
  id          SERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size        TEXT NOT NULL,
  stock       INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  UNIQUE (product_id, size)
);

-- Jerseys given to an associate to sell in person
CREATE TABLE IF NOT EXISTS in_hand (
  id            SERIAL PRIMARY KEY,
  associate_id  INT NOT NULL REFERENCES users(id),
  variant_id    INT NOT NULL REFERENCES variants(id),
  quantity      INT NOT NULL CHECK (quantity >= 0),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at        TIMESTAMPTZ NOT NULL
);

-- One sale (an order). Totals are filled in when it is approved.
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL PRIMARY KEY,
  associate_id    INT REFERENCES users(id),   -- NULL = sold by the CEO
  channel         TEXT NOT NULL CHECK (channel IN ('in_hand', 'etransfer', 'website', 'owner')),
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('etransfer', 'cash', 'stripe')),
  customer_name   TEXT NOT NULL,
  customer_email  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by      INT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  reject_reason   TEXT,
  notes           TEXT,
  jersey_count    INT NOT NULL,
  squad_deal      BOOLEAN NOT NULL DEFAULT FALSE,
  revenue         NUMERIC(10,2) NOT NULL,  -- jerseys + extras (shipping excluded)
  cost            NUMERIC(10,2) NOT NULL,
  profit          NUMERIC(10,2) NOT NULL,  -- before commission
  shipping        NUMERIC(10,2) NOT NULL DEFAULT 0  -- passed straight to the supplier
);

CREATE TABLE IF NOT EXISTS sale_items (
  id            SERIAL PRIMARY KEY,
  sale_id       INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  variant_id    INT NOT NULL REFERENCES variants(id),
  quantity      INT NOT NULL CHECK (quantity > 0),
  from_in_hand  BOOLEAN NOT NULL DEFAULT FALSE,
  name_number   BOOLEAN NOT NULL DEFAULT FALSE,
  custom_text   TEXT,
  patch         BOOLEAN NOT NULL DEFAULT FALSE,
  unit_price    NUMERIC(10,2) NOT NULL,
  unit_cost     NUMERIC(10,2) NOT NULL
);

-- $24 / $30 / $36 earned each time an associate completes a set of 3 jerseys
CREATE TABLE IF NOT EXISTS commission_earnings (
  id            SERIAL PRIMARY KEY,
  associate_id  INT NOT NULL REFERENCES users(id),
  sale_id       INT NOT NULL REFERENCES sales(id),
  amount        NUMERIC(10,2) NOT NULL,
  level         INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ  -- filled in by Payouts (Phase 2)
);

-- History of level changes, warnings and removals
CREATE TABLE IF NOT EXISTS level_events (
  id            SERIAL PRIMARY KEY,
  associate_id  INT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL,
  from_level    INT,
  to_level      INT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cash an associate collected (+) and handed to you (-)
CREATE TABLE IF NOT EXISTS cash_ledger (
  id            SERIAL PRIMARY KEY,
  associate_id  INT NOT NULL REFERENCES users(id),
  sale_id       INT REFERENCES sales(id),
  amount        NUMERIC(10,2) NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
-- Only one open shift per person
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts (user_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  actor_id    INT REFERENCES users(id),
  action      TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_status_idx ON sales (status, decided_at);
CREATE INDEX IF NOT EXISTS sales_associate_idx ON sales (associate_id);

-- ================= Phase 2 =================

-- Milestone bonuses already paid this period (reset at each 2-month check)
ALTER TABLE users ADD COLUMN IF NOT EXISTS milestones_awarded INT NOT NULL DEFAULT 0;
-- Code used in the associate's referral link: y11jerseys.com/?ref=<code>
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- Payouts: one row each time you pay an associate
CREATE TABLE IF NOT EXISTS payouts (
  id            SERIAL PRIMARY KEY,
  associate_id  INT NOT NULL REFERENCES users(id),
  amount        NUMERIC(10,2) NOT NULL,
  method        TEXT NOT NULL DEFAULT 'etransfer',
  note          TEXT,
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INT NOT NULL REFERENCES users(id)
);

-- Earnings can be commission or a milestone bonus
ALTER TABLE commission_earnings ALTER COLUMN sale_id DROP NOT NULL;
ALTER TABLE commission_earnings ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'commission';
ALTER TABLE commission_earnings ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE commission_earnings ADD COLUMN IF NOT EXISTS payout_id INT REFERENCES payouts(id);

-- Promo codes: tracking only, no discount. Several per associate.
CREATE TABLE IF NOT EXISTS promo_codes (
  id            SERIAL PRIMARY KEY,
  associate_id  INT NOT NULL REFERENCES users(id),
  code          TEXT UNIQUE NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS promo_code TEXT;

-- Challenges were removed; clean them out of older databases
DROP TABLE IF EXISTS challenges;

CREATE TABLE IF NOT EXISTS announcements (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  INT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  link        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS expenses (
  id           SERIAL PRIMARY KEY,
  category     TEXT NOT NULL,
  description  TEXT,
  amount       NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  spent_at     DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by   INT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shifts that ran past the limit are closed automatically
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS auto_ended BOOLEAN NOT NULL DEFAULT FALSE;
-- Overdue in-hand jerseys only notify once
ALTER TABLE in_hand ADD COLUMN IF NOT EXISTS overdue_notified BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing associates get a referral link named after their username
UPDATE users SET referral_code = username WHERE role = 'associate' AND referral_code IS NULL;

-- ================= Phase 3 =================

-- Jersey updates: an associate says jerseys in hand were returned, lost or damaged.
-- Nothing changes until the CEO confirms. While one is waiting, those jerseys can't be sold and aren't overdue.
CREATE TABLE IF NOT EXISTS in_hand_updates (
  id            SERIAL PRIMARY KEY,
  in_hand_id    INT NOT NULL REFERENCES in_hand(id),
  associate_id  INT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('returned', 'lost', 'damaged')),
  quantity      INT NOT NULL CHECK (quantity > 0),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    INT REFERENCES users(id)
);
-- Only one update waiting per in-hand row
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_update ON in_hand_updates (in_hand_id) WHERE status = 'pending';

-- WhatsApp orders get a fixed amount off every jersey (Settings). Revenue is already net of it;
-- this keeps the amount so screens and reports can show it.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS whatsapp_discount NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Stock requests: an associate asks for more jerseys to carry.
-- The CEO can lower the amounts, then hands them over as jerseys in hand (or declines).
CREATE TABLE IF NOT EXISTS stock_requests (
  id            SERIAL PRIMARY KEY,
  associate_id  INT NOT NULL REFERENCES users(id),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    INT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS stock_request_items (
  id          SERIAL PRIMARY KEY,
  request_id  INT NOT NULL REFERENCES stock_requests(id) ON DELETE CASCADE,
  variant_id  INT NOT NULL REFERENCES variants(id),
  quantity    INT NOT NULL CHECK (quantity > 0),                         -- what they asked for
  approved    INT CHECK (approved >= 0 AND approved <= quantity),        -- what the CEO handed over
  UNIQUE (request_id, variant_id)
);

-- Website orders (y11jerseys.com): paid by card on the shop; its payment webhook sends each one here.
-- Made to order (bought from the supplier after payment), so they never touch stock.
-- One row per Stripe checkout: if the shop sends the same order twice, it is only recorded once.
CREATE TABLE IF NOT EXISTS website_orders (
  id                 SERIAL PRIMARY KEY,
  sale_id            INT UNIQUE REFERENCES sales(id),
  stripe_session_id  TEXT UNIQUE NOT NULL,
  environment        TEXT NOT NULL CHECK (environment IN ('live', 'sandbox')),  -- sandbox = Stripe test mode
  email              TEXT,
  phone              TEXT,
  ship_name          TEXT,
  ship_line1         TEXT,
  ship_line2         TEXT,
  ship_city          TEXT,
  ship_province      TEXT,
  ship_postal        TEXT,
  ship_country       TEXT,
  total_paid         NUMERIC(10,2) NOT NULL,           -- everything the customer paid
  tax                NUMERIC(10,2) NOT NULL DEFAULT 0, -- not revenue: it goes to the government
  shipping           NUMERIC(10,2) NOT NULL DEFAULT 0, -- passed to the supplier, like other sales
  promo_code         TEXT,
  ref_code           TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The jerseys in a website order, exactly as the supplier needs them.
CREATE TABLE IF NOT EXISTS website_order_items (
  id                SERIAL PRIMARY KEY,
  website_order_id  INT NOT NULL REFERENCES website_orders(id) ON DELETE CASCADE,
  product_id        TEXT,          -- the shop's id, e.g. p161
  title             TEXT NOT NULL, -- as shown on the shop
  team              TEXT,
  kit               TEXT,
  season            TEXT,
  version           TEXT,          -- e.g. "Player Version", "Retro Reproduction"
  size              TEXT NOT NULL,
  quantity          INT NOT NULL CHECK (quantity > 0),
  print_name        TEXT,
  print_number      TEXT,
  patch             BOOLEAN NOT NULL DEFAULT FALSE,
  unit_cost         NUMERIC(10,2) NOT NULL DEFAULT 0  -- what the supplier charges you, from Settings
);

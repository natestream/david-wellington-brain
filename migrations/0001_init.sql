-- David Wellington Brain: initial schema.
-- Dates are YYYY-MM-DD in America/Los_Angeles. Timestamps are ISO 8601 UTC.
-- Every row has `rep` (default 'david') so his sales team can join later without a migration.

-- One row per door. This is the objections table.
CREATE TABLE doors (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  date           TEXT NOT NULL,
  rep            TEXT NOT NULL DEFAULT 'david',
  area           TEXT,
  -- Same names as David's Rotor CRM pin types, so logged doors compare 1:1 with the pin export.
  outcome        TEXT NOT NULL CHECK (outcome IN ('gave_pitch', 'go_back', 'never_knock', 'door_hanger', 'no_answer', 'not_interested', 'made_sale')),
  objection_type TEXT CHECK (objection_type IN ('price', 'has_someone', 'spouse', 'timing', 'diy', 'not_needed', 'other')),
  objection_text TEXT,
  response       TEXT,
  amount         REAL,           -- ARR of the plan sold: one year of revenue, even for longer agreements
  notes          TEXT,
  coaching       TEXT
);

CREATE INDEX idx_doors_date ON doors (date);
CREATE INDEX idx_doors_objection_type ON doors (objection_type);
CREATE INDEX idx_doors_rep_date ON doors (rep, date);

-- One row per rep per day: the inputs from "Wellington Sales KPI Calculations".
-- Pin counts come from the Rotor CRM export ("New Pins by Team Member");
-- hours_knocked and arr_sold are entered by the rep.
-- Subtotals and the 6 KPIs are calculated when read, never stored.
-- Saving the same rep + day again updates the row (UNIQUE(rep, date)).
CREATE TABLE daily_kpis (
  id             TEXT PRIMARY KEY,
  date           TEXT NOT NULL,
  rep            TEXT NOT NULL DEFAULT 'david',
  total          INTEGER,
  gave_pitch     INTEGER,
  go_back        INTEGER,
  never_knock    INTEGER,
  door_hanger    INTEGER,
  no_answer      INTEGER,
  not_interested INTEGER,
  made_sale      INTEGER,
  hours_knocked  REAL,
  arr_sold       REAL,
  source         TEXT NOT NULL DEFAULT 'pdf' CHECK (source IN ('pdf', 'crm', 'manual')),
  raw_summary    TEXT,
  extra          TEXT,
  updated_at     TEXT NOT NULL,
  UNIQUE (rep, date)
);

-- General second-brain content (replaces his local Obsidian vault).
-- tags is a JSON array of strings.
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'import'))
);

CREATE INDEX idx_notes_created_at ON notes (created_at);

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
  outcome        TEXT NOT NULL CHECK (outcome IN ('no_answer', 'not_interested', 'pitched', 'quoted', 'closed', 'callback')),
  objection_type TEXT CHECK (objection_type IN ('price', 'has_someone', 'spouse', 'timing', 'diy', 'not_needed', 'other')),
  objection_text TEXT,
  response       TEXT,
  amount         REAL,
  notes          TEXT,
  coaching       TEXT
);

CREATE INDEX idx_doors_date ON doors (date);
CREATE INDEX idx_doors_objection_type ON doors (objection_type);
CREATE INDEX idx_doors_rep_date ON doors (rep, date);

-- One row per rep per day, from the end-of-day CRM PDF.
-- Re-uploading the same day replaces the row (UNIQUE(rep, date)).
-- Rates are calculated when read, never stored.
-- NOTE: the KPI columns are placeholders until the CRM PDF fields are confirmed (issue #12).
-- `extra` holds any other numbers from the PDF as JSON so nothing is lost before then.
CREATE TABLE daily_kpis (
  id            TEXT PRIMARY KEY,
  date          TEXT NOT NULL,
  rep           TEXT NOT NULL DEFAULT 'david',
  doors_knocked INTEGER,
  contacts      INTEGER,
  pitches       INTEGER,
  quotes        INTEGER,
  closes        INTEGER,
  revenue       REAL,
  hours         REAL,
  source        TEXT NOT NULL DEFAULT 'pdf' CHECK (source IN ('pdf', 'crm', 'manual')),
  raw_summary   TEXT,
  extra         TEXT,
  updated_at    TEXT NOT NULL,
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

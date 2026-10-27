-- Players who share their MMR. The first overlay to report an id claims it;
-- only the holder of that token can update or delete it afterwards.
CREATE TABLE players (
  primary_id TEXT PRIMARY KEY,   -- "Steam|7656...|0", "Epic|...|0", "XboxOne|...|0"
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,      -- SHA-256 of the overlay's secret token
  created_at INTEGER NOT NULL,   -- unix ms
  updated_at INTEGER NOT NULL
);

-- Latest MMR per playlist.
CREATE TABLE mmr (
  primary_id TEXT NOT NULL REFERENCES players(primary_id) ON DELETE CASCADE,
  playlist INTEGER NOT NULL,
  mmr INTEGER NOT NULL,
  at INTEGER NOT NULL,           -- when the game logged it, unix ms
  PRIMARY KEY (primary_id, playlist)
);

-- Every reading, for MMR over time.
CREATE TABLE mmr_history (
  primary_id TEXT NOT NULL REFERENCES players(primary_id) ON DELETE CASCADE,
  playlist INTEGER NOT NULL,
  mmr INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (primary_id, playlist, at)
);

-- The journal is stored the same way as trades.json / quotes.txt: one text value per key.
-- Values are split into parts because D1 limits a single SQL statement to 100 KB.
--   key 'data'   -> the trades.json contents  {"start": ..., "trades": [...]}
--   key 'quotes' -> the quotes.txt contents
CREATE TABLE IF NOT EXISTS blobs (
  key   TEXT    NOT NULL,
  part  INTEGER NOT NULL,
  value TEXT    NOT NULL,
  PRIMARY KEY (key, part)
);

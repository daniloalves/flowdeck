/**
 * Ordered schema migrations. `PRAGMA user_version` stores how many have been applied.
 * Never edit a released migration; append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE account (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    config_dir  TEXT NOT NULL UNIQUE,
    color       TEXT NOT NULL,
    cap_5h      INTEGER,
    cap_7d      INTEGER
  );

  CREATE TABLE node (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('claude', 'shell')),
    title             TEXT NOT NULL,
    cwd               TEXT NOT NULL,
    account_id        TEXT REFERENCES account(id) ON DELETE RESTRICT,
    tmux_session      TEXT NOT NULL UNIQUE,
    claude_session_id TEXT,
    launch_args       TEXT NOT NULL DEFAULT '[]',
    token             TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE edge (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    target     TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
    direction  TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('one_way', 'both')),
    created_at INTEGER NOT NULL,
    UNIQUE (source, target)
  );

  CREATE TABLE node_status (
    node_id    TEXT PRIMARY KEY REFERENCES node(id) ON DELETE CASCADE,
    state      TEXT NOT NULL,
    detail     TEXT,
    updated_at INTEGER NOT NULL
  );

  -- No foreign keys: the log outlives deleted nodes.
  CREATE TABLE message (
    id           TEXT PRIMARY KEY,
    from_node    TEXT NOT NULL,
    from_title   TEXT NOT NULL,
    to_node      TEXT NOT NULL,
    to_title     TEXT NOT NULL,
    body         TEXT NOT NULL,
    delivered    INTEGER NOT NULL DEFAULT 0,
    delivery     TEXT,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX message_pending ON message (to_node, delivered, created_at);

  CREATE TABLE app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  /* 2 — Codex and Kiro nodes; agent-neutral session id; accounts per agent.
     SQLite cannot alter a CHECK constraint, so `node` is rebuilt (foreign keys are off while
     migrations run and are verified afterwards). */ `
  CREATE TABLE node_v2 (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('claude', 'codex', 'kiro', 'shell')),
    title         TEXT NOT NULL,
    cwd           TEXT NOT NULL,
    account_id    TEXT REFERENCES account(id) ON DELETE RESTRICT,
    tmux_session  TEXT NOT NULL UNIQUE,
    session_id    TEXT,
    launch_args   TEXT NOT NULL DEFAULT '[]',
    token         TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
    created_at    INTEGER NOT NULL
  );
  INSERT INTO node_v2 (id, kind, title, cwd, account_id, tmux_session, session_id, launch_args, token, x, y, w, h, created_at)
    SELECT id, kind, title, cwd, account_id, tmux_session, claude_session_id, launch_args, token, x, y, w, h, created_at FROM node;
  DROP TABLE node;
  ALTER TABLE node_v2 RENAME TO node;

  ALTER TABLE account ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude' CHECK (agent IN ('claude', 'codex'));
  `,

  /* 3 — drawings on the canvas: group rectangles and texts */ `
  CREATE TABLE annotation (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('group', 'text')),
    text       TEXT NOT NULL DEFAULT '',
    color      TEXT NOT NULL,
    font_size  INTEGER NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

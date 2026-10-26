import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 2000');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this FlowDeck build (v${MIGRATIONS.length})`);
  }
  if (current === MIGRATIONS.length) return;
  // Table rebuilds need foreign keys off (it cannot change inside a transaction).
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]!);
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) throw new Error(`migration ${v + 1} broke ${broken.length} foreign key(s)`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

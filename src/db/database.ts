import Database from 'better-sqlite3'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

export class BridgeDatabase {
  readonly raw: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.raw = new Database(path)
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('foreign_keys = ON')
    this.raw.pragma('busy_timeout = 5000')
  }

  migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `)
    const applied = new Set(
      this.raw.prepare('SELECT version FROM schema_migrations').all()
        .map((row) => (row as { version: number }).version),
    )
    const directory = join(PROJECT_ROOT, 'migrations')
    const files = readdirSync(directory).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()
    const apply = this.raw.transaction((version: number, sql: string) => {
      this.raw.exec(sql)
      this.raw.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString())
    })
    for (const file of files) {
      const version = Number.parseInt(file.split('_')[0] ?? '', 10)
      if (!Number.isInteger(version) || applied.has(version)) continue
      apply(version, readFileSync(join(directory, file), 'utf8'))
    }
  }

  close(): void {
    this.raw.close()
  }
}

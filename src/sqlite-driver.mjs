import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)

function moduleDefault(value) {
  return value?.default ?? value
}

export function openSqliteDatabase(path, {
  driver = 'better-sqlite3',
  betterSqlite3Path = process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH,
} = {}) {
  if (driver === 'builtin') {
    const { DatabaseSync } = require('node:sqlite')
    return new DatabaseSync(path)
  }
  if (driver !== 'better-sqlite3') {
    throw new TypeError(`Unsupported SQLite driver '${driver}'`)
  }
  let loaded
  try {
    loaded = betterSqlite3Path
      ? require(resolve(betterSqlite3Path))
      : require('better-sqlite3')
  } catch (error) {
    const detail = betterSqlite3Path
      ? ` from ${betterSqlite3Path}`
      : ''
    throw new Error(
      `better-sqlite3 could not be loaded${detail}: ${error.message}`,
      { cause: error },
    )
  }
  const BetterSqlite3 = moduleDefault(loaded)
  return new BetterSqlite3(path)
}

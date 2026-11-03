import { FederationDurabilityStore } from '../../src/durability-store.mjs'

const [databasePath, clockRaw] = process.argv.slice(2)
if (!databasePath || !clockRaw) process.exit(90)

const store = new FederationDurabilityStore(databasePath, {
  clock: () => Number(clockRaw),
})
store.migrate()
const claimed = store.claimOutbox({
  workerId: 'crashing-worker',
  limit: 1,
  leaseMs: 1_000,
  maxAttempts: 3,
})
if (claimed.length !== 1) process.exit(92)

// Deliberately skip close() and any delivery result.
process.exit(91)

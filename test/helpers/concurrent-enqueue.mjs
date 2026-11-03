import { FederationDurabilityStore } from '../../src/durability-store.mjs'

const [databasePath, prefix, countRaw, clockRaw] = process.argv.slice(2)
const count = Number(countRaw)
const clock = Number(clockRaw)
if (!databasePath || !prefix || !Number.isInteger(count) || !Number.isSafeInteger(clock)) {
  process.exit(90)
}

const store = new FederationDurabilityStore(databasePath, { clock: () => clock })
store.migrate()
for (let index = 0; index < count; index += 1) {
  const key = `${prefix}-${index}`
  store.enqueueOutbox({
    peerId: 'marveen',
    messageKey: key,
    from: 'codex/stress',
    to: 'bela',
    content: `stress payload ${key}`,
    ref: key,
  })
}
store.close()

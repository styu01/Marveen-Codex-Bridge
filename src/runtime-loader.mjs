import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function validateRuntime(runtime) {
  for (const method of ['isReady', 'manifestAgents', 'run']) {
    if (typeof runtime?.[method] !== 'function') {
      throw new Error(`runtime module result is missing ${method}()`)
    }
  }
  return runtime
}

export async function loadRuntimeModule(path, context) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('runtime module path must be absolute')
  }
  const absolutePath = resolve(path)
  const stat = lstatSync(absolutePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('runtime module must be a regular file and not a symbolic link')
  }
  if (realpathSync(absolutePath) !== absolutePath) {
    throw new Error('runtime module path must not traverse a symbolic link')
  }
  const loaded = await import(pathToFileURL(absolutePath).href)
  if (typeof loaded.createRuntime !== 'function') {
    throw new Error('runtime module must export createRuntime(context)')
  }
  return validateRuntime(await loaded.createRuntime(context))
}

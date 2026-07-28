import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export class ProcessLock {
  private acquired = false

  constructor(private readonly path: string) {}

  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    try {
      const fd = openSync(this.path, 'wx', 0o600)
      writeFileSync(fd, `${process.pid}\n`, 'utf8')
      closeSync(fd)
      this.acquired = true
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
    }

    let pid = 0
    try { pid = Number.parseInt(readFileSync(this.path, 'utf8').trim(), 10) } catch {}
    if (pid > 0) {
      try {
        process.kill(pid, 0)
        throw new Error(`Another Bridge process is running with PID ${pid}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }

    try { unlinkSync(this.path) } catch {}
    const fd = openSync(this.path, 'wx', 0o600)
    writeFileSync(fd, `${process.pid}\n`, 'utf8')
    closeSync(fd)
    this.acquired = true
  }

  release(): void {
    if (!this.acquired) return
    try { unlinkSync(this.path) } catch {}
    this.acquired = false
  }
}

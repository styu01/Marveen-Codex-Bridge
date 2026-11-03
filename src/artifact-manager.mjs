import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const SHA256_RX = /^[0-9a-f]{64}$/
const MAX_RELATIVE_PATH_BYTES = 1024

function errorWithCode(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function validateRelativePath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value) > MAX_RELATIVE_PATH_BYTES
    || value.includes('\0')
    || value.includes('\\')
    || isAbsolute(value)
  ) {
    throw errorWithCode('image_artifact_invalid_path', 'Artifact path must be a portable relative path')
  }
  const normalized = normalize(value)
  if (
    normalized !== value
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith(`..${sep}`)
  ) {
    throw errorWithCode(
      'image_artifact_invalid_path',
      'Artifact path must not contain traversal or redundant segments',
    )
  }
  return value
}

function assertNoSymlinkTraversal(root, relativePath) {
  let current = root
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw errorWithCode(
        'image_artifact_symlink_rejected',
        'Artifact path must not traverse a symbolic link',
      )
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function inspectPng(buffer, { maxPixels }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw errorWithCode('image_artifact_invalid_png', 'Artifact is not a valid PNG file')
  }
  let offset = 8
  let width = null
  let height = null
  let sawIdat = false
  let sawIend = false
  let chunkIndex = 0
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw errorWithCode('image_artifact_invalid_png', 'PNG chunk header is truncated')
    }
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) {
      throw errorWithCode('image_artifact_invalid_png', 'PNG chunk data is truncated')
    }
    const typeBuffer = buffer.subarray(offset + 4, offset + 8)
    const type = typeBuffer.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw errorWithCode('image_artifact_invalid_png', 'PNG chunk type is invalid')
    }
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length)
    const actualCrc = crc32(Buffer.concat([typeBuffer, data]))
    if (actualCrc !== expectedCrc) {
      throw errorWithCode('image_artifact_invalid_png', `PNG ${type} chunk CRC is invalid`)
    }
    if (chunkIndex === 0 && type !== 'IHDR') {
      throw errorWithCode('image_artifact_invalid_png', 'PNG IHDR must be the first chunk')
    }
    if (type === 'IHDR') {
      if (chunkIndex !== 0 || length !== 13 || width !== null) {
        throw errorWithCode('image_artifact_invalid_png', 'PNG IHDR chunk is invalid')
      }
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (width < 1 || height < 1 || width * height > maxPixels) {
        throw errorWithCode(
          'image_artifact_dimensions_rejected',
          `PNG dimensions exceed the configured ${maxPixels} pixel limit`,
        )
      }
    } else if (type === 'IDAT') {
      sawIdat = true
    } else if (type === 'IEND') {
      if (length !== 0) {
        throw errorWithCode('image_artifact_invalid_png', 'PNG IEND chunk is invalid')
      }
      sawIend = true
      offset = end
      if (offset !== buffer.length) {
        throw errorWithCode('image_artifact_invalid_png', 'PNG contains trailing data')
      }
      break
    }
    offset = end
    chunkIndex += 1
  }
  if (!width || !height || !sawIdat || !sawIend) {
    throw errorWithCode('image_artifact_invalid_png', 'PNG is missing required chunks')
  }
  return { mimeType: 'image/png', width, height }
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw errorWithCode(
      'image_artifact_storage_unsafe',
      'Artifact storage must be a real directory without symbolic-link traversal',
    )
  }
  chmodSync(path, 0o700)
}

function readStableFile(path, maxBytes) {
  const noFollow = constants.O_NOFOLLOW ?? 0
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw errorWithCode(
        'image_artifact_size_rejected',
        `Artifact must be a non-empty regular file no larger than ${maxBytes} bytes`,
      )
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size
    ) {
      throw errorWithCode('image_artifact_changed', 'Artifact changed while it was being validated')
    }
    return bytes
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export class ArtifactManager {
  constructor({
    state,
    runtimeRoot,
    agents,
    maxBytes = 20 * 1024 * 1024,
    maxPixels = 16_777_216,
    clock = Date.now,
    onEvent = () => {},
  }) {
    if (!state) throw new TypeError('artifact state is required')
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      throw new TypeError('artifact maxBytes is invalid')
    }
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) {
      throw new TypeError('artifact maxPixels is invalid')
    }
    this.state = state
    this.runtimeRoot = realpathSync(runtimeRoot)
    this.agents = new Map(agents.map((agent) => [agent.id, agent]))
    this.maxBytes = maxBytes
    this.maxPixels = maxPixels
    this.clock = clock
    this.onEvent = onEvent
    this.storageRoot = join(this.runtimeRoot, 'artifacts')
    ensurePrivateDirectory(this.storageRoot)
  }

  register({
    runId,
    agentId,
    workspaceRelativePath,
    expectedSha256,
  }) {
    const agent = this.agents.get(agentId)
    if (!agent) throw errorWithCode('agent_not_found', `Unknown Codex agent '${agentId}'`)
    const relativePath = validateRelativePath(workspaceRelativePath)
    if (
      expectedSha256 !== undefined
      && (typeof expectedSha256 !== 'string' || !SHA256_RX.test(expectedSha256))
    ) {
      throw errorWithCode(
        'image_artifact_invalid_hash',
        'expectedSha256 must be a lowercase SHA-256 digest',
      )
    }
    const workspaceRoot = realpathSync(agent.workspacePath)
    const sourcePath = resolve(workspaceRoot, relativePath)
    if (!inside(workspaceRoot, sourcePath)) {
      throw errorWithCode(
        'image_artifact_outside_workspace',
        'Generated image is outside the configured agent workspace',
      )
    }
    assertNoSymlinkTraversal(workspaceRoot, relativePath)
    const canonicalSource = realpathSync(sourcePath)
    if (!inside(workspaceRoot, canonicalSource) || canonicalSource !== sourcePath) {
      throw errorWithCode(
        'image_artifact_outside_workspace',
        'Generated image is outside the configured agent workspace',
      )
    }
    const bytes = readStableFile(canonicalSource, this.maxBytes)
    const inspection = inspectPng(bytes, { maxPixels: this.maxPixels })
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 !== undefined && digest !== expectedSha256) {
      throw errorWithCode('image_artifact_hash_mismatch', 'Generated image SHA-256 does not match')
    }
    const existing = this.state.findArtifact({
      runId,
      workspaceRelativePath: relativePath,
      sha256: digest,
    })
    if (existing) return { record: existing, duplicate: true }

    const artifactId = randomUUID()
    const agentDirectory = join(this.storageRoot, agentId)
    ensurePrivateDirectory(agentDirectory)
    const storedRelativePath = `${agentId}/${artifactId}.png`
    const destination = join(this.storageRoot, storedRelativePath)
    const temporary = join(agentDirectory, `.${artifactId}.${process.pid}.tmp`)
    let committed = false
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      const fd = openSync(temporary, constants.O_RDONLY)
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, destination)
      chmodSync(destination, 0o400)
      const record = this.state.insertArtifact({
        artifactId,
        runId,
        agentId,
        workspaceRelativePath: relativePath,
        storedRelativePath,
        mimeType: inspection.mimeType,
        byteSize: bytes.length,
        sha256: digest,
        width: inspection.width,
        height: inspection.height,
        createdAtMs: this.clock(),
      })
      committed = true
      this.onEvent('image_artifact_ready', {
        artifactId,
        runId,
        agentId,
        workspaceRelativePath: relativePath,
        sha256: digest,
      })
      return { record, duplicate: false }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
      if (!committed && existsSync(destination)) unlinkSync(destination)
    }
  }

  list(query = {}) {
    return this.state.listArtifacts(query)
  }

  get(artifactId) {
    return this.state.getArtifact(artifactId)
  }

  read(artifactId) {
    const record = this.get(artifactId)
    if (!record) return null
    const path = resolve(this.storageRoot, record.storedRelativePath)
    if (!inside(this.storageRoot, path)) {
      throw errorWithCode('image_artifact_storage_unsafe', 'Stored artifact path is invalid')
    }
    assertNoSymlinkTraversal(this.storageRoot, record.storedRelativePath)
    const bytes = readStableFile(path, this.maxBytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== record.sha256 || bytes.length !== record.byteSize) {
      throw errorWithCode('image_artifact_storage_corrupt', 'Stored artifact integrity check failed')
    }
    return { record, bytes }
  }
}

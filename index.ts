import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { type Plugin, type PluginOptions, tool, type ToolContext } from "@opencode-ai/plugin"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

const DEFAULT_DIRECTORY = ".opencode/artifacts"
const DEFAULT_READ_LIMIT = 2000
const DEFAULT_LIST_LIMIT = 100
const MAX_NAME_LENGTH = 120
const MAX_DESCRIPTION_LENGTH = 500
const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000

export type ArtifactsOptions = {
  directory: string
}

export type Artifact = {
  name: string
  description: string
  content: string
}

type PatchHunk =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: PatchChunk[] }

type PatchChunk = {
  context?: string
  oldLines: string[]
  newLines: string[]
  endOfFile: boolean
}

type StoreEntry = {
  path: string
  content: string
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

function relativePath(from: string, to: string): string {
  return relative(from, to).split(sep).join("/")
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

export function parseOptions(options?: PluginOptions): ArtifactsOptions {
  const directory = options?.directory ?? DEFAULT_DIRECTORY
  if (typeof directory !== "string" || directory.trim() === "") {
    throw new TypeError('[opencode-artifacts] "directory" must be a non-empty relative path')
  }
  if (isAbsolute(directory)) {
    throw new TypeError('[opencode-artifacts] "directory" must be relative to the worktree')
  }
  const normalized = resolve("/worktree", directory)
  if (!isInside("/worktree", normalized) || normalized === "/worktree") {
    throw new TypeError('[opencode-artifacts] "directory" must be a subdirectory of the worktree')
  }
  return { directory }
}

function validateField(field: "name" | "description", value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error(`Artifact ${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`Artifact ${field} must not be empty`)
  if (/\r|\n/.test(trimmed)) throw new Error(`Artifact ${field} must be a single line`)
  if (trimmed.length > maximum) throw new Error(`Artifact ${field} must not exceed ${maximum} characters`)
  return trimmed
}

export function serializeArtifact(name: string, description: string, content: string): string {
  const metadata = {
    name: validateField("name", name, MAX_NAME_LENGTH),
    description: validateField("description", description, MAX_DESCRIPTION_LENGTH),
  }
  return `---\n${stringifyYaml(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${content}`
}

export function parseArtifact(source: string): Artifact {
  const normalized = source.replaceAll("\r\n", "\n")
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/)
  if (!match) throw new Error("Missing or malformed YAML frontmatter")

  let metadata: unknown
  try {
    metadata = parseYaml(match[1] ?? "", { uniqueKeys: true })
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Frontmatter must be a YAML mapping")
  }
  const record = metadata as Record<string, unknown>
  const unsupported = Object.keys(record).filter((key) => key !== "name" && key !== "description")
  if (unsupported.length) throw new Error(`Unsupported frontmatter field: ${unsupported.join(", ")}`)

  return {
    name: validateField("name", record.name, MAX_NAME_LENGTH),
    description: validateField("description", record.description, MAX_DESCRIPTION_LENGTH),
    content: (match[2] ?? "").replace(/^\n/, ""),
  }
}

async function walkFiles(directory: string, prefix = ""): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  }
  const paths: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await walkFiles(absolute, path)))
    else if (entry.isFile()) paths.push(path)
  }
  return paths
}

export class ArtifactStore {
  readonly root: string

  constructor(
    readonly worktree: string,
    directory = DEFAULT_DIRECTORY,
  ) {
    this.root = resolve(worktree, directory)
    if (!isInside(worktree, this.root) || this.root === resolve(worktree)) {
      throw new Error("Artifact directory must be inside the worktree")
    }
  }

  async resolvePath(path: string, allowMissing = false): Promise<string> {
    if (!path || isAbsolute(path)) throw new Error("Artifact path must be a non-empty relative path")
    if (path.includes("\\")) throw new Error(`Artifact path must use forward slashes: ${path}`)
    const absolute = resolve(this.root, path)
    if (!isInside(this.root, absolute) || absolute === this.root) throw new Error(`Artifact path escapes the store: ${path}`)
    if (relativePath(this.root, absolute) !== path) throw new Error(`Artifact path must be normalized: ${path}`)

    let current = resolve(this.worktree)
    const parts = relative(current, absolute).split(sep)
    for (const part of parts) {
      current = resolve(current, part)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in artifact paths: ${path}`)
      } catch (error) {
        if (errorCode(error) === "ENOENT" && allowMissing) break
        throw error
      }
    }
    return absolute
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const resolved = await realpath(this.root)
    if (!isInside(await realpath(this.worktree), resolved)) throw new Error("Artifact directory resolves outside the worktree")
  }

  async entries(): Promise<StoreEntry[]> {
    const paths = await walkFiles(this.root)
    return Promise.all(
      paths.map(async (path) => ({ path, content: await readFile(await this.resolvePath(path), "utf8") })),
    )
  }

  async assertUniqueName(name: string, exceptPath?: string, entries?: StoreEntry[]): Promise<void> {
    const normalized = name.normalize("NFKC").toLocaleLowerCase()
    for (const entry of entries ?? (await this.entries())) {
      if (entry.path === exceptPath) continue
      let artifact
      try {
        artifact = parseArtifact(entry.content)
      } catch {
        continue
      }
      if (artifact.name.normalize("NFKC").toLocaleLowerCase() === normalized) {
        throw new Error(`Artifact name "${name}" is already used by ${entry.path}`)
      }
    }
  }

  async read(path: string): Promise<Artifact> {
    const absolute = await this.resolvePath(path)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`Artifact path is not a file: ${path}`)
    return parseArtifact(await readFile(absolute, "utf8"))
  }

  async write(path: string, artifact: Artifact, overwrite = false): Promise<void> {
    const absolute = await this.resolvePath(path, true)
    if (!overwrite && (await exists(absolute))) throw new Error(`Artifact already exists: ${path}`)
    await this.assertUniqueName(artifact.name, overwrite ? path : undefined)
    await this.ensureRoot()
    await mkdir(dirname(absolute), { recursive: true })
    await atomicWrite(absolute, serializeArtifact(artifact.name, artifact.description, artifact.content))
  }

  async edit(
    path: string,
    change: { name?: string; description?: string; oldString?: string; newString?: string; replaceAll?: boolean },
  ): Promise<Artifact> {
    const artifact = await this.read(path)
    const hasReplacement = change.oldString !== undefined || change.newString !== undefined
    if (!hasReplacement && change.name === undefined && change.description === undefined) {
      throw new Error("Provide metadata or body content to edit")
    }
    if (hasReplacement && (change.oldString === undefined || change.newString === undefined)) {
      throw new Error("oldString and newString must be provided together")
    }
    if (change.oldString === change.newString && hasReplacement) throw new Error("oldString and newString are identical")

    let content = artifact.content
    if (hasReplacement) {
      const oldString = change.oldString!
      if (!oldString) throw new Error("oldString must not be empty")
      const first = content.indexOf(oldString)
      if (first === -1) throw new Error("Could not find oldString in the artifact body")
      if (!change.replaceAll && first !== content.lastIndexOf(oldString)) {
        throw new Error("Found multiple matches for oldString; provide more context or set replaceAll")
      }
      content = change.replaceAll
        ? content.replaceAll(oldString, change.newString!)
        : `${content.slice(0, first)}${change.newString}${content.slice(first + oldString.length)}`
    }

    const next = {
      name: change.name ?? artifact.name,
      description: change.description ?? artifact.description,
      content,
    }
    const serialized = serializeArtifact(next.name, next.description, next.content)
    const validated = parseArtifact(serialized)
    await this.assertUniqueName(validated.name, path)
    await atomicWrite(await this.resolvePath(path), serialized)
    return validated
  }

  async remove(path: string): Promise<void> {
    const absolute = await this.resolvePath(path)
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`Artifact path is not a file: ${path}`)
    await rm(absolute)
  }

  async applyPatch(patchText: string): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
    const hunks = parsePatch(patchText)
    const current = new Map((await this.entries()).map((entry) => [entry.path, entry.content]))
    const next = new Map(current)
    const added: string[] = []
    const modified: string[] = []
    const deleted: string[] = []

    for (const hunk of hunks) {
      await this.resolvePath(hunk.path, true)
      if (hunk.type === "add") {
        if (next.has(hunk.path)) throw new Error(`Cannot add existing artifact: ${hunk.path}`)
        next.set(hunk.path, hunk.content)
        added.push(hunk.path)
        continue
      }
      const original = next.get(hunk.path)
      if (original === undefined) throw new Error(`Artifact does not exist: ${hunk.path}`)
      if (hunk.type === "delete") {
        next.delete(hunk.path)
        deleted.push(hunk.path)
        continue
      }
      const updated = applyChunks(original, hunk.path, hunk.chunks)
      if (hunk.movePath) {
        await this.resolvePath(hunk.movePath, true)
        if (next.has(hunk.movePath)) throw new Error(`Move destination already exists: ${hunk.movePath}`)
        next.delete(hunk.path)
        next.set(hunk.movePath, updated)
        deleted.push(hunk.path)
        added.push(hunk.movePath)
      } else {
        next.set(hunk.path, updated)
        modified.push(hunk.path)
      }
    }

    validateFinalStore(next)
    await this.replaceStore(next)
    return { added, modified, deleted }
  }

  private async replaceStore(entries: Map<string, string>): Promise<void> {
    await this.ensureRoot()
    const staging = await mkdtemp(resolve(tmpdir(), "opencode-artifacts-"))
    const backup = `${this.root}.backup-${crypto.randomUUID()}`
    try {
      for (const [path, content] of entries) {
        const target = resolve(staging, path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content, "utf8")
      }
      await rename(this.root, backup)
      try {
        await rename(staging, this.root)
      } catch (error) {
        await rename(backup, this.root)
        throw error
      }
      await rm(backup, { recursive: true, force: true })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`
  await writeFile(temporary, content, "utf8")
  await rename(temporary, path)
}

function validateFinalStore(entries: Map<string, string>): void {
  const names = new Map<string, string>()
  for (const [path, content] of entries) {
    const artifact = parseArtifact(content)
    const name = artifact.name.normalize("NFKC").toLocaleLowerCase()
    const duplicate = names.get(name)
    if (duplicate) throw new Error(`Artifact name "${artifact.name}" is duplicated by ${duplicate} and ${path}`)
    names.set(name, path)
  }
}

export function parsePatch(patchText: string): PatchHunk[] {
  const lines = patchText.replaceAll("\r\n", "\n").trim().split("\n")
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("Invalid patch format: missing Begin/End markers")
  }
  const hunks: PatchHunk[] = []
  let index = 1
  while (index < lines.length - 1) {
    const line = lines[index]!
    if (line.startsWith("*** Add File:")) {
      const path = line.slice(13).trim()
      if (!path) throw new Error("Add File path is required")
      index++
      const content: string[] = []
      while (index < lines.length - 1 && !lines[index]!.startsWith("*** ")) {
        if (!lines[index]!.startsWith("+")) throw new Error(`Added lines must start with +: ${path}`)
        content.push(lines[index]!.slice(1))
        index++
      }
      hunks.push({ type: "add", path, content: content.join("\n") })
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      const path = line.slice(16).trim()
      if (!path) throw new Error("Delete File path is required")
      hunks.push({ type: "delete", path })
      index++
      continue
    }
    if (line.startsWith("*** Update File:")) {
      const path = line.slice(16).trim()
      if (!path) throw new Error("Update File path is required")
      index++
      let movePath: string | undefined
      if (lines[index]?.startsWith("*** Move to:")) {
        movePath = lines[index]!.slice(12).trim()
        if (!movePath) throw new Error("Move destination is required")
        index++
      }
      const chunks: PatchChunk[] = []
      while (index < lines.length - 1 && !lines[index]!.startsWith("*** ")) {
        if (!lines[index]!.startsWith("@@")) throw new Error(`Expected @@ update chunk for ${path}`)
        const context = lines[index]!.slice(2).trim() || undefined
        index++
        const oldLines: string[] = []
        const newLines: string[] = []
        let endOfFile = false
        while (
          index < lines.length - 1 &&
          !lines[index]!.startsWith("@@") &&
          (!lines[index]!.startsWith("*** ") || lines[index] === "*** End of File")
        ) {
          const change = lines[index]!
          if (change === "*** End of File") {
            endOfFile = true
            index++
            break
          }
          if (change.startsWith(" ")) {
            oldLines.push(change.slice(1))
            newLines.push(change.slice(1))
          } else if (change.startsWith("-")) oldLines.push(change.slice(1))
          else if (change.startsWith("+")) newLines.push(change.slice(1))
          else throw new Error(`Invalid update line for ${path}: ${change}`)
          index++
        }
        chunks.push({ context, oldLines, newLines, endOfFile })
      }
      if (!chunks.length) throw new Error(`Update must contain at least one chunk: ${path}`)
      hunks.push({ type: "update", path, movePath, chunks })
      continue
    }
    throw new Error(`Unexpected patch line: ${line}`)
  }
  if (!hunks.length) throw new Error("Patch must contain at least one operation")
  return hunks
}

function findSequence(lines: string[], pattern: string[], start: number, endOfFile: boolean): number {
  const candidates: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ]
  for (const compare of candidates) {
    const begin = endOfFile ? Math.max(start, lines.length - pattern.length) : start
    const end = endOfFile ? begin : lines.length - pattern.length
    for (let index = begin; index <= end; index++) {
      if (pattern.every((value, offset) => compare(lines[index + offset]!, value))) return index
    }
  }
  return -1
}

function applyChunks(source: string, path: string, chunks: PatchChunk[]): string {
  const trailingNewline = source.endsWith("\n")
  const lines = source.split("\n")
  if (trailingNewline) lines.pop()
  let cursor = 0
  const replacements: Array<{ index: number; count: number; lines: string[] }> = []
  for (const chunk of chunks) {
    if (chunk.context) {
      const context = findSequence(lines, [chunk.context], cursor, false)
      if (context === -1) throw new Error(`Failed to find context '${chunk.context}' in ${path}`)
      cursor = context + 1
    }
    if (!chunk.oldLines.length) {
      replacements.push({ index: lines.length, count: 0, lines: chunk.newLines })
      continue
    }
    const found = findSequence(lines, chunk.oldLines, cursor, chunk.endOfFile)
    if (found === -1) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`)
    replacements.push({ index: found, count: chunk.oldLines.length, lines: chunk.newLines })
    cursor = found + chunk.oldLines.length
  }
  for (const replacement of replacements.reverse()) {
    lines.splice(replacement.index, replacement.count, ...replacement.lines)
  }
  return `${lines.join("\n")}\n`
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`)
  return result
}

function displayBody(artifact: Artifact, path: string, offset?: number, limit?: number): string {
  const start = positiveInteger(offset, 1, "offset")
  const maximum = positiveInteger(limit, DEFAULT_READ_LIMIT, "limit")
  const lines = artifact.content.split("\n")
  if (lines.at(-1) === "") lines.pop()
  if (start > lines.length && !(start === 1 && lines.length === 0)) {
    throw new Error(`Offset ${start} is out of range for this artifact (${lines.length} lines)`)
  }
  const selected: string[] = []
  let bytes = 0
  for (const original of lines.slice(start - 1, start - 1 + maximum)) {
    const line = original.length > MAX_LINE_LENGTH ? `${original.slice(0, MAX_LINE_LENGTH)}...` : original
    const rendered = `${start + selected.length}: ${line}`
    if (bytes + Buffer.byteLength(rendered) > MAX_OUTPUT_BYTES) break
    selected.push(rendered)
    bytes += Buffer.byteLength(rendered) + 1
  }
  const last = start + selected.length - 1
  const more = last < lines.length
  return [
    `<artifact path="${path}">`,
    `<name>${artifact.name}</name>`,
    `<description>${artifact.description}</description>`,
    "<content>",
    selected.join("\n"),
    more ? `(Showing lines ${start}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)` : `(End of artifact - total ${lines.length} lines)`,
    "</content>",
    "</artifact>",
  ].join("\n")
}

async function ask(context: ToolContext, permission: "read" | "edit", worktree: string, paths: string[]): Promise<void> {
  const patterns = paths.map((path) => relativePath(worktree, path))
  await context.ask({ permission, patterns, always: patterns, metadata: { paths: patterns } })
}

function tools(store: ArtifactStore) {
  const pathSchema = tool.schema.string().min(1).describe("Artifact path relative to the configured artifact directory")
  const optionalPositive = tool.schema.number().int().positive().optional()
  return {
    artifact_list: tool({
      description: "List artifact paths, names, and descriptions without reading their bodies. Invalid artifacts are reported with validation errors.",
      args: { offset: optionalPositive.describe("1-based result offset"), limit: optionalPositive.describe("Maximum results, default 100") },
      async execute(args, context) {
        await ask(context, "read", store.worktree, [store.root])
        const entries = await store.entries()
        const results = entries.map((entry) => {
          try {
            const artifact = parseArtifact(entry.content)
            return { path: entry.path, name: artifact.name, description: artifact.description }
          } catch (error) {
            return { path: entry.path, invalid: error instanceof Error ? error.message : String(error) }
          }
        })
        const offset = positiveInteger(args.offset, 1, "offset")
        const limit = positiveInteger(args.limit, DEFAULT_LIST_LIMIT, "limit")
        const selected = results.slice(offset - 1, offset - 1 + limit)
        return JSON.stringify({ artifacts: selected, offset, count: selected.length, total: results.length, hasMore: offset - 1 + selected.length < results.length }, null, 2)
      },
    }),
    artifact_write: tool({
      description: "Create an artifact with required name and description frontmatter. Set overwrite only for an intentional full replacement.",
      args: {
        path: pathSchema,
        name: tool.schema.string().describe(`Unique single-line name, maximum ${MAX_NAME_LENGTH} characters`),
        description: tool.schema.string().describe(`Single-line summary for artifact discovery, maximum ${MAX_DESCRIPTION_LENGTH} characters`),
        content: tool.schema.string().describe("Artifact body without frontmatter"),
        overwrite: tool.schema.boolean().optional().describe("Allow replacing an existing artifact, default false"),
      },
      async execute(args, context) {
        const path = await store.resolvePath(args.path, true)
        await ask(context, "edit", store.worktree, [path])
        await store.write(args.path, { name: args.name, description: args.description, content: args.content }, args.overwrite)
        return `Wrote artifact ${args.path}.`
      },
    }),
    artifact_read: tool({
      description: "Read artifact metadata and numbered body lines. Use artifact_list first when selecting an artifact.",
      args: { path: pathSchema, offset: optionalPositive.describe("1-based body line offset"), limit: optionalPositive.describe("Maximum body lines, default 2000") },
      async execute(args, context) {
        const path = await store.resolvePath(args.path)
        await ask(context, "read", store.worktree, [path])
        return displayBody(await store.read(args.path), args.path, args.offset, args.limit)
      },
    }),
    artifact_edit: tool({
      description: "Update artifact metadata and/or replace exact text in its body. Body replacement never modifies frontmatter.",
      args: {
        path: pathSchema,
        name: tool.schema.string().optional().describe("New unique artifact name"),
        description: tool.schema.string().optional().describe("New artifact description"),
        oldString: tool.schema.string().optional().describe("Exact body text to replace"),
        newString: tool.schema.string().optional().describe("Replacement body text"),
        replaceAll: tool.schema.boolean().optional().describe("Replace every occurrence, default false"),
      },
      async execute(args, context) {
        const path = await store.resolvePath(args.path)
        await ask(context, "edit", store.worktree, [path])
        await store.edit(args.path, args)
        return `Edited artifact ${args.path}.`
      },
    }),
    artifact_patch: tool({
      description: "Apply an OpenCode-style transactional patch to one or more artifacts. Supports add, update, move, and delete; all final artifacts require valid unique metadata frontmatter.",
      args: { patchText: tool.schema.string().describe("Full patch enclosed by *** Begin Patch and *** End Patch") },
      async execute(args, context) {
        const hunks = parsePatch(args.patchText)
        const paths: string[] = []
        for (const hunk of hunks) {
          paths.push(await store.resolvePath(hunk.path, true))
          if (hunk.type === "update" && hunk.movePath) paths.push(await store.resolvePath(hunk.movePath, true))
        }
        await ask(context, "edit", store.worktree, paths)
        const result = await store.applyPatch(args.patchText)
        return `Applied artifact patch. Added: ${result.added.length}; modified: ${result.modified.length}; deleted: ${result.deleted.length}.`
      },
    }),
    artifact_remove: tool({
      description: "Permanently remove one artifact.",
      args: { path: pathSchema },
      async execute(args, context) {
        const path = await store.resolvePath(args.path)
        await ask(context, "edit", store.worktree, [path])
        await store.remove(args.path)
        return `Removed artifact ${args.path}.`
      },
    }),
  }
}

const OpenCodeArtifacts: Plugin = async ({ worktree }, options) => {
  const { directory } = parseOptions(options)
  return { tool: tools(new ArtifactStore(worktree, directory)) }
}

export default OpenCodeArtifacts

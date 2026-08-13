import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import OpenCodeArtifacts, {
  ArtifactStore,
  parseArtifact,
  parseOptions,
  parsePatch,
  serializeArtifact,
} from "./index"

const temporaryDirectories: string[] = []

async function worktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-artifacts-test-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("artifact metadata", () => {
  test("serializes canonical frontmatter and parses the body", () => {
    const source = serializeArtifact("API design", "Public API conventions.", "# API\n\nBody")
    expect(source).toBe('---\nname: API design\ndescription: Public API conventions.\n---\n\n# API\n\nBody')
    expect(parseArtifact(source)).toEqual({
      name: "API design",
      description: "Public API conventions.",
      content: "# API\n\nBody",
    })
  })

  test("rejects missing, multiline, oversized, and unsupported metadata", () => {
    expect(() => parseArtifact("body only")).toThrow("frontmatter")
    expect(() => serializeArtifact("line one\nline two", "Description", "Body")).toThrow("single line")
    expect(() => serializeArtifact("Name", "x".repeat(501), "Body")).toThrow("500")
    expect(() => parseArtifact("---\nname: A\ndescription: B\nkind: note\n---\nBody")).toThrow("Unsupported")
  })
})

describe("parseOptions", () => {
  test("uses the default and accepts a relative subdirectory", () => {
    expect(parseOptions()).toEqual({ directory: ".opencode/artifacts" })
    expect(parseOptions({ directory: "docs/artifacts" })).toEqual({ directory: "docs/artifacts" })
  })

  test("rejects absolute paths and traversal", () => {
    expect(() => parseOptions({ directory: "/tmp/artifacts" })).toThrow("relative")
    expect(() => parseOptions({ directory: "../artifacts" })).toThrow("subdirectory")
    expect(() => parseOptions({ directory: "." })).toThrow("subdirectory")
  })
})

describe("ArtifactStore", () => {
  test("creates, reads, explicitly overwrites, and removes artifacts", async () => {
    const root = await worktree()
    const store = new ArtifactStore(root)
    await store.write("design/api.md", { name: "API", description: "API design.", content: "Version one" })
    expect(await store.read("design/api.md")).toEqual({ name: "API", description: "API design.", content: "Version one" })
    await expect(store.write("design/api.md", { name: "API", description: "Changed.", content: "Version two" })).rejects.toThrow("already exists")
    await store.write("design/api.md", { name: "API", description: "Changed.", content: "Version two" }, true)
    expect((await store.read("design/api.md")).content).toBe("Version two")
    await store.remove("design/api.md")
    await expect(store.read("design/api.md")).rejects.toThrow()
  })

  test("enforces case-insensitive Unicode-normalized unique names", async () => {
    const store = new ArtifactStore(await worktree())
    await store.write("first.md", { name: "API Design", description: "First.", content: "One" })
    await expect(store.write("second.md", { name: "api design", description: "Second.", content: "Two" })).rejects.toThrow("already used")
    await store.write("accent.md", { name: "Cafe\u0301", description: "Accent.", content: "One" })
    await expect(store.write("accent-two.md", { name: "Caf\u00e9", description: "Accent two.", content: "Two" })).rejects.toThrow("already used")
  })

  test("edits body and metadata while keeping frontmatter separate", async () => {
    const store = new ArtifactStore(await worktree())
    await store.write("note.md", { name: "Note", description: "Initial.", content: "alpha beta alpha" })
    await expect(store.edit("note.md", { oldString: "alpha", newString: "omega" })).rejects.toThrow("multiple")
    const result = await store.edit("note.md", {
      name: "Updated note",
      description: "Updated summary.",
      oldString: "alpha",
      newString: "omega",
      replaceAll: true,
    })
    expect(result).toEqual({ name: "Updated note", description: "Updated summary.", content: "omega beta omega" })
  })

  test("blocks traversal and symbolic links", async () => {
    const root = await worktree()
    const outside = await worktree()
    const store = new ArtifactStore(root)
    await mkdir(join(root, ".opencode/artifacts"), { recursive: true })
    await symlink(outside, join(root, ".opencode/artifacts/link"))
    await expect(store.write("../escape.md", { name: "Escape", description: "Bad.", content: "No" })).rejects.toThrow("escapes")
    await expect(store.write("link/escape.md", { name: "Escape", description: "Bad.", content: "No" })).rejects.toThrow("Symbolic links")
  })

  test("blocks a configured artifact directory that is a symbolic link", async () => {
    const root = await worktree()
    const outside = await worktree()
    await symlink(outside, join(root, "linked-artifacts"))
    const store = new ArtifactStore(root, "linked-artifacts")
    await expect(store.write("escape.md", { name: "Escape", description: "Bad.", content: "No" })).rejects.toThrow("Symbolic links")
  })

  test("applies add, update, move, and delete as one patch", async () => {
    const store = new ArtifactStore(await worktree())
    await store.write("one.md", { name: "One", description: "First.", content: "old" })
    await store.write("remove.md", { name: "Remove", description: "Delete me.", content: "gone" })
    const result = await store.applyPatch(`*** Begin Patch
*** Update File: one.md
*** Move to: moved.md
@@
-old
+new
*** Delete File: remove.md
*** Add File: three.md
+---
+name: Three
+description: Third artifact.
+---
+
+created
*** End Patch`)
    expect(result).toEqual({ added: ["moved.md", "three.md"], modified: [], deleted: ["one.md", "remove.md"] })
    expect((await store.read("moved.md")).content).toBe("new\n")
    expect((await store.read("three.md")).name).toBe("Three")
    await expect(store.read("one.md")).rejects.toThrow()
  })

  test("rejects an invalid multi-file patch without changing any file", async () => {
    const root = await worktree()
    const store = new ArtifactStore(root)
    await store.write("one.md", { name: "One", description: "First.", content: "old" })
    const before = await readFile(join(root, ".opencode/artifacts/one.md"), "utf8")
    await expect(store.applyPatch(`*** Begin Patch
*** Update File: one.md
@@
-old
+changed
*** Add File: invalid.md
+no frontmatter
*** End Patch`)).rejects.toThrow("frontmatter")
    expect(await readFile(join(root, ".opencode/artifacts/one.md"), "utf8")).toBe(before)
  })

  test("validates duplicate names against the final patched state", async () => {
    const store = new ArtifactStore(await worktree())
    await store.write("one.md", { name: "One", description: "First.", content: "old" })
    await expect(store.applyPatch(`*** Begin Patch
*** Add File: duplicate.md
+---
+name: one
+description: Duplicate.
+---
+
+body
*** End Patch`)).rejects.toThrow("duplicated")
  })

  test("can repair a malformed artifact through a patch", async () => {
    const root = await worktree()
    const store = new ArtifactStore(root)
    await mkdir(join(root, ".opencode/artifacts"), { recursive: true })
    await writeFile(join(root, ".opencode/artifacts/broken.md"), "broken")
    await store.applyPatch(`*** Begin Patch
*** Update File: broken.md
@@
-broken
+---
+name: Repaired
+description: Repaired artifact.
+---
+
+body
*** End Patch`)
    expect((await store.read("broken.md")).name).toBe("Repaired")
  })
})

describe("patch parser", () => {
  test("rejects empty and malformed patches", () => {
    expect(() => parsePatch("not a patch")).toThrow("markers")
    expect(() => parsePatch("*** Begin Patch\n*** End Patch")).toThrow("operation")
  })

  test("supports OpenCode's end-of-file marker", async () => {
    const store = new ArtifactStore(await worktree())
    await store.write("note.md", { name: "Note", description: "A note.", content: "first\nlast\n" })
    await store.applyPatch(`*** Begin Patch
*** Update File: note.md
@@
-last
+final
*** End of File
*** End Patch`)
    expect((await store.read("note.md")).content).toBe("first\nfinal\n")
  })
})

describe("OpenCode tools", () => {
  async function pluginTools(root: string) {
    const hooks = await OpenCodeArtifacts({ worktree: root } as never)
    return hooks.tool!
  }

  function context(root: string) {
    const requests: Array<{ permission: string; patterns: string[] }> = []
    return {
      requests,
      value: {
        worktree: root,
        directory: root,
        sessionID: "session",
        messageID: "message",
        agent: "build",
        abort: new AbortController().signal,
        metadata() {},
        async ask(input: { permission: string; patterns: string[] }) {
          requests.push(input)
        },
      },
    }
  }

  test("registers six namespaced tools", async () => {
    const registered = await pluginTools(await worktree())
    expect(Object.keys(registered).sort()).toEqual([
      "artifact_edit",
      "artifact_list",
      "artifact_patch",
      "artifact_read",
      "artifact_remove",
      "artifact_write",
    ])
  })

  test("lists only metadata, reports invalid files, and paginates", async () => {
    const root = await worktree()
    const registered = await pluginTools(root)
    const ctx = context(root)
    await registered.artifact_write!.execute({ path: "a.md", name: "Alpha", description: "First artifact.", content: "SECRET BODY" }, ctx.value as never)
    await mkdir(join(root, ".opencode/artifacts"), { recursive: true })
    await writeFile(join(root, ".opencode/artifacts/broken.md"), "invalid")
    const output = await registered.artifact_list!.execute({ offset: 1, limit: 2 }, ctx.value as never)
    const parsed = JSON.parse(output as string)
    expect(parsed.total).toBe(2)
    expect(parsed.artifacts[0]).toEqual({ path: "a.md", name: "Alpha", description: "First artifact." })
    expect(parsed.artifacts[1].invalid).toContain("frontmatter")
    expect(output).not.toContain("SECRET BODY")
    expect(ctx.requests.map((request) => request.permission)).toEqual(["edit", "read"])
  })

  test("reads numbered body pages without counting frontmatter", async () => {
    const root = await worktree()
    const registered = await pluginTools(root)
    const ctx = context(root)
    await registered.artifact_write!.execute({ path: "note.md", name: "Note", description: "A note.", content: "line one\nline two\nline three" }, ctx.value as never)
    const output = await registered.artifact_read!.execute({ path: "note.md", offset: 2, limit: 1 }, ctx.value as never)
    expect(output).toContain("2: line two")
    expect(output).not.toContain("1: name:")
    expect(output).toContain("Use offset=3")
  })
})

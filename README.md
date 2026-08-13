# opencode-artifacts

Token-efficient artifact CRUD tools for [OpenCode](https://opencode.ai).

`opencode-artifacts` keeps generated documents in a dedicated project directory and lets models list, read, write, edit, patch, and remove them without rewriting complete files. Every artifact has a short name and description, so a model can select the right artifact with `artifact_list` before loading its body.

## Requirements

- OpenCode `1.18.0` or later in the `1.x` series
- Bun

## Installation

Install the latest version directly from this GitHub repository with Bun's Git specifier:

```bash
opencode plugin git+https://github.com/karlrobeck/opencode-artifacts.git
```

Pin a release tag for reproducible installations:

```bash
opencode plugin git+https://github.com/karlrobeck/opencode-artifacts.git#v0.1.0
```

For local development, reference this checkout directly in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-artifacts/index.ts"]
}
```

Quit and restart OpenCode after changing its plugin configuration.

### Artifact Directory

Artifacts are stored recursively under `.opencode/artifacts/` at the active worktree root by default. Configure another worktree-relative subdirectory with the plugin's `directory` option:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-helicone-session",
    [
      "git+https://github.com/karlrobeck/opencode-artifacts.git#v0.1.0",
      {
        "directory": "docs/artifacts"
      }
    ]
  ]
}
```

Plugin options belong to the same two-item array as `opencode-artifacts`. Other plugins remain separate entries and do not receive the `directory` option.

The configured directory must be relative and remain inside the worktree. Absolute paths, path traversal, and symbolic links in artifact paths are rejected.

## Artifact Format

Every artifact is a UTF-8 text file with required YAML frontmatter:

```md
---
name: API design
description: Documents public API resources and error conventions.
---

# API Design

Artifact body...
```

The `name` and `description` values are trimmed, non-empty, single-line strings. Names are limited to 120 characters, descriptions to 500 characters, and names must be unique across the store after case-insensitive Unicode normalization.

`artifact_write` accepts metadata as structured arguments and creates the frontmatter. Models should pass only the artifact body in `content`.

## Tools

The plugin registers six namespaced tools alongside OpenCode's built-in tools.

### `artifact_list`

Lists artifact metadata recursively without returning artifact bodies. This is the preferred first call when a model needs to select an existing artifact.

```json
{
  "offset": 1,
  "limit": 100
}
```

Results are sorted by relative path and contain `path`, `name`, and `description`. Files with invalid frontmatter remain visible as path-specific validation errors. `offset` is 1-based and both pagination arguments are optional.

### `artifact_write`

Creates an artifact and its canonical frontmatter:

```json
{
  "path": "design/api.md",
  "name": "API design",
  "description": "Documents public API resources and error conventions.",
  "content": "# API Design\n\nArtifact body..."
}
```

Writing an existing path fails by default. Set `"overwrite": true` only for an intentional full replacement. Name uniqueness is checked before writing.

### `artifact_read`

Returns metadata followed by numbered artifact body lines:

```json
{
  "path": "design/api.md",
  "offset": 1,
  "limit": 2000
}
```

Frontmatter does not count toward body line numbers. Long artifacts can be read in pages, and output is bounded to avoid unexpectedly large context usage.

### `artifact_edit`

Updates metadata, replaces exact body text, or performs both in one call:

```json
{
  "path": "design/api.md",
  "description": "Documents versioned API resources and error conventions.",
  "oldString": "Version one",
  "newString": "Version two"
}
```

Body replacement never modifies frontmatter. A body match must be unique unless `"replaceAll": true` is supplied. `name` and `description` are optional, but the call must include a metadata change or both `oldString` and `newString`.

### `artifact_patch`

Applies an OpenCode-style patch to one or more artifacts:

```text
*** Begin Patch
*** Add File: architecture/cache.md
+---
+name: Cache architecture
+description: Describes cache ownership and invalidation.
+---
+
+# Cache Architecture
*** Update File: design/api.md
@@
-Version one
+Version two
*** Update File: drafts/old.md
*** Move to: published/final.md
@@
-Draft
+Final
*** Delete File: obsolete.md
*** End Patch
```

The tool supports add, update, move, delete, and multiple operations in one patch. Paths are relative to the artifact directory. The complete final store is validated before mutation, including frontmatter and globally unique names, so a failed patch leaves existing artifacts unchanged. A patch can also repair a malformed artifact if the final content is valid.

### `artifact_remove`

Permanently removes one artifact:

```json
{
  "path": "obsolete.md"
}
```

Missing paths and directories are rejected.

## Permissions

`artifact_list` and `artifact_read` request OpenCode's standard `read` permission. `artifact_write`, `artifact_edit`, `artifact_patch`, and `artifact_remove` request the standard `edit` permission using worktree-relative artifact paths.

Existing OpenCode permission rules therefore apply without introducing custom permission keys:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow",
    "edit": "ask"
  }
}
```

## Safety

- Artifact and configured directory paths cannot escape the active worktree.
- Symbolic links are not followed within artifact paths.
- Existing artifacts require explicit overwrite intent.
- Exact edits reject missing or ambiguous body matches.
- Patch operations are parsed and validated before any artifact is replaced.
- Malformed external files are reported by `artifact_list` rather than silently hidden.

## Development

```bash
bun install
bun test
bun run typecheck
```

## License

[MIT](LICENSE) Copyright (c) 2026 Karl Robeck Alferez.

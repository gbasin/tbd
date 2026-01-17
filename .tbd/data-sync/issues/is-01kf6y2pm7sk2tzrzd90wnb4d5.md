---
created_at: 2026-01-17T21:34:16.710Z
dependencies: []
id: is-01kf6y2pm7sk2tzrzd90wnb4d5
kind: task
labels: []
priority: 2
status: open
title: Add displayId() helper methods to CommandContext
type: is
updated_at: 2026-01-17T21:34:16.710Z
version: 1
---
Currently, display ID formatting logic is repetitive across commands:

```ts
const showDebug = this.ctx.debug;
const config = await readConfig(process.cwd());
const prefix = config.display.id_prefix;
const displayId = showDebug
  ? formatDebugId(issue.id, mapping, prefix)
  : formatDisplayId(issue.id, mapping, prefix);
```

This should be simplified to:

```ts
const displayId = context.displayId(issue.id);
// or for debug mode:
const displayId = context.displayId(issue.id, context.debug);
```

Once the CommandContext is a clean, commonly initialized standalone object, these should be obvious methods like:
- `context.displayId(issueId)` - returns formatted display ID respecting debug mode
- `context.formatId(issueId, options)` - with explicit options

Depends on: bd-7sjq (CommandContext consolidation)
References: packages/tbd-cli/src/cli/lib/format.ts

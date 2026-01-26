---
created_at: 2026-01-26T17:44:29.124Z
dependencies:
  - target: is-01kfxpgdqq90dysx2m1kw2z5e5
    type: blocks
  - target: is-01kfxpge0mjrxrpn3qq6gqx607
    type: blocks
id: is-01kfxpgd65nr8v0qe6drr1asfz
kind: task
labels: []
parent_id: is-01kfxpf476jcxq5m1d3g4d3nc7
priority: 2
status: open
title: "Phase 4: Integrate doc sync into setup command"
type: is
updated_at: 2026-01-26T17:45:09.481Z
version: 3
---
Modify setup.ts to generate default doc_cache config on fresh setup, call DocSync.sync(), and report sync results. See plan-2026-01-26-configurable-doc-cache-sync.md Phase 4.

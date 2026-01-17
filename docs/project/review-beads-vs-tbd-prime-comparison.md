# Prime Command & Session Management Comparison: Beads vs tbd

**Date**: 2026-01-17
**Purpose**: Review and compare prime command implementations to ensure tbd is clean, focused, and has equivalent functionality.

---

## Executive Summary

**tbd's approach is cleaner and better.** Beads has accumulated complexity with 5+ conditional code paths for session close protocols. tbd has one clear protocol that works in all cases.

**Recommendation**: Keep tbd simple. Add minimal optional features only if truly needed.

---

## Side-by-Side Comparison

### Prime Output Size

| Tool | MCP Mode | CLI Mode | Custom Override |
|------|----------|----------|-----------------|
| Beads | ~50 tokens (minimal) | ~1-2k tokens | ✅ PRIME.md |
| tbd | N/A | ~1k tokens | ✅ PRIME.md |

### Session Close Protocol

**Beads has 5 different protocols based on context:**

1. **Stealth/Local-only mode**: `bd sync --flush-only`
2. **Daemon auto-syncing**: git status → git add → git commit → git push (no bd sync)
3. **Ephemeral branch**: git status → git add → bd sync --from-main → git commit (no push)
4. **No-push mode**: git status → git add → bd sync → git commit (manual push)
5. **Standard mode**: git status → git add → bd sync → git commit → bd sync → git push

**tbd has 1 protocol:**

```
[ ] 1. git status              (check what changed)
[ ] 2. git add <files>         (stage code changes)
[ ] 3. tbd sync                (commit tbd changes)
[ ] 4. git commit -m "..."     (commit code)
[ ] 5. tbd sync                (commit any new tbd changes)
[ ] 6. git push                (push to remote)
```

### Complexity Analysis

| Feature | Beads | tbd | Assessment |
|---------|-------|-----|------------|
| MCP detection | ✅ | ❌ | Nice-to-have but adds complexity |
| Daemon detection | ✅ | N/A | Not needed (no daemon) |
| Ephemeral branch detection | ✅ | ❌ | Edge case, unclear value |
| No-push config | ✅ | ❌ | Could add if needed |
| Stealth mode | ✅ | ❌ | Niche use case |
| Redirect notice | ✅ | N/A | Not applicable |
| Custom PRIME.md | ✅ | ✅ | Both support |

---

## Code Quality Comparison

### Beads prime.go (432 lines)

```go
// 5 conditional code paths
if stealthMode || localOnly {
    closeProtocol = `[ ] bd sync --flush-only`
} else if autoSync && !ephemeral && !noPush {
    closeProtocol = `[ ] 1. git status...` // daemon mode
} else if ephemeral {
    closeProtocol = `[ ] 1. git status...` // ephemeral mode
} else if noPush {
    closeProtocol = `[ ] 1. git status...` // no-push mode
} else {
    closeProtocol = `[ ] 1. git status...` // standard mode
}
```

**Problems with this approach:**
- 5 different protocols are confusing
- Agent may not know which mode it's in
- Each mode has different step counts
- Testing complexity increases
- Documentation must explain all modes

### tbd prime.ts (132 lines)

```typescript
const PRIME_OUTPUT = `# tbd Workflow Context
...
[ ] 1. git status
[ ] 2. git add <files>
[ ] 3. tbd sync
[ ] 4. git commit -m "..."
[ ] 5. tbd sync
[ ] 6. git push
`;
```

**Benefits:**
- One protocol to learn
- Always correct
- Easy to test
- Simple documentation
- Agents never confused

---

## Feature Parity Check

### Core Features

| Feature | Beads | tbd | Notes |
|---------|-------|-----|-------|
| SessionStart hook | ✅ | ✅ | Same |
| PreCompact hook | ✅ | ✅ | Same |
| Custom override | ✅ | ✅ | Same (.beads/PRIME.md vs .tbd/PRIME.md) |
| Silent exit if not init | ✅ | ✅ | Same |
| Command reference | ✅ | ✅ | Same |
| Workflow examples | ✅ | ✅ | Same |
| bd vs TodoWrite guidance | ✅ | ✅ | Same |

### Advanced Features (Beads only)

| Feature | Needed in tbd? | Recommendation |
|---------|----------------|----------------|
| MCP mode detection | Maybe | Consider adding minimal output option |
| Daemon status check | No | No daemon in tbd |
| Ephemeral branch | No | Edge case, simple protocol works |
| Stealth mode | No | Use custom PRIME.md if needed |
| No-push config | Maybe | Could add config option |

---

## Documentation Comparison

### Beads Documentation

**Pros:**
- Extensive SKILL.md with resource index
- ADR for key decisions
- Deep-dive resources for advanced features

**Cons:**
- 16 resource files in skills/beads/resources/
- Complex to navigate
- Information scattered

### tbd Documentation

**Pros:**
- Single comprehensive tbd-docs.md (914 lines)
- Clear structure with examples
- Quick reference at top
- Agent-specific section

**Cons:**
- Could use a quick-start section
- Dependency semantics could be clearer

---

## Identified Issues in tbd

### 1. Dependency Command Semantics

Current documentation (tbd-docs.md:318-319):
```
tbd dep add <id> <target>` - Add a blocks dependency (target blocks id)
```

This is backwards from user expectation. Most users think:
- `dep add A B` means "A depends on B" (B blocks A)
- Current: `dep add A B` means "B depends on A" (A blocks B)

**Recommendation**: Either fix the semantics or add clearer examples showing both directions.

### 2. Prime Output Could Be More Concise

The current prime output is ~1k tokens. Consider:
- Adding `--brief` flag for ~200 token output
- MCP detection for automatic brief mode

### 3. Missing Workflow: Multiple Issue Creation

The prime output mentions creating dependent work but doesn't show parallel creation:
```bash
# Current
tbd create "Implement feature X" --type feature
tbd create "Write tests for X" --type task
tbd dep add <tests-id> <feature-id>

# Could add note about efficiency
# Tip: Create multiple issues in parallel when possible
```

---

## Recommendations

### Keep (No Change Needed)

1. **Single session close protocol** - This is cleaner than Beads' 5 modes
2. **Custom PRIME.md override** - Gives users full control
3. **Silent exit on non-init** - Good for hooks
4. **Command reference in prime** - Essential for context recovery

### Consider Adding

1. **Brief mode flag** (`tbd prime --brief`)
   - ~200 tokens output for contexts where full reference not needed
   - Could auto-detect MCP but simpler to just use flag

2. **Config for no-push** (`settings.no_push: true`)
   - Some users want manual push control
   - Simple to implement

### Document Better

1. **Dependency direction** - Add explicit examples showing which issue gets blocked
2. **Why one protocol** - Explain that tbd intentionally simplified from Beads' 5 modes
3. **PRIME.md customization** - Show example custom prime file

### Avoid Adding

1. **Daemon detection** - No daemon, not needed
2. **Ephemeral branch detection** - Edge case, standard protocol works
3. **Stealth mode** - Users can customize with PRIME.md
4. **MCP auto-detection** - Adds complexity, use --brief flag instead

---

## Conclusion

tbd's prime command is **already better designed** than Beads'. The single protocol is clearer, the code is simpler, and agents will have less confusion.

The main improvements needed are:
1. Fix or clarify dependency command semantics
2. Optionally add `--brief` flag for minimal output
3. Better documentation of the intentional simplification

**Do not copy Beads' complexity.** The 5-mode session close protocol is a mistake that tbd correctly avoided.

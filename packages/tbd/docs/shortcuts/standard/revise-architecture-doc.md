---
title: Revise Architecture Doc
description: Revise an existing architecture document to reflect current system state
author: Joshua Levy (github.com/jlevy) with LLM assistance
---
We track work as beads using tbd.
Run `tbd` for more on using tbd and current status.

## Instructions

Revise an existing architecture document to reflect the current state of the system.

1. **Identify the architecture doc to update**:
   - The user should specify which architecture doc to update
   - Architecture docs are in `docs/project/architecture/`

2. **Review the current doc**:
   - Read the existing architecture document
   - Note the scope, components, and design decisions documented

3. **Review the current codebase**:
   - Compare the documented architecture against the actual implementation
   - Look for:
     - New components or modules added since the doc was written
     - Removed or deprecated components
     - Changed interfaces, APIs, or data flows
     - Updated dependencies or technology choices
     - Modified design decisions

4. **Update the document**:
   - Update diagrams if provided (describe changes in text if you cannot modify
     diagrams)
   - Update component descriptions to match current implementation
   - Update interface/API documentation
   - Update data flow descriptions
   - Mark deprecated sections or remove obsolete content
   - Add any new architectural decisions made since the last update
   - Update the date in the filename if significant changes were made

5. **Validate accuracy**:
   - Cross-reference key code paths mentioned in the doc
   - Verify file paths and module names are current
   - Check that external dependencies listed are still in use

6. **Summarize changes**:
   - Provide a brief summary of what was updated
   - Note any areas that need further review or are unclear

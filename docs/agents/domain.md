# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root if it exists. It points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **Relevant per-context `CONTEXT.md` files** for the app, package, or function codebase being touched.
- **`docs/adr/`** for system-wide decisions that touch the area you're about to work in.
- **Context-scoped `docs/adr/` directories** near the relevant context when they exist.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill, reached via `/grill-with-docs` and `/improve-codebase-architecture`, creates them lazily when terms or decisions actually get resolved.

## File structure

This repo uses a multi-context layout. The root map is the index; each context owns its own glossary and may own ADRs close to the code it governs.

```text
/
├── CONTEXT-MAP.md
├── docs/adr/                       # system-wide decisions
├── apps/
│   ├── web/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/
│   └── process-audio/
│       ├── CONTEXT.md
│       └── docs/adr/
├── packages/
│   ├── contracts/
│   │   └── CONTEXT.md
│   └── shared/
│       └── CONTEXT.md
├── functions/
│   ├── CONTEXT.md
│   └── docs/adr/
├── functions-core/
│   └── CONTEXT.md
├── functions-media/
│   └── CONTEXT.md
├── functions-image/
│   └── CONTEXT.md
└── functions-integrations/
    └── CONTEXT.md
```

The map and context files may not exist yet. Create them lazily only when domain terms or decisions are clarified.

## Use the glossary's vocabulary

When your output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined in the relevant `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use, or there's a real gap to note for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) - but worth reopening because..._

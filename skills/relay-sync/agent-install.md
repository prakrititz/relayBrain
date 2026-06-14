# Relay agent hooks (automatic)

**Do not follow these manually.** Run:

```bash
npx relay-os init
```

That patches all agent files with a `<!-- BEGIN:relay-os -->` block and installs Cursor skill + rule.

Re-apply after Relay upgrade:

```bash
npx relay-os install
```

Agents: read `.relay/AGENT_BOOTSTRAP.md` every session.

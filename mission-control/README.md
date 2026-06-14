# Mission Control

Next.js dashboard for Relay — activity timeline, IR markdown, multi-project registry.

## With Relay CLI

```bash
relay serve
```

Opens **http://localhost:6374** (UI) and **http://localhost:3001** (API). No login required.

## Standalone

```bash
npm install
npm run dev
```

Set `NEXT_PUBLIC_RELAY_URL=http://localhost:3001` if the Relay API runs on a different host or port.

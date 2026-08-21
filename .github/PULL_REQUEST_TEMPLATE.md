## Summary

<!-- What and why — 1–3 bullets. Link issues if any. -->

-

## Test plan

- [ ] `npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build`
- [ ] If OAuth/AS touched: confirm consent hop still works (`test:e2e`)
- [ ] If body limits / Node adapter touched: oversized `Content-Length` → 413 over a real socket
- [ ] If public types / exports touched: skim `src/server.ts` for accidental surface changes

## Security checklist (auth / OAuth changes)

- [ ] No new way to skip consent for an unregistered / DCR-only `client_id`
- [ ] No new distinguishable `invalid_client` descriptions at `/token` or `/revoke`
- [ ] Secrets stay out of logs, audit reasons, and tool results
- [ ] Request bodies remain capped (1 MiB `/mcp`, 64 KiB OAuth)

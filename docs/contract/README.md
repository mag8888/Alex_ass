# Wave Match × Wave Chat — Integration Contract

This folder is the **single source of truth** for the API contract between
**Wave Match** (the platform) and **Wave Chat** (the Telegram AI assistant).

**Live URL** (raw, both teams + AI agents read this):
```
https://raw.githubusercontent.com/mag8888/AI_ASS/main/docs/contract/openapi.yaml
```

## Files

| File | Purpose |
|------|---------|
| [`openapi.yaml`](./openapi.yaml) | OpenAPI 3.1 spec for both directions: WM REST API + WC webhook receiver |
| [`examples/`](./examples/) | Real JSON payloads (request + response + webhook events) — copy-paste-able for tests |
| [`README.md`](./README.md)        | This file |

## How to use this contract

### When building / changing code on either side
1. Read `openapi.yaml` first.
2. If your change requires a new field / endpoint / event — **DO NOT** start coding. Open a PR to this file.
3. After the spec PR is merged on both sides, then implement.
4. Bump `info.version` (semver):
   - **patch**: clarification, doc-only
   - **minor**: new optional field / new endpoint
   - **major**: breaking change (renamed field, removed endpoint, etc.)

### When you find a discrepancy between this spec and reality
- Reality is the bug. Either fix the code OR fix the spec — never let them diverge silently.
- Add a one-line entry to "Recently changed" in [`../INTEGRATION_STATUS.md`](../INTEGRATION_STATUS.md) (when that doc exists).

### When the other side asks you to add something
- Don't agree in chat. Ask them to PR `openapi.yaml`.
- This eliminates "we agreed in DM but I forgot" class of bugs.

## Quick reference for AI agents

If you're an AI agent assigned to either project, your workflow should be:

1. **Before any integration code change** — `curl -s https://raw.githubusercontent.com/mag8888/AI_ASS/main/docs/contract/openapi.yaml` to get the canonical spec.
2. **Generate or update typed clients** from this YAML. Don't hand-write structs.
3. **When adding fields** — propose a PR to this file first. Wait for human review. Then implement.
4. **When in doubt** — check `examples/` for the canonical wire format.

## Tooling suggestions (optional)

- **TypeScript types**: `npx openapi-typescript docs/contract/openapi.yaml -o src/wm-types.ts`
- **Go client**: `oapi-codegen -package wm openapi.yaml > wm/client.go`
- **Validate spec**: `npx @apidevtools/swagger-cli validate openapi.yaml`
- **Visual preview**: paste into [editor.swagger.io](https://editor.swagger.io)

## Glossary

- **WC** = Wave Chat = this repo (`mag8888/AI_ASS`), the Telegram AI assistant
- **WM** = Wave Match = the platform exposing `/api/wm/*`
- **ETag**: Wave Match returns one with every `GET /users/:id`. Clients echo it as `If-Match` on `PATCH` for optimistic concurrency. Mismatch → `412 Precondition Failed`.
- **HMAC**: webhook deliveries are signed `sha256_hex(secret, "${X-WC-Timestamp}.${rawBody}")`. Timestamp is **Unix epoch seconds**.

## Versioning policy

| Action | Effect on `info.version` |
|--------|--------------------------|
| Typo / clarification | patch (`1.1.2` → `1.1.3`) |
| Add optional field, new event, new endpoint | minor (`1.1.2` → `1.2.0`) |
| Rename / remove field, change type, breaking semantics | major (`1.1.2` → `2.0.0`) |

A major bump requires both sides to deploy in lockstep — coordinate in `INTEGRATION_STATUS.md` first.

---

**Currently at version**: see top of [`openapi.yaml`](./openapi.yaml).

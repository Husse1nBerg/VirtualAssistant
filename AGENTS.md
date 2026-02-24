# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Single-service Node.js/TypeScript app: an AI voice assistant for missed calls using Twilio + Deepgram + Claude. Express HTTP server + WebSocket on port 3000. SQLite via Prisma ORM (file-based, no separate DB process). See `README.md` for full architecture and API endpoints.

### Common commands

| Task | Command |
|------|---------|
| Dev server | `npm run dev` (tsx watch mode, port 3000) |
| Tests | `npm test` (vitest) |
| Typecheck | `npm run typecheck` (tsc --noEmit) |
| Build | `npm run build` (tsc) |
| DB generate | `npx prisma generate` |
| DB push | `npx prisma db push` |
| DB studio | `npm run db:studio` |

### Caveats

- **ESLint is not installed.** The `npm run lint` script exists in `package.json` but ESLint is not in `devDependencies` and there is no config file. Use `npm run typecheck` as the primary static analysis check.
- **`.env` is required to start the dev server.** The app validates env vars via Zod on startup (`src/config/env.ts`). Copy `.env.example` to `.env` and fill in placeholder values. For local dev without real API keys, use syntactically valid placeholders (e.g., `TWILIO_ACCOUNT_SID` must start with `AC`, phone numbers must start with `+`).
- **Prisma client must be generated** before the server or tests will work. Run `npx prisma generate` after `npm install`. Also run `DATABASE_URL=file:./dev.db npx prisma db push` to create the SQLite database if it doesn't exist.
- **Tests mock all external services** and do not require real API keys or network access. `npm test` works with no env configuration.
- **The dev server (`npm run dev`) uses `tsx watch`**, which auto-reloads on file changes. However, changes to Prisma schema require running `npx prisma generate` and `npx prisma db push` manually.

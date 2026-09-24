# Bill Agent for Odoo

Snap or scan a supplier bill (Arabic, English or mixed), let a free ($0) AI model on OpenRouter read it, check the debit/credit preview, and send it to Odoo as a **draft** with the scan attached. You post it in Odoo yourself.

```
Photo / PDF ──► AI reads vendor, lines, VAT, totals ──► you review (T-account preview) ──► Odoo draft + attachment
```

## What it does

- Reads bills in Arabic, English or French, converts Arabic-Indic digits, LBP/USD, Lebanese DD/MM dates.
- Picks the expense account for each line from **your own chart of accounts** (pulled live from Odoo), and matches the 11% VAT to your purchase tax.
- Finds the vendor in Odoo by VAT number or name; creates it if missing (configurable).
- Shows exactly how the entry will post (debits in blue, credits in red) before anything is sent.
- Three modes: **Vendor bill** (`in_invoice`), **Vendor refund** (`in_refund`), **Journal entry** (`entry`, with free debit/credit lines — switching to it converts the bill into balanced lines for you).
- Blocks duplicates (same vendor + same bill reference) and warns when the same file was already sent.
- Batch upload, camera capture on phones, drag-and-drop, paste. Photos are shrunk in the browser before upload.
- Optional auto mode: creates the draft straight away when the AI is confident and nothing needs checking.
- Optional Postgres history + it learns which account you use per vendor.

## 1. Get the keys (all free)

| What | Where |
|---|---|
| Odoo API key | Odoo → your avatar → **My Profile / Preferences → Account Security → New API Key** |
| Odoo DB name | Odoo Online: usually the subdomain (`yourcompany` for `yourcompany.odoo.com`). Self-hosted: `/web/database/selector` |
| OpenRouter key | https://openrouter.ai/keys — free account, no card needed |
| (optional) Postgres | Neon free tier, or the one in docker-compose |

### The free AI setup

- Default models: `qwen/qwen3.8-27b:free` and `dots-studio/dots-3-note-preview:free` (both read images, both $0). Free listings on OpenRouter change often — if these are ever pulled, `OPENROUTER_AUTO_DISCOVER` finds a replacement automatically.images**. `OPENROUTER_FREE_ONLY=true` guarantees a paid model is never called.
- To pin other models, list them in `OPENROUTER_MODELS` (comma-separated, each ending in `:free`), in the order you want them tried.
- Scanned PDFs are turned into an image in your browser (first 3 pages), because free vision models read images. The original PDF is still what gets attached in Odoo.
- If you see "blocks free models with your privacy settings": open https://openrouter.ai/settings/privacy and allow free endpoints.
- Limits: free models have per-minute and daily request caps set by OpenRouter (check the current numbers on openrouter.ai). The app reads 2 bills at a time to stay under the per-minute cap.
- Privacy: free providers may log or train on what you send. Don't use it for documents that must stay confidential.

## 2. Run locally with Docker

```bash
cp .env.example .env      # fill in the values
docker compose up --build
# open http://localhost:3000
```

Compose starts the app and a Postgres 16 for history. Without Docker: `npm install && npm start` (set `DATABASE_URL` or leave it empty).

## 3. Deploy to Vercel

1. Push this folder to GitHub.
2. Vercel → **Add New Project** → import the repo. Framework preset: **Other**. Leave build settings as they are (`vercel.json` handles them).
3. **Settings → Environment Variables**: add everything from `.env.example`. For history, add Neon's connection string as `DATABASE_URL` and `DATABASE_SSL=true`.
4. Deploy. Open the site, sign in with `APP_PASSWORD`.

How it maps on Vercel: `public/` is served from the CDN, and `api/index.js` runs the whole Express app as one serverless function (60 s max). Uploads are capped at 4 MB because Vercel rejects request bodies over 4.5 MB — photos are compressed in the browser, so only very large PDFs hit this.

> Vercel's free Hobby plan is meant for non-commercial use. For company use, either move to Vercel Pro or run the Docker image on any server/PC in the office.

## Project layout

```
api/index.js                 Vercel entry (exports the Express app)
src/app.js                   Express app, routes, errors
src/server.js                Local/Docker entry
src/config.js                All environment settings
src/middleware/auth.js       Password login, signed tokens
src/routes/                  auth, odoo (catalog, partner search), bills (extract, create, history)
src/services/ai/             prompt, providers (openrouter.js default, gemini.js, groq.js), normalize.js (numbers, totals, warnings)
src/services/odoo/           JSON-RPC client, catalog cache, draft creation + attachment
src/db/                      optional Postgres: history, vendor→account memory, migrations
public/                      vanilla JS frontend (app.js, ledger.js for debit/credit, image.js for photo shrinking + PDF→image, api.js)
```

## Extending it

- **Switch AI**: `AI_PROVIDER=gemini` or `groq` still work if you ever want them.
- **New AI provider**: add `src/services/ai/<name>.js` exporting `({ base64, mimeType, prompt }) => { text, model }` and register it in `src/services/ai/index.js`.
- **New document type** (expense reports, customer invoices): add a key to `MOVE_TYPES` in `src/services/odoo/bills.js` and an option in the "Record as" control.
- **New feature/tool**: add a router under `src/routes/`, mount it in `src/app.js` behind `requireAuth`.
- **Tuning extraction**: edit the rules in `src/services/ai/prompt.js` (e.g. your usual vendors, default accounts).

## Odoo notes

- Works with Odoo 16–19 (Online and self-hosted) over `/jsonrpc`. The Odoo user needs **Accounting / Billing** rights.
- Odoo has announced a newer JSON-2 external API for future versions; all Odoo calls live in `src/services/odoo/client.js`, so switching only touches that file.
- A currency that isn't active in Odoo (e.g. LBP) falls back to the company currency with a warning — activate it under Accounting → Configuration → Currencies.
- Multi-company: set `ODOO_COMPANY_ID`.

## Troubleshooting

| Message | Fix |
|---|---|
| `Odoo rejected the login` | Wrong DB name, username (it's your login email) or API key |
| `Free AI limit reached` | Per-minute or daily free cap; wait and retry |
| `All free models failed` | The message lists each model's error; pin a working one in `OPENROUTER_MODELS` |
| Top bar shows "Odoo unreachable" | Hover it for the exact error |

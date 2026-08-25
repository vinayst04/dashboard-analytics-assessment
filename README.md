# Dashboard

Dashboard is a full-stack restaurant sales analytics application built for the Software Developer Intern technical assessment.

Production: https://burrito-insights.vercel.app

## Features

- KPI cards for revenue, orders, items sold, and average order value
- Inclusive date filtering with outlet, category, order type, and payment filters
- Revenue, category, outlet, item, channel, and payment visualizations
- Cross-filtering by selecting chart or table values
- Per-chart filter clearing, chart expansion, tooltips, hover guides, and loading states
- CSV export for the active page output
- Detailed Insights workspace with drag-and-drop Rows, Columns, Filters, and Values wells
- Pivot analysis using up to four dimensions and revenue, orders, units, or average order value
- Drill down and back up through Outlet to Category to Product and Year to Month to Week to Day
- Chart compatibility rules that prevent invalid time-series pie and donut charts
- Email and password authentication with PostgreSQL-backed accounts
- Google OAuth sign-in
- Gemini data assistant and AI-generated dashboards using approved data-backed visualizations
- Responsive desktop and mobile layouts
- Vercel deployment configuration with the API and frontend served from one project

## Technology

- Frontend: React, TypeScript, Vite, Recharts, Lucide
- Backend: Python, FastAPI, SQLAlchemy
- Database: PostgreSQL with Psycopg
- Authentication: JWT sessions, email/password, and Google OAuth
- AI: Google Gemini through the backend only
- Hosting: Vercel

PostgreSQL was selected over MySQL because it provides strong date aggregation, analytical SQL, indexing, and managed cloud options. The application was developed with Aiven PostgreSQL, but the connection string also works with compatible PostgreSQL providers such as Neon or Supabase.

## Data model and calculations

The supplied workbook is imported into a `sales` table in PostgreSQL. The browser receives aggregate results rather than the complete source dataset.

- Revenue: `Price * Quantity`
- Orders: distinct `BillNo` values
- Items sold: sum of `Quantity`
- Average order value: revenue divided by distinct orders
- Dashboard date ranges are inclusive

The source workbook is intentionally excluded from Git because it is an input dataset, not application source code. Place it at `data/data.xlsx` when importing locally.

## Local setup

Requirements:

- Node.js 20 or newer
- Python 3.12 or newer
- PostgreSQL 15 or newer, locally or through a managed provider

1. Create and activate the Python environment:

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL` and `JWT_SECRET`.

3. Install frontend dependencies:

   ```powershell
   npm install
   ```

4. Import the workbook into an empty database:

   ```powershell
   .\.venv\Scripts\python.exe -m scripts.import_data
   ```

5. Verify the imported data:

   ```powershell
   .\.venv\Scripts\python.exe -m scripts.verify_import
   ```

6. Start the API and frontend:

   ```powershell
   npm run dev
   ```

The frontend runs at `http://127.0.0.1:5173` and the API runs at `http://127.0.0.1:8000`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string with SSL for a cloud database |
| `JWT_SECRET` | Authentication | Long random secret used to sign authentication tokens |
| `GOOGLE_CLIENT_ID` | Google sign-in | OAuth web application client ID |
| `GOOGLE_CLIENT_SECRET` | Google sign-in | OAuth web application client secret |
| `GOOGLE_REDIRECT_URI` | Google sign-in | Callback URL for the active environment |
| `APP_BASE_URL` | Google sign-in | Frontend URL used after authentication |
| `GEMINI_API_KEY` | AI features | Google AI Studio API key |
| `FRONTEND_ORIGIN` | Local development | Usually `http://localhost:5173` |

Never commit `.env`, database URLs, OAuth secrets, Gemini keys, JWT secrets, or Vercel environment files. Configure secrets in the local `.env` file and in Vercel Project Settings or with `vercel env`. The repository does not use GitHub Actions to deploy or access production secrets.

## Google OAuth setup

Create a Web application OAuth client in Google Cloud Console. Add the following authorized redirect URI for the environment being used:

```text
http://127.0.0.1:8000/api/auth/google/callback
https://burrito-insights.vercel.app/api/auth/google/callback
```

Set the client ID, client secret, callback URL, and application base URL as environment variables. Add the local Google account as a test user while the OAuth consent screen is in testing mode.

## Gemini data boundary

Gemini is called only by the backend. The backend sends computed metrics and compact chart summaries, not the raw workbook or database credentials. The prompt instructs the model to answer from the supplied filtered data, avoid unsupported claims, and return a safe fallback when it cannot answer. AI dashboard generation is limited to approved sources and visual types.

## Verification

The import reconciliation script compares the source workbook with PostgreSQL for row count, units, and revenue. The current verified values are:

| Check | Value |
| --- | ---: |
| Source and database rows | 300,000 |
| Source and database units | 434,448 |
| Source and database revenue | INR 69,480,952 |
| Production date range | 2025-06-17 to 2026-06-16 |
| Production outlets | 6 |
| Production categories | 7 |

Run the frontend build before submitting changes:

```powershell
npm run build
python -m py_compile api/index.py
```

## Deployment

GitHub and Vercel are intentionally separate. GitHub stores the source repository; Vercel is deployed independently through the Vercel CLI.

```powershell
npm run build
vercel login
vercel env add DATABASE_URL production
vercel env add JWT_SECRET production
vercel env add GOOGLE_CLIENT_ID production
vercel env add GOOGLE_CLIENT_SECRET production
vercel env add GOOGLE_REDIRECT_URI production
vercel env add APP_BASE_URL production
vercel env add GEMINI_API_KEY production
vercel --prod
```

The repository does not contain production credentials or the source workbook.

## Project structure

```text
api/index.py       FastAPI application and database queries
src/App.tsx        React application and page workflows
src/styles.css     Application styling and responsive layout
scripts/import_data.py
scripts/verify_import.py
data/data.xlsx     Local-only source workbook, ignored by Git
vercel.json        Vercel build and API rewrite configuration
```

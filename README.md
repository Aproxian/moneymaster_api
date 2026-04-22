# MoneyMASTER API

REST API for the **MoneyMASTER** mobile app: multi-account ledgers, categories, transactions, investments, transfers, and user auth (JWT access + refresh rotation).

**Repository:** [github.com/Aproxian/moneymaster_api](https://github.com/Aproxian/moneymaster_api)

## Requirements

- **Node.js** 20+ (recommended)
- **MySQL** or **MariaDB** (Prisma `provider = "mysql"`)
- **npm**

## Quick start

1. **Clone**

   ```bash
   git clone https://github.com/Aproxian/moneymaster_api.git
   cd moneymaster_api
   ```

2. **Install**

   ```bash
   npm install
   ```

3. **Configure environment**

   Create a `.env` file in the project root (never commit it). Set at least:

   - `DATABASE_URL` — MySQL/MariaDB URL for Prisma CLI (`mysql://USER:PASSWORD@HOST:3306/DBNAME`)
   - `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` — used at runtime by the API
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — use long random values in production

   See **QUICKSTART_PRISMA.md** for a fuller variable list (Twelve Data, optional `PORT`, `ADMIN_EMAIL`, etc.).

   *Example*
   ```bash
   DATABASE_URL="mysql://username:password@host:port/dbname"
   JWT_ACCESS_SECRET="SECRET"
   JWT_REFRESH_SECRET="SECRETER"
   PRISMA_CLIENT_ENGINE_TYPE=binary
   NODE_ENV="development" (NODE_ENV="production")
   
   DATABASE_HOST=host
   DATABASE_PORT=port
   DATABASE_NAME=db_name
   DATABASE_USER=username
   DATABASE_PASSWORD=db_pass
   
   ADMIN_EMAIL="youremail@mail.com"
   TWELVEDATA_API_KEY="twelvedata_key_api"
   TWELVEDATA_BASE_URL="https://api.twelvedata.com"
   ```

5. **Database**

   Create the database (e.g. `moneymaster_dev`), then:

   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```

   For local iteration you can use `npm run prisma:migrate` (`prisma migrate dev`) instead of `deploy`.

6. **Run**

   ```bash
   npm start
   ```

   Default: [http://localhost:3000](http://localhost:3000) (override with `PORT` in `.env`).

   Watch mode:

   ```bash
   npm run dev
   ```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_NAME` | Runtime DB connection (MariaDB adapter) |
| `DATABASE_URL` | Prisma migrations / `prisma studio` (MySQL URL) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Sign access and refresh tokens |
| `REFRESH_TTL_DAYS` | Refresh session lifetime (1–365, default 90) |
| `ADMIN_EMAIL` | Optional; grants admin-only tooling when it matches the user’s email |
| `PORT` | HTTP port (default 3000) |

## API surface (high level)

Mounted in `src/app.js`:

| Prefix | Description |
|--------|-------------|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` | Auth |
| `GET /me`, `PATCH /me`, `DELETE /me` | Current user profile & soft-delete |
| `GET /accounts`, `POST /accounts`, `GET/PATCH/DELETE /accounts/:accountId` | Accounts & membership |
| `GET/POST …/categories`, watchlist | Categories |
| `GET/POST …/transactions`, revoke | Manual income/expense |
| `POST …/investments` | Investment buys |
| `GET …/instruments/:id/summary`, `POST …/cash-out` | Instrument / cash-out |
| `GET /instruments` | Instrument search |
| `…/transfers` | Transfers between accounts |

All authenticated ledger routes expect `Authorization: Bearer <access_token>`.

## Prisma

- Schema: `prisma/schema.prisma`
- Migrations: `prisma/migrations/`

After **any** schema change:

```bash
npx prisma migrate dev    # local
npx prisma generate       # refresh client (also run if CI/deploy skips migrate)
```

## Pushing this folder to GitHub

If this directory is not yet a git repository:

```bash
cd moneymaster_api
git init
git add .
git commit -m "Initial import: MoneyMASTER API"
git branch -M main
git remote add origin https://github.com/Aproxian/moneymaster_api.git
git push -u origin main
```

If `origin` already exists, use `git remote set-url origin https://github.com/Aproxian/moneymaster_api.git` and push.

You only need **Git** installed and **write access** to the GitHub repo (HTTPS with credentials, PAT, or SSH remote).

## Security notes

- Never commit `.env` (it is gitignored).
- Use long, random JWT secrets in production.
- `helmet` and JSON body limits are configured in `src/app.js`.

## License

ISC (see `package.json`).

# Prisma + JavaScript (CommonJS) quick start

This project now runs as **plain JavaScript** using **CommonJS** (`require` / `module.exports`).

## What Prisma is (in 30 seconds)

Prisma has 3 main parts:

1. **`prisma/schema.prisma`** — your database models.
2. **Prisma CLI (`prisma`)** — creates migrations and generates a client.
3. **Prisma Client (`@prisma/client`)** — the JS library you use in your code (`prisma.user.findMany()`, etc.).

When you change `schema.prisma`, you run a migration, then Prisma generates an updated client.

## Setup

1) Put your database connection string in **`.env`** (this app uses **MySQL / MariaDB**):

```env
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/DBNAME"
```

2) Install dependencies:

```bash
npm install
```

3) Add the rest of the runtime DB fields and secrets to **`.env`** (same file as step 1):

```env
DATABASE_HOST=127.0.0.1
DATABASE_PORT=3306
DATABASE_NAME=DBNAME
DATABASE_USER=USER
DATABASE_PASSWORD=PASSWORD

JWT_ACCESS_SECRET="change_me"
JWT_REFRESH_SECRET="change_me_too"

TWELVEDATA_API_KEY="your_api_key_here"
# ADMIN_EMAIL="you@example.com"
```

4) **Local / CI:** create migrations and apply them to your dev DB:

```bash
npm run prisma:migrate
```

5) **Production server:** apply existing migrations (does not create new migration files):

```bash
npm run prisma:migrate:deploy
```

6) Generate the Prisma client (if `migrate deploy` did not already run it):

```bash
npm run prisma:generate
```

## Shared hosting (cPanel / CloudLinux) — WASM “Out of memory”

If `npm run prisma:migrate:deploy` or `npm run prisma:generate` fails with:

`RangeError: WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new instance`

then the **Prisma CLI is not broken** — the **host is capping RAM** for that process (CloudLinux **LVE** / “Max cPanel process memory”). Prisma 7’s CLI loads WebAssembly engines that need more headroom than many shared plans allow.

**What works in practice:**

1. **Ask the host** to raise **Max cPanel process memory** / LVE memory for your user (some panels expose this; often only support can change it).

2. **Run Prisma off the server**, point `DATABASE_URL` at the same production MySQL (host must allow remote connections + your IP), then upload the app **including** a Linux-generated `node_modules` (see below):
   - On your PC: `npm run prisma:migrate:deploy` and `npm run prisma:generate` with prod `DATABASE_URL`.
   - **Important:** generated **engine binaries** are OS-specific. If your laptop is **Windows**, run `migrate deploy` / `generate` in **WSL**, **Docker (Linux)**, or **GitHub Actions `ubuntu-latest`**, then deploy that `node_modules` tree (or at least `node_modules/.prisma`, `node_modules/@prisma/client`, and `node_modules/@prisma/engines` as produced on Linux).

3. **Use a VPS** or a plan without strict per-process WASM limits if you need the CLI to always run on the server.

`cross-env NODE_OPTIONS= …` does **not** fix this class of error; it is **WASM / cgroup memory**, not the old `NODE_OPTIONS` string bug.

## Run the API

```bash
npm run dev
```

Production:

```bash
npm start
```

## Where Prisma is used in the code

- `src/prisma.js` creates and exports a single Prisma client instance:

```js
const { prisma } = require("./prisma");
```

- Routes import it and call methods like:

```js
await prisma.user.findUnique({ where: { email } });
```

## Common Prisma commands

```bash
# Create a new migration after changing schema.prisma (dev machine)
npm run prisma:migrate

# Apply migrations on production
npm run prisma:migrate:deploy

# Regenerate client
npm run prisma:generate

# Open a DB UI (local only)
npx prisma studio
```

# Prisma + JavaScript (CommonJS) quick start

This project now runs as **plain JavaScript** using **CommonJS** (`require` / `module.exports`).

## What Prisma is (in 30 seconds)

Prisma has 3 main parts:

1. **`prisma/schema.prisma`** — your database models.
2. **Prisma CLI (`prisma`)** — creates migrations and generates a client.
3. **Prisma Client (`@prisma/client`)** — the JS library you use in your code (`prisma.user.findMany()`, etc.).

When you change `schema.prisma`, you run a migration, then Prisma generates an updated client.

## Setup

1) Put your database connection string in **`.env`**:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DBNAME"
```

2) Install dependencies:

```bash
npm install
```

2) Add the MySQL connection details and Prisma config variables:

```env
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/DBNAME"
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_NAME=DBNAME
DATABASE_USER=USER
DATABASE_PASSWORD=PASSWORD

# JWT secrets for auth
JWT_ACCESS_SECRET="change_me"
JWT_REFRESH_SECRET="change_me_too"

# Twelve Data (market data) API key and optional base URL
TWELVEDATA_API_KEY="your_api_key_here"
# TWELVEDATA_BASE_URL="https://api.twelvedata.com"

# Optional: email allowed to trigger /investments/refresh-daily
# ADMIN_EMAIL="you@example.com"
```

3) Create/update your database tables + generate the Prisma client:

```bash
npm run prisma:migrate
```

This will also run `prisma generate`.

## Run the API

```bash
npm run dev
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
# Create a new migration after changing schema.prisma
npx prisma migrate dev

# Just regenerate the client (if needed)
npx prisma generate

# Open a DB UI
npx prisma studio
```

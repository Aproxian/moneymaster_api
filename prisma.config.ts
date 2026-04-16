import "dotenv/config";
import { defineConfig } from "@prisma/config";

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    // Use DATABASE_URL from .env for migrations
    url: process.env.DATABASE_URL!,
  },
});


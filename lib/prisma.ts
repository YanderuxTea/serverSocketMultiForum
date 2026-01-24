import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client.ts";
import { configDotenv } from "dotenv";
import { __dirname } from "../__dirname.js";
import { join } from "node:path";
configDotenv({ path: join(__dirname, ".env") });
const connectionString = `${process.env.DATABASE_URL}`;

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

export { prisma };

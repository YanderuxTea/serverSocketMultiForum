import jwt from "jsonwebtoken";
import { configDotenv } from "dotenv";
import { join } from "path";
import { __dirname } from "../__dirname.js";
configDotenv({ path: join(__dirname, ".env") });
export function validateJWT(token: string) {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) return null;
  try {
    const validToken = jwt.verify(token, JWT_SECRET);
    return validToken;
  } catch {
    return null;
  }
}

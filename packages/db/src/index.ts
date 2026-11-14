import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(here, "schema.sql"), "utf8");

export type Db = Database.Database;

/**
 * Open (and migrate) the SQLite database. Safe to call once per process.
 * `:memory:` is supported for tests.
 */
export function openDb(path = process.env.DATABASE_PATH ?? "./data/tab.db"): Db {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export * from "./repo.js";

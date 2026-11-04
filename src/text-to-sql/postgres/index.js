// PostgreSQL support for text-to-SQL. Separate entry point ("@b2y/ai-service/text-to-sql/postgres") so
// the optional libpg-query peer dependency is only loaded by applications that use it.
export { createPostgresSqlValidator } from "./PostgresSqlValidator.js";

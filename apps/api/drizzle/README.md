# Drizzle Scratch Migrations

`infra/migrations` is the production source of truth for database
migrations. Fly deploys run the root `db:migrate` script against that
directory.

The SQL files in this directory are Drizzle-generated scratch output for
schema development and tests. Do not apply them to production directly;
promote intentional schema changes into a new sequential file under
`infra/migrations`.

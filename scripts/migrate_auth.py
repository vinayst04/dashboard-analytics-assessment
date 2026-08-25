"""Apply the additive schema update required for Google OAuth accounts."""

from sqlalchemy import create_engine, text

from scripts.import_data import configured_database_url


def main() -> None:
    engine = create_engine(configured_database_url())
    statements = [
        "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject VARCHAR(255)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_subject ON users (google_subject) WHERE google_subject IS NOT NULL",
    ]
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
    print("Google OAuth user schema is ready.")


if __name__ == "__main__":
    main()

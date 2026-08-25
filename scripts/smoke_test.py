"""Exercise the live API against the configured database without retaining test users."""

from fastapi.testclient import TestClient
from sqlalchemy import delete

from api.index import User, app, engine


def main() -> None:
    client = TestClient(app)
    email = "qa-pulseboard@example.com"
    password = "Dashboard123!"
    try:
        filters = client.get("/api/filters")
        dashboard = client.get("/api/dashboard")
        export = client.get("/api/export?start_date=2025-06-17&end_date=2025-06-17")
        signup = client.post("/api/auth/signup", json={"email": email, "password": password})
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        results = {
            "filters": filters.status_code,
            "dashboard": dashboard.status_code,
            "revenue": dashboard.json()["metrics"]["revenue"],
            "export": export.status_code,
            "export_header": export.text.splitlines()[0],
            "signup": signup.status_code,
            "login": login.status_code,
        }
        print(results)
        assert results["filters"] == results["dashboard"] == results["export"] == 200
        assert results["signup"] == results["login"] == 200
    finally:
        with engine().begin() as connection:
            connection.execute(delete(User).where(User.email == email))


if __name__ == "__main__":
    main()

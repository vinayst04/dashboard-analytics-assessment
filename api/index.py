from __future__ import annotations

import csv
import io
import json
import os
import secrets
import time as time_module
from pathlib import Path
from collections.abc import Generator
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from functools import lru_cache
from typing import Any

import jwt
from authlib.integrations.starlette_client import OAuth
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from google import genai
from google.genai import types
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from dotenv import load_dotenv
from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from starlette.middleware.sessions import SessionMiddleware

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


class Base(DeclarativeBase):
    pass


class Sale(Base):
    __tablename__ = "sales"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bill_no: Mapped[str] = mapped_column(String(64), nullable=False)
    outlet_name: Mapped[str] = mapped_column(String(120), nullable=False)
    order_datetime: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    group_name: Mapped[str] = mapped_column("group_name", String(80), nullable=False)
    order_type: Mapped[str] = mapped_column(String(40), nullable=False)
    item: Mapped[str] = mapped_column(String(160), nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    settlement: Mapped[str] = mapped_column(String(80), nullable=False)
    brand: Mapped[str] = mapped_column(String(120), nullable=False)

    __table_args__ = (
        Index("ix_sales_order_datetime_outlet", "order_datetime", "outlet_name"),
        Index("ix_sales_group_datetime", "group_name", "order_datetime"),
        Index("ix_sales_bill_no", "bill_no"),
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    google_subject: Mapped[str | None] = mapped_column(String(255), unique=True, index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


def database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is not configured. Add DATABASE_URL to the backend environment.",
        )
    if value.startswith("postgres://"):
        value = value.replace("postgres://", "postgresql+psycopg://", 1)
    elif value.startswith("postgresql://"):
        value = value.replace("postgresql://", "postgresql+psycopg://", 1)
    return value


@lru_cache(maxsize=1)
def engine():
    return create_engine(database_url(), pool_pre_ping=True, pool_recycle=300)


@lru_cache(maxsize=1)
def session_factory() -> sessionmaker[Session]:
    return sessionmaker(bind=engine(), autoflush=False, autocommit=False)


def get_session() -> Generator[Session, None, None]:
    session = session_factory()()
    try:
        yield session
    finally:
        session.close()


app = FastAPI(title="California Burrito Analytics API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(SessionMiddleware, secret_key=os.getenv("JWT_SECRET", "pulseboard-local-session-secret"), same_site="lax", https_only=bool(os.getenv("VERCEL")))

password_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth = OAuth()


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class AccountResponse(BaseModel):
    id: int
    email: EmailStr
    provider: str


class InsightQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=500)


class AiDashboardRequest(BaseModel):
    prompt: str = Field(min_length=5, max_length=500)


def default_question_answer(question: str) -> str:
    normalized = " ".join(question.lower().split())
    if normalized in {"hi", "hello", "hey", "hello there", "hi there", "help"}:
        return "Hi. Ask a question about the current dashboard, such as revenue, orders, products, categories, outlets, sales channels, or payment methods."
    return "I can answer questions only from the current dashboard data. Try asking about revenue, orders, products, categories, outlets, sales channels, or payment methods."


def fallback_ai_dashboard_widgets(request_text: str) -> list[dict[str, str]]:
    visual = "pie" if "pie" in request_text and "donut" not in request_text else "donut"
    widgets = [
        {
            "title": "Revenue by category",
            "source": "category",
            "visual": "horizontalBar",
            "description": "Previous-month revenue across product categories.",
        },
        {
            "title": "Outlet performance",
            "source": "outlet",
            "visual": "bar",
            "description": "Previous-month sales by outlet.",
        },
        {
            "title": "Revenue trend",
            "source": "trend",
            "visual": "line",
            "description": "Daily revenue during the previous complete month.",
        },
        {
            "title": "Order channel mix",
            "source": "channel",
            "visual": visual,
            "description": "Share of orders across sales channels.",
        },
    ]
    if "pivot" in request_text:
        widgets.append({
            "title": "Outlet comparison",
            "source": "outlet",
            "visual": "pivot",
            "description": "A previous-month outlet comparison table.",
        })
    if "table" in request_text:
        widgets.append({
            "title": "Top-selling items",
            "source": "items",
            "visual": "table",
            "description": "Items ranked from the previous-month aggregates.",
        })
    return widgets[:6]


def issue_token(user: User) -> str:
    secret = os.getenv("JWT_SECRET", "")
    if not secret:
        raise HTTPException(status_code=503, detail="Authentication is not configured. Add JWT_SECRET to the environment.")
    return jwt.encode({"sub": str(user.id), "email": user.email, "exp": datetime.now(timezone.utc) + timedelta(hours=12)}, secret, algorithm="HS256")


def current_user(request: Request, session: Session) -> User:
    authorization = request.headers.get("Authorization", "")
    bearer_token = authorization.removeprefix("Bearer ").strip() if authorization.startswith("Bearer ") else ""
    token = bearer_token or request.cookies.get("pulseboard_token", "")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in is required.")

    try:
        payload = jwt.decode(token, os.getenv("JWT_SECRET", ""), algorithms=["HS256"])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Your session has expired. Please sign in again.") from error

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Your account is no longer available.")
    return user


@lru_cache(maxsize=1)
def google_oauth_client():
    client_id = os.getenv("GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the environment.")
    oauth.register(
        name="google",
        client_id=client_id,
        client_secret=client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )
    return oauth.create_client("google")


def google_oauth_state() -> tuple[str, str]:
    secret = os.getenv("JWT_SECRET", "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Authentication is not configured. Add JWT_SECRET to the environment.")
    nonce = secrets.token_urlsafe(24)
    state = jwt.encode(
        {
            "purpose": "google_oauth",
            "nonce": nonce,
            "exp": datetime.now(timezone.utc) + timedelta(minutes=10),
        },
        secret,
        algorithm="HS256",
    )
    return state, nonce


def validate_google_oauth_state(state: str) -> str:
    secret = os.getenv("JWT_SECRET", "").strip()
    try:
        payload = jwt.decode(state, secret, algorithms=["HS256"])
    except jwt.PyJWTError as error:
        raise HTTPException(status_code=401, detail="Google sign-in expired or could not be verified. Please try again.") from error
    if payload.get("purpose") != "google_oauth" or not isinstance(payload.get("nonce"), str):
        raise HTTPException(status_code=401, detail="Google sign-in could not be verified. Please try again.")
    return payload["nonce"]


def value(number: Decimal | int | float | None) -> float:
    return float(number or 0)


def conditions_for(
    start_date: date | None,
    end_date: date | None,
    outlet: str | None,
    group: str | None,
    order_type: str | None,
    settlement: str | None,
) -> list[Any]:
    conditions: list[Any] = []
    if start_date:
        conditions.append(Sale.order_datetime >= datetime.combine(start_date, time.min))
    if end_date:
        conditions.append(Sale.order_datetime < datetime.combine(end_date + timedelta(days=1), time.min))
    if outlet:
        conditions.append(Sale.outlet_name == outlet)
    if group:
        conditions.append(Sale.group_name == group)
    if order_type:
        conditions.append(Sale.order_type == order_type)
    if settlement:
        conditions.append(Sale.settlement == settlement)
    return conditions


def dashboard_payload(
    session: Session,
    start_date: date | None = None,
    end_date: date | None = None,
    outlet: str | None = None,
    group: str | None = None,
    order_type: str | None = None,
    settlement: str | None = None,
) -> dict[str, Any]:
    conditions = conditions_for(start_date, end_date, outlet, group, order_type, settlement)
    sales_value = Sale.price * Sale.quantity
    revenue, orders, units = session.execute(
        select(func.coalesce(func.sum(sales_value), 0), func.count(func.distinct(Sale.bill_no)), func.coalesce(func.sum(Sale.quantity), 0)).where(*conditions)
    ).one()
    revenue_value, order_count, unit_count = value(revenue), int(orders or 0), int(units or 0)

    def grouped(statement: Any, label_key: str, amount_key: str = "revenue") -> list[dict[str, Any]]:
        rows = session.execute(statement).all()
        return [{label_key: str(row[0]), amount_key: value(row[1]), **({"units": int(row[2] or 0)} if len(row) > 2 else {})} for row in rows]

    day = func.date_trunc("day", Sale.order_datetime).label("day")
    trend_rows = session.execute(
        select(day, func.sum(sales_value), func.count(func.distinct(Sale.bill_no)))
        .where(*conditions)
        .group_by(day)
        .order_by(day)
    ).all()
    category_rows = session.execute(
        select(Sale.group_name, func.sum(sales_value), func.sum(Sale.quantity))
        .where(*conditions)
        .group_by(Sale.group_name)
        .order_by(func.sum(sales_value).desc())
    ).all()
    outlet_rows = session.execute(
        select(Sale.outlet_name, func.sum(sales_value), func.count(func.distinct(Sale.bill_no)))
        .where(*conditions)
        .group_by(Sale.outlet_name)
        .order_by(func.sum(sales_value).desc())
    ).all()
    order_type_rows = session.execute(
        select(Sale.order_type, func.count(func.distinct(Sale.bill_no)))
        .where(*conditions)
        .group_by(Sale.order_type)
        .order_by(func.count(func.distinct(Sale.bill_no)).desc())
    ).all()
    payment_rows = session.execute(
        select(Sale.settlement, func.count(func.distinct(Sale.bill_no)))
        .where(*conditions)
        .group_by(Sale.settlement)
        .order_by(func.count(func.distinct(Sale.bill_no)).desc())
    ).all()
    item_rows = session.execute(
        select(Sale.item, func.sum(sales_value), func.sum(Sale.quantity))
        .where(*conditions)
        .group_by(Sale.item)
        .order_by(func.sum(sales_value).desc())
        .limit(8)
    ).all()

    return {
        "metrics": {
            "revenue": revenue_value,
            "orders": order_count,
            "units": unit_count,
            "average_order_value": round(revenue_value / order_count, 2) if order_count else 0,
        },
        "revenue_trend": [{"date": row[0].date().isoformat(), "revenue": value(row[1]), "orders": int(row[2] or 0)} for row in trend_rows],
        "category_sales": [{"label": str(row[0]), "value": value(row[1]), "units": int(row[2] or 0)} for row in category_rows],
        "outlet_performance": [{"outlet": str(row[0]), "revenue": value(row[1]), "orders": int(row[2] or 0)} for row in outlet_rows],
        "order_type_mix": [{"label": str(row[0]), "value": int(row[1] or 0)} for row in order_type_rows],
        "payment_mix": [{"label": str(row[0]), "value": int(row[1] or 0)} for row in payment_rows],
        "top_items": [{"item": str(row[0]), "revenue": value(row[1]), "units": int(row[2] or 0)} for row in item_rows],
        "applied_filters": {
            "start_date": start_date.isoformat() if start_date else None,
            "end_date": end_date.isoformat() if end_date else None,
            "outlet": outlet,
            "group": group,
            "order_type": order_type,
            "settlement": settlement,
        },
    }


EXPLORER_DIMENSIONS: dict[str, tuple[str, Any]] = {
    "year": ("Year", func.to_char(Sale.order_datetime, "YYYY")),
    "month": ("Month", func.to_char(Sale.order_datetime, "YYYY-MM")),
    "week": ("Week", func.to_char(Sale.order_datetime, "IYYY-IW")),
    "day": ("Day", func.to_char(Sale.order_datetime, "YYYY-MM-DD")),
    "outlet": ("Outlet", Sale.outlet_name),
    "category": ("Category", Sale.group_name),
    "product": ("Product", Sale.item),
    "channel": ("Channel", Sale.order_type),
    "payment": ("Payment", Sale.settlement),
}


def explorer_measure(measure: str) -> tuple[str, Any]:
    sales_value = Sale.price * Sale.quantity
    measures: dict[str, tuple[str, Any]] = {
        "revenue": ("Revenue", func.sum(sales_value)),
        "orders": ("Orders", func.count(func.distinct(Sale.bill_no))),
        "units": ("Items sold", func.sum(Sale.quantity)),
        "average_order_value": ("Avg. order value", func.sum(sales_value) / func.nullif(func.count(func.distinct(Sale.bill_no)), 0)),
    }
    return measures.get(measure, measures["revenue"])


def explorer_drill_conditions(raw_drill: str | None) -> list[Any]:
    if not raw_drill:
        return []
    try:
        entries = json.loads(raw_drill)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="Invalid drill-down selection.") from error
    if not isinstance(entries, list) or len(entries) > 4:
        raise HTTPException(status_code=422, detail="A drill-down can contain up to four selections.")
    conditions: list[Any] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise HTTPException(status_code=422, detail="Invalid drill-down selection.")
        field, selected = entry.get("field"), entry.get("value")
        if field not in EXPLORER_DIMENSIONS or not isinstance(selected, str) or not selected:
            raise HTTPException(status_code=422, detail="Invalid drill-down selection.")
        if field in {"year", "month", "week", "day"}:
            conditions.append(EXPLORER_DIMENSIONS[field][1] == selected)
        else:
            conditions.append(EXPLORER_DIMENSIONS[field][1] == selected)
    return conditions


@app.get("/api/health")
def health(session: Session = Depends(get_session)) -> dict[str, str]:
    session.execute(select(1))
    return {"status": "ok"}


@app.get("/api/filters")
def filters(session: Session = Depends(get_session)) -> dict[str, Any]:
    minimum, maximum = session.execute(select(func.min(Sale.order_datetime), func.max(Sale.order_datetime))).one()
    if not minimum or not maximum:
        raise HTTPException(status_code=404, detail="No sales data has been imported yet.")
    return {
        "outlets": list(session.scalars(select(Sale.outlet_name).distinct().order_by(Sale.outlet_name))),
        "groups": list(session.scalars(select(Sale.group_name).distinct().order_by(Sale.group_name))),
        "order_types": list(session.scalars(select(Sale.order_type).distinct().order_by(Sale.order_type))),
        "settlements": list(session.scalars(select(Sale.settlement).distinct().order_by(Sale.settlement))),
        "date_range": {"min": minimum.date().isoformat(), "max": maximum.date().isoformat()},
    }


@app.get("/api/dashboard")
def dashboard(
    start_date: date | None = None,
    end_date: date | None = None,
    outlet: str | None = None,
    group: str | None = None,
    order_type: str | None = None,
    settlement: str | None = None,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if start_date and end_date and start_date > end_date:
        raise HTTPException(status_code=422, detail="Start date must be before end date.")
    return dashboard_payload(session, start_date, end_date, outlet, group, order_type, settlement)


@app.get("/api/explore")
def explore(
    dimensions: str = "outlet",
    measure: str = "revenue",
    drill: str | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    outlet: str | None = None,
    group: str | None = None,
    order_type: str | None = None,
    settlement: str | None = None,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    dimension_keys = [key.strip() for key in dimensions.split(",") if key.strip()]
    dimension_keys = list(dict.fromkeys(dimension_keys))
    if not dimension_keys or len(dimension_keys) > 4 or any(key not in EXPLORER_DIMENSIONS for key in dimension_keys):
        raise HTTPException(status_code=422, detail="Choose between one and four supported dimensions.")
    if start_date and end_date and start_date > end_date:
        raise HTTPException(status_code=422, detail="Start date must be before end date.")

    labels, expressions = zip(*(EXPLORER_DIMENSIONS[key] for key in dimension_keys))
    measure_label, measure_expression = explorer_measure(measure)
    query_conditions = conditions_for(start_date, end_date, outlet, group, order_type, settlement) + explorer_drill_conditions(drill)
    rows = session.execute(
        select(*expressions, measure_expression)
        .where(*query_conditions)
        .group_by(*expressions)
        .order_by(measure_expression.desc())
        .limit(1000)
    ).all()
    result_rows = []
    for row in rows:
        values = {key: str(row[index]) for index, key in enumerate(dimension_keys)}
        result_rows.append({"dimensions": values, "value": round(value(row[-1]), 2)})
    return {
        "dimensions": [{"key": key, "label": label} for key, label in zip(dimension_keys, labels)],
        "measure": {"key": measure, "label": measure_label},
        "rows": result_rows,
        "row_limit": 1000,
    }


@app.get("/api/export")
def export_csv(
    start_date: date | None = None,
    end_date: date | None = None,
    outlet: str | None = None,
    group: str | None = None,
    order_type: str | None = None,
    settlement: str | None = None,
    session: Session = Depends(get_session),
) -> StreamingResponse:
    rows = session.execute(
        select(Sale.bill_no, Sale.outlet_name, Sale.order_datetime, Sale.group_name, Sale.order_type, Sale.item, Sale.price, Sale.quantity, Sale.settlement, Sale.brand)
        .where(*conditions_for(start_date, end_date, outlet, group, order_type, settlement))
        .order_by(Sale.order_datetime)
    ).yield_per(1000)

    def generate() -> Generator[str, None, None]:
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["BillNo", "Outlet_Name", "Order_Datetime", "Group", "Order_Type", "Item", "Price", "Quantity", "Settlement", "Brand"])
        yield output.getvalue()
        output.seek(0)
        output.truncate(0)
        for row in rows:
            writer.writerow(row)
            yield output.getvalue()
            output.seek(0)
            output.truncate(0)

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=dashboard-current-view.csv",
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/auth/signup")
def signup(credentials: Credentials, session: Session = Depends(get_session)) -> dict[str, str]:
    if session.scalar(select(User).where(User.email == credentials.email.lower())):
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user = User(email=credentials.email.lower(), password_hash=password_context.hash(credentials.password))
    session.add(user)
    session.commit()
    return {"message": "Account created. You can now sign in."}


@app.post("/api/auth/login")
def login(credentials: Credentials, response: Response, session: Session = Depends(get_session)) -> dict[str, str]:
    user = session.scalar(select(User).where(User.email == credentials.email.lower()))
    if not user or not user.password_hash or not password_context.verify(credentials.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    token = issue_token(user)
    response.set_cookie("pulseboard_token", token, max_age=43_200, httponly=True, secure=bool(os.getenv("VERCEL")), samesite="lax")
    return {"access_token": token, "token_type": "bearer"}


@app.get("/api/auth/me", response_model=AccountResponse)
def auth_me(request: Request, session: Session = Depends(get_session)) -> AccountResponse:
    user = current_user(request, session)
    return AccountResponse(id=user.id, email=user.email, provider="google" if user.google_subject else "password")


@app.post("/api/auth/logout")
def logout(response: Response) -> dict[str, str]:
    response.delete_cookie("pulseboard_token", samesite="lax", secure=bool(os.getenv("VERCEL")))
    return {"message": "Signed out."}


@app.get("/api/auth/google/login")
async def google_login(request: Request):
    client = google_oauth_client()
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "").strip()
    if not redirect_uri:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured. Add GOOGLE_REDIRECT_URI to the environment.")
    state, nonce = google_oauth_state()
    authorization_data = await client.create_authorization_url(redirect_uri, state=state, nonce=nonce)
    return RedirectResponse(authorization_data["url"])


@app.get("/api/auth/google/callback")
async def google_callback(request: Request, session: Session = Depends(get_session)) -> RedirectResponse:
    client = google_oauth_client()
    app_base_url = os.getenv("APP_BASE_URL", "http://127.0.0.1:5173").strip().rstrip("/")
    try:
        state = request.query_params.get("state", "")
        code = request.query_params.get("code", "")
        if not state or not code:
            raise ValueError("Missing Google OAuth parameters")
        nonce = validate_google_oauth_state(state)
        redirect_uri = os.getenv("GOOGLE_REDIRECT_URI", "").strip()
        token = await client.fetch_access_token(code=code, redirect_uri=redirect_uri)
        profile = token.get("userinfo") or await client.parse_id_token(token, nonce=nonce)
    except Exception:
        return RedirectResponse(f"{app_base_url}/?auth_error=google", status_code=status.HTTP_303_SEE_OTHER)

    email = str(profile.get("email", "")).lower()
    subject = str(profile.get("sub", ""))
    if not email or not subject or profile.get("email_verified") is False:
        return RedirectResponse(f"{app_base_url}/?auth_error=google", status_code=status.HTTP_303_SEE_OTHER)

    user = session.scalar(select(User).where(User.google_subject == subject))
    if not user:
        user = session.scalar(select(User).where(User.email == email))
        if user and user.google_subject and user.google_subject != subject:
            return RedirectResponse(f"{app_base_url}/?auth_error=account", status_code=status.HTTP_303_SEE_OTHER)
        if user:
            user.google_subject = subject
        else:
            user = User(email=email, password_hash=None, google_subject=subject)
            session.add(user)
        session.commit()
        session.refresh(user)

    redirect = RedirectResponse(f"{app_base_url}/?auth=google", status_code=status.HTTP_303_SEE_OTHER)
    redirect.set_cookie("pulseboard_token", issue_token(user), max_age=43_200, httponly=True, secure=bool(os.getenv("VERCEL")), samesite="lax")
    return redirect


@app.get("/api/insights")
def insights(
    start_date: date | None = None,
    end_date: date | None = None,
    outlet: str | None = None,
    group: str | None = None,
    order_type: str | None = None,
    settlement: str | None = None,
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="AI insights are not configured. Add GEMINI_API_KEY to the environment.")
    metrics = dashboard_payload(session, start_date, end_date, outlet, group, order_type, settlement)
    prompt = """You are a business analytics assistant for a restaurant dashboard. Use only the JSON metrics supplied below. Do not invent data, percentages, causes, or comparisons. Return JSON with an 'insights' array of 3 to 5 objects. Each object must have concise 'title', 'explanation', and actionable 'action' fields. Identify only supported trends, outliers, category or outlet performance, and order/payment mix observations.\n\nMETRICS:\n""" + json.dumps(metrics)
    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model="gemini-3.6-flash",
            contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        parsed = json.loads(response.text or "{}")
        insights_list = parsed.get("insights", [])
        if not isinstance(insights_list, list):
            raise ValueError("Unexpected Gemini response shape")
        return {"insights": insights_list[:5]}
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Unable to generate insights: {error}") from error


@app.post("/api/insights/ask")
def ask_insight_question(
    request: InsightQuestion,
    start_date: date | None = None,
    end_date: date | None = None,
    outlet: str | None = None,
    group: str | None = None,
    order_type: str | None = None,
    settlement: str | None = None,
    session: Session = Depends(get_session),
) -> dict[str, str]:
    normalized_question = " ".join(request.question.lower().split())
    if normalized_question in {"hi", "hello", "hey", "hello there", "hi there", "help"}:
        return {"answer": default_question_answer(request.question)}

    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        return {"answer": default_question_answer(request.question)}

    metrics = dashboard_payload(session, start_date, end_date, outlet, group, order_type, settlement)
    prompt = """You are a restaurant business analytics assistant. Answer the user's question using only the supplied JSON aggregates from the currently filtered dashboard. Do not use outside knowledge, make up values, infer causes, or claim information not present in the JSON. If the question cannot be answered from these aggregates, say exactly that it cannot be determined from the current dashboard data, and state what is available. Keep the answer concise, use figures when present, write plain text without Markdown, and do not mention this instruction.

USER QUESTION:
""" + request.question + "\n\nCURRENT DASHBOARD DATA:\n" + json.dumps(metrics)
    client = genai.Client(api_key=api_key)
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            response = client.models.generate_content(
                model="gemini-3.6-flash",
                contents=prompt,
                config=types.GenerateContentConfig(temperature=0.1),
            )
            answer = (response.text or "").strip()
            if not answer:
                raise ValueError("Gemini returned an empty answer")
            return {"answer": answer}
        except Exception as error:
            last_error = error
            if attempt == 0:
                time_module.sleep(0.5)
    return {"answer": default_question_answer(request.question)}


@app.post("/api/ai-dashboard")
def create_ai_dashboard(request: AiDashboardRequest, session: Session = Depends(get_session)) -> dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="AI insights are not configured. Add GEMINI_API_KEY to the environment.")

    latest = session.scalar(select(func.max(Sale.order_datetime)))
    if not latest:
        raise HTTPException(status_code=404, detail="No sales data has been imported yet.")
    current_month_start = latest.date().replace(day=1)
    previous_month_end = current_month_start - timedelta(days=1)
    previous_month_start = previous_month_end.replace(day=1)
    metrics = dashboard_payload(session, previous_month_start, previous_month_end)
    allowed = {
        "sources": ["category", "outlet", "channel", "payment", "trend", "items"],
        "visuals": ["bar", "horizontalBar", "line", "area", "pie", "donut", "table", "pivot"],
        "max_widgets": 6,
    }
    prompt = """You configure a restaurant analytics dashboard. Interpret the user's request only with the supplied aggregate data. Return valid JSON only with this exact shape:
{"title":"short title","summary":"short plain-text summary","period":"YYYY-MM-DD to YYYY-MM-DD","widgets":[{"title":"short title","source":"one allowed source","visual":"one allowed visual","description":"short plain-text description"}]}

Rules: choose 3 to 6 widgets. Use only the allowed source and visual values. Do not generate SQL, code, new fields, or unsupported filters. Treat the data below as the previous-month dataset. Do not claim causes not present in the data.

ALLOWED CONFIGURATION:
""" + json.dumps(allowed) + "\n\nUSER REQUEST:\n" + request.prompt + "\n\nPREVIOUS-MONTH AGGREGATES:\n" + json.dumps(metrics)
    try:
        client = genai.Client(api_key=api_key)
        response = None
        for attempt in range(2):
            try:
                response = client.models.generate_content(
                    model="gemini-3.6-flash",
                    contents=prompt,
                    config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.1),
                )
                break
            except Exception:
                if attempt == 0:
                    time_module.sleep(0.5)
        if response is None:
            raise ValueError("Dashboard planner did not return a response")
        result = json.loads(response.text or "{}")
        widgets = result.get("widgets", [])
        if not isinstance(widgets, list):
            raise ValueError("Unexpected dashboard configuration")
        validated_widgets = [
            widget for widget in widgets[:6]
            if isinstance(widget, dict) and widget.get("source") in allowed["sources"] and widget.get("visual") in allowed["visuals"]
        ]
        # Keep AI-planned visuals compatible with the shape of their source data.
        for widget in validated_widgets:
            if widget.get("source") == "trend" and widget.get("visual") in {"pie", "donut"}:
                widget["visual"] = "line"
        request_text = request.prompt.lower()
        requested_visual = "donut" if "donut" in request_text else "pie" if "pie" in request_text else "pivot" if "pivot" in request_text else None
        if requested_visual and not any(widget.get("visual") == requested_visual for widget in validated_widgets):
            fallback_source = "category" if requested_visual in {"donut", "pie"} else "outlet"
            validated_widgets = validated_widgets[:5] + [{
                "title": f"{fallback_source.title()} {requested_visual.title()} view",
                "source": fallback_source,
                "visual": requested_visual,
                "description": "A requested view built from the previous-month aggregates.",
            }]
        if not validated_widgets:
            raise ValueError("No supported widgets were returned")
        return {
            "title": str(result.get("title") or "Previous month sales dashboard"),
            "summary": str(result.get("summary") or "A dashboard built from the previous-month sales aggregates."),
            "period": f"{previous_month_start.isoformat()} to {previous_month_end.isoformat()}",
            "widgets": validated_widgets,
            "data": metrics,
        }
    except Exception:
        return {
            "title": "Previous month sales dashboard",
            "summary": "A data-backed dashboard for the previous complete month of sales.",
            "period": f"{previous_month_start.isoformat()} to {previous_month_end.isoformat()}",
            "widgets": fallback_ai_dashboard_widgets(request.prompt.lower()),
            "data": metrics,
            "generation_notice": "A ready-to-use dashboard was prepared from the available sales data.",
        }

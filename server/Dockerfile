FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app/server

COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY server/config.toml ./config.toml
COPY server/app ./app

ENV PATH="/app/server/.venv/bin:${PATH}"

EXPOSE 8765

CMD ["uvicorn", "--host", "0.0.0.0", "--port", "8765", "app.main:app"]

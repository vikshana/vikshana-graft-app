# Stage 1: Build React frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Python backend + built frontend
FROM python:3.12-slim
WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir .
# Bootstrap OTel auto-instrumentation packages for detected libraries
RUN opentelemetry-bootstrap -a install

COPY app/ ./app/
# Copy React build output so FastAPI can serve it
COPY --from=frontend-build /app/frontend/dist ./static

EXPOSE 8080

CMD ["opentelemetry-instrument", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]

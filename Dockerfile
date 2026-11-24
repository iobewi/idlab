FROM node:22-bookworm-slim AS browser
WORKDIR /build
COPY core/package.json core/package-lock.json ./
RUN npm ci --ignore-scripts

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY core/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core/server.py ./core/server.py
COPY core/web ./core/web
COPY service/manager.py ./service/manager.py
COPY --from=browser /build/node_modules/esptool-js/bundle.js ./core/node_modules/esptool-js/bundle.js
USER 65534:65534
EXPOSE 8080 8081
CMD ["python", "service/manager.py"]

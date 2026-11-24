FROM node:22-bookworm-slim AS browser
WORKDIR /build
COPY core/package.json core/package-lock.json ./
RUN npm ci --ignore-scripts

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY core/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core/*.py core/*.js ./core/
COPY web ./web
COPY --from=browser /build/node_modules/esptool-js/bundle.js ./core/node_modules/esptool-js/bundle.js
RUN install -d -o 65534 -g 65534 -m 0700 /var/lib/idlab
USER 65534:65534
EXPOSE 8080
CMD ["python", "core/manager.py"]

# Builds the static web bundle, then serves it with nginx (which also reverse-proxies /v1 to the
# API — the built JS calls /v1/... as relative paths, so whatever serves these files must forward
# that prefix to wherever the e2e-runner service actually runs; see nginx.conf and its own comment).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# A .template here, not conf.d/default.conf directly: the official nginx entrypoint runs envsubst on
# every file under templates/ at container start, writing the result to conf.d/ — this is what lets
# API_UPSTREAM below be set per deployment (docker run -e API_UPSTREAM=host:port) without rebuilding.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Default: Docker Desktop's (macOS/Windows) special DNS name for "the host machine itself" — the
# right default when testing this container on a dev laptop running the API directly on the host.
# On a real Linux deploy, override it (-e API_UPSTREAM=127.0.0.1:8090 with --network host, or the
# API's real host:port otherwise) — host.docker.internal is not resolvable there by default.
ENV API_UPSTREAM=host.docker.internal:8090
EXPOSE 80

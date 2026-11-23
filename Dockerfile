# syntax=docker/dockerfile:1

# 1) Map tiles + JSON layers from Bohemia's Central Economy repo.
FROM alpine:3.22 AS data
RUN apk add --no-cache python3 git vips-tools imagemagick imagemagick-webp
WORKDIR /build
COPY scripts/ scripts/
RUN python3 scripts/build_data.py --ce /tmp/ce --out /build/data && rm -rf /tmp/ce /build/.cache

# 2) Static web app.
FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# 3) Serve: a single static binary on scratch (~12 MB base), no shell, non-root.
FROM joseluisq/static-web-server:2
COPY sws.toml /etc/sws.toml
COPY --from=web /web/dist /srv
COPY --from=data /build/data /srv/data
ENV SERVER_CONFIG_FILE=/etc/sws.toml
USER 65534:65534
EXPOSE 8080

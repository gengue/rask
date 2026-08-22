# One image, three commands: the API (which also serves the built SPA), the
# worker, and a one-shot migrator. Keeping them in one image means the schema
# the worker writes and the schema the API reads can never drift apart.

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/clickup-client/package.json packages/clickup-client/
COPY packages/schema/package.json packages/schema/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run --cwd apps/web build

FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=deps /app/apps/worker/node_modules apps/worker/node_modules
COPY --from=deps /app/packages/schema/node_modules packages/schema/node_modules
COPY --from=deps /app/packages/clickup-client/node_modules packages/clickup-client/node_modules

COPY package.json ./
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY packages packages
COPY --from=build /app/apps/web/dist apps/web/dist

# The API serves the SPA from the same origin, which is what keeps the session
# cookie SameSite=Lax with no CORS layer to get wrong.
ENV WEB_DIST=./apps/web/dist
ENV API_PORT=3000
EXPOSE 3000

USER bun
CMD ["bun", "apps/api/src/index.ts"]

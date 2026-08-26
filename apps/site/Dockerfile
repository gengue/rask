# The landing page at getrask.com. Static files and nothing else.
#
# Its own image, and its own Coolify application, rather than a service in
# docker-compose.prod.yml. The landing shares nothing with the client — no
# database, no secrets, no migration step — and putting it in that stack would
# mean a copy edit waits on Postgres to come up.
#
# Build context is the repository root, not this directory: bun workspaces
# resolve from the root lockfile, so a context of apps/site cannot install.
#
#   docker build -f apps/site/Dockerfile -t rask-site .

FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/site/package.json apps/site/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/clickup-client/package.json packages/clickup-client/
COPY packages/schema/package.json packages/schema/
RUN bun install --frozen-lockfile

# apps/web comes along for one file: the shared colour palette in
# src/theme.css, which this page imports rather than keeping a second copy of.
COPY apps/site apps/site
COPY apps/web/src/theme.css apps/web/src/theme.css
# apps/site/tsconfig.json extends it, and Vite reads the resolved config to
# transform the TypeScript. Without it the build dies on "Tsconfig not found".
COPY tsconfig.base.json ./
RUN bun run --cwd apps/site build

FROM nginx:alpine AS runtime
COPY --from=build /app/apps/site/dist /usr/share/nginx/html

# No nginx.conf of our own. The stock config serves a directory of static
# files, and there is no SPA fallback to configure because there is no router.
EXPOSE 80

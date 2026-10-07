FROM node:24-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@abaya/worker...
RUN pnpm deploy --legacy --filter=@abaya/worker --prod /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
CMD ["node", "dist/main.js"]

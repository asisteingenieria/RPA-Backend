FROM node:24-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@abaya/api... --filter=@abaya/panel
RUN pnpm deploy --legacy --filter=@abaya/api --prod /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
COPY --from=build /repo/apps/panel/dist ./panel
ENV PANEL_DIR=/app/panel
USER node
CMD ["node", "dist/main.js"]

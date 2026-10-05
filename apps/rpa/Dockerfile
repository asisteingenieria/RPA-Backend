# Imagen oficial de Playwright: misma versión que la dependencia `playwright` (fijada).
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@abaya/rpa...
RUN pnpm deploy --filter=@abaya/rpa --prod /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER pwuser
EXPOSE 3001
CMD ["node", "dist/main.js"]

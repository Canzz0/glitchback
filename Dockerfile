# Next.js dışındaki siteler için ayrı rapor sunucusu (npx patchback serve).
# docker build -t patchback . && docker run -p 8787:8787 --env-file .env patchback
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/patchback packages/patchback
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/patchback/dist ./dist
COPY --from=build /app/packages/patchback/package.json ./package.json
USER node
EXPOSE 8787
CMD ["node", "dist/cli.js", "serve"]

# Next.js dışındaki siteler için ayrı rapor sunucusu (npx bugloop serve).
# docker build -t bugloop . && docker run -p 8787:8787 --env-file .env bugloop
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/bugloop packages/bugloop
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/bugloop/dist ./dist
COPY --from=build /app/packages/bugloop/package.json ./package.json
USER node
EXPOSE 8787
CMD ["node", "dist/cli.js", "serve"]

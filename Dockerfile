FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY --from=build /app/package*.json ./
COPY --from=build /app/LICENSE /app/THIRD_PARTY_NOTICES.md /app/ASSET_POLICY.md ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/game ./src/game
COPY --from=build /app/src/online/protocol.ts ./src/online/protocol.ts
RUN mkdir data && chown node:node data
USER node
EXPOSE 3001
CMD ["npm", "run", "server"]

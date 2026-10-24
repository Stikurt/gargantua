FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.mjs ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/mvp ./src/mvp
COPY inference/profiles.json ./inference/profiles.json
COPY src/catalogs.mjs src/import-book.mjs src/audio.mjs src/audio-engine.mjs src/audio-requests.mjs src/reader-sync.mjs src/reader-session.mjs src/library-state.mjs src/book-download.mjs src/search-query.mjs src/chapter-batches.mjs src/serial-groups.mjs src/serial-reader.mjs src/discovery-client.mjs src/discovery-delivery.mjs ./src/
COPY tests ./tests
COPY scripts/audio-client-fixture.mjs ./scripts/
COPY desktop ./desktop
COPY LIBRARY_POLICY.md ./LIBRARY_POLICY.md
USER node
CMD ["node", "server/app.mjs"]

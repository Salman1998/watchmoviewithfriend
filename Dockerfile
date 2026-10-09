# Signaling server only (used by deploy-firebase.sh for Google Cloud Run).
# The website itself is served by Firebase Hosting.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# Cloud Run tells the server which port to use through the PORT variable.
CMD ["node", "dist/server.js"]

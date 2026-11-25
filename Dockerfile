# package.json → engines.node = 22.x
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]

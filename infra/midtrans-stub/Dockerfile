FROM docker.io/library/node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY fixtures ./fixtures
ENV PORT=3000
USER node
CMD ["node", "src/main.ts"]

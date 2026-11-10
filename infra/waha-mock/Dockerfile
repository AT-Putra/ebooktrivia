FROM node:26-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY fixtures ./fixtures
ENV PORT=3000
USER node
CMD ["node", "src/main.ts"]

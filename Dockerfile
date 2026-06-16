FROM node:20-slim
WORKDIR /app
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --only=production && npm cache clean --force
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]

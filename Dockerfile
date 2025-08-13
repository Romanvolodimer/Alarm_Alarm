FROM node:20-slim

# Системні залежності Chromium
RUN apt-get update && apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libx11-6 libxcomposite1 libxrandr2 \
  libxdamage1 libxext6 libcups2 libxshmfence1 libasound2 libpangocairo-1.0-0 \
  libpango-1.0-0 libgtk-3-0 fonts-liberation libgbm1 ca-certificates chromium \
  && rm -rf /var/lib/apt/lists/*

# Не качаємо браузер під час npm install
ENV PUPPETEER_SKIP_DOWNLOAD=true
# Вказуємо шлях до системного Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Render прокине PORT; наш server.js слухає process.env.PORT
ENV PORT=3000

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]

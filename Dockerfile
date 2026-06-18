# Usamos una imagen de Node que ya incluya algunas dependencias o sea fácil de configurar
FROM node:20-slim

# Instalamos las dependencias de sistema necesarias para que Chromium corra en Linux
# Estas son fundamentales para evitar errores de librerías faltantes (.so) en Cloud Run
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    dbus \
    dbus-x11 \
    libgbm1 \
    libasound2 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxdamage1 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Instalamos Chromium manualmente para tener una ruta fija
RUN apt-get update && apt-get install -y chromium \
    && rm -rf /var/lib/apt/lists/*

# Directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalamos solo dependencias de producción
# Saltamos la descarga de browsers de Playwright/Puppeteer porque usaremos el del sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROME_PATH=/usr/bin/chromium

RUN npm ci --only=production

# Copiamos el resto del código
COPY . .

# Exponemos el puerto de Cloud Run
EXPOSE 8080

# Comando para arrancar el servidor
CMD ["node", "server.js"]

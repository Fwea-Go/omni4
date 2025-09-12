FROM node:20-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better caching)
COPY package*.json ./
RUN npm install

# App code
COPY server.js ./
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]

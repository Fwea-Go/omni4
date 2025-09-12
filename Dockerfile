FROM node:20-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]

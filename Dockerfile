FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/
COPY .env ./

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]

FROM node:20-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --chown=node:node . .

ENV ROOT_DIR=/repos
ENV SCAN_INTERVAL_MINUTES=5
ENV PORT=3000

# Run as the image's built-in unprivileged user, not root - this container
# has read-write access to your repos folder and a git credential, so it
# shouldn't run with more privilege than it needs.
USER node

EXPOSE 3000

CMD ["node", "server.js"]

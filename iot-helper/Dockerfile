FROM node:24-alpine

RUN apk add --no-cache iproute2 iputils
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY config.example.json ./config.example.json

ENV MANTIS_IOT_CONFIG=/config/mantis-iot.json
VOLUME ["/config"]
CMD ["node", "bin/mantis-iot-helper.js"]

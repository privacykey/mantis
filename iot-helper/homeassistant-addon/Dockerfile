ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs iproute2 iputils

WORKDIR /app
COPY iot-helper/bin ./bin
COPY iot-helper/homeassistant-addon/run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]

# Mantis IoT Helper Home Assistant add-on

This is a local add-on wrapper for `iot-helper/bin/mantis-iot-helper.js`.

Build it from the repository root so the Dockerfile can copy `iot-helper/bin`:

```bash
docker build -f iot-helper/homeassistant-addon/Dockerfile .
```

In Home Assistant OS/Supervised, copy this folder into a local add-on
repository and keep the same relative repo layout, or package it into your own
add-on repository. Configure devices/log watchers from the add-on UI. The add-on
uses host networking so it can inspect the LAN neighbor table.

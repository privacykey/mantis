# Mantis IoT Helper Home Assistant add-on

This is a local add-on wrapper for `iot-helper/bin/mantis-iot-helper.js`, for
Home Assistant OS/Supervised on aarch64 or amd64.

Create a self-contained add-on folder from the Mantis repository root:

```bash
node iot-helper/scripts/package-homeassistant.mjs /tmp/mantis-iot-helper-addon
```

Use a new output directory; packaging refuses to overwrite an existing folder.
The generated folder contains the helper, its package metadata, the Dockerfile,
startup script and add-on configuration. Copy that **entire generated folder**
to `/addons/mantis_iot_helper` on Home Assistant, then check for updates in the
add-on/app store, install **Mantis IoT Helper**, and configure devices and log
watchers in its configuration tab before starting it.

For a standalone build of the same package, run:

```bash
docker build -t mantis-iot-helper-ha /tmp/mantis-iot-helper-addon
```

The Dockerfile pins a Node runtime that satisfies the helper's engine; it does
not require `BUILD_FROM`. Supervisor supplies `BUILD_VERSION` and `BUILD_ARCH`
for its image labels. The container reads `/data/options.json`, uses host
networking to inspect the LAN neighbor table, and mounts the Home Assistant
configuration read-only at `/config` for configured log watchers. A standalone
container needs an options file mounted at `/data/options.json`.

Packaging and container tests do not verify your physical devices. Check the
add-on logs and a test Mantis canary when installing on your own network.

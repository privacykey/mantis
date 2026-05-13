# mantis IoT helper

Small local watcher for IoT devices that do not have good webhook support. Run
it on something that can see the LAN, such as a Raspberry Pi, NAS, router-ish
Linux host, or Home Assistant add-on.

It can fire a Mantis URL when:

- a configured MAC/IP appears outside its allowed schedule
- a configured log file contains a login/auth pattern

The helper does not know about Mantis CLI profiles. Put the exact trigger URL
you want it to call in `mantis_url`. Generate that URL from the intended
profile/server:

```bash
mantis --profile prod show last --url-only
mantis --profile lab new "garage camera online" --url-only
```

If the same LAN event should notify multiple Mantis servers, add multiple device
or log watcher entries with different `mantis_url` values.

Events are sent with structured headers:

- `X-Mantis-Source: iot-network` or `iot-log`
- `X-Mantis-Event: unexpected-online`, `device-login`, etc.
- `X-Mantis-Device`, `X-Mantis-Iot-Mac`, `X-Mantis-Iot-Ip`
- `X-Mantis-Network-Interface`

## Run Directly

```bash
cd iot-helper
cp config.example.json mantis-iot.json
# edit mantis URLs, MACs, IPs, and schedules
node bin/mantis-iot-helper.js --config mantis-iot.json --once --dry-run
node bin/mantis-iot-helper.js --config mantis-iot.json
```

## Config

```json
{
  "interval_seconds": 30,
  "cooldown_seconds": 900,
  "interface": "br0",
  "devices": [
    {
      "name": "garage-camera",
      "mac": "aa:bb:cc:dd:ee:ff",
      "ip": "192.168.1.50",
      "ping": true,
      "mantis_url": "https://mantis-public.example/c/replace-me",
      "allowed": [
        { "days": ["mon", "tue", "wed", "thu", "fri"], "start": "07:00", "end": "23:00" }
      ]
    }
  ],
  "log_watchers": [
    {
      "name": "camera-admin-login",
      "path": "/var/log/syslog",
      "pattern": "garage-camera.*(login|logged in|auth).*success",
      "event": "device-login",
      "device": "garage-camera",
      "mantis_url": "https://mantis-public.example/c/replace-me"
    }
  ]
}
```

An empty or missing `allowed` list means the device is always allowed. Windows
that cross midnight are supported, for example `{"start":"23:00","end":"06:00"}`.

## Notes

- Network detection is best-effort. ARP/neighbor tables only include devices
  recently seen by the watcher host; set `"ping": true` for devices that answer
  ICMP and need active probing.
- Login detection requires a log source. Many cameras/routers can send syslog
  to a local host; point `log_watchers[].path` at that received log.
- Run with enough permissions to read neighbor tables and log files.

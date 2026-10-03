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
  "delivery_timeout_seconds": 10,
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
  ICMP and need active probing. Failed/incomplete neighbor entries do not count
  as presence. `interface` restricts matching and ping probes to that interface;
  a device's own `interface` overrides the global setting.
- Login detection requires a log source. Many cameras/routers can send syslog
  to a local host; point `log_watchers[].path` at that received log.
- Run with enough permissions to read neighbor tables and log files.
- Delivery has a bounded timeout (10 seconds by default). Accepted 2xx/3xx
  trigger responses start the cooldown; failures retry on the next polling
  tick. Redirect responses are accepted without following the target.
- Cooldowns and log offsets are separate for each destination, so repeated
  device/watcher entries can notify multiple servers independently.
- Log watching starts at the end of the file on startup. Failed log events are
  retained in memory and retried even if that file rotates or disappears. This
  state is not durable across helper restarts; stopping/restarting the helper
  drops pending events and starts at the current end of each file again.
- Log reading is bounded, so a burst of syslog from the LAN cannot exhaust the
  helper's memory before a login line is alerted. Each watcher reads its log
  in 256 KiB chunks and delivers matches as it goes; per poll it reads at most
  about 32 MiB and turns at most 64 matching lines into events. Anything
  beyond that stays in the file and is read on the next polls from exactly
  where the last one stopped. Only the first 16 KiB of a line is matched and
  sent; the rest of an over-long line is skipped. If a log outgrows 32 MiB per
  poll for long, the watcher falls behind — and what it has not read yet is
  lost when the file rotates — so point it at a log that receives only the
  devices you care about, and rate-limit the syslog receiver.
- Run the helper under a supervisor that restarts it (`restart: unless-stopped`
  in Docker, `Restart=on-failure` in systemd, the Watchdog toggle for the Home
  Assistant add-on). A stopped helper raises no alerts at all.

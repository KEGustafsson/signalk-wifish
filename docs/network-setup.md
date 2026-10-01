# Network setup (Jetson + Wi-Fish)

The Wi-Fish is a Wi-Fi access point. Discovery uses `224.0.0.1`, which is
link-local and cannot be routed, so the host running the client must join the
Wi-Fish Wi-Fi directly. Keep Ethernet as the default route and use the WLAN
only for the sonar subnet.

```sh
nmcli dev wifi connect "<Wi-Fish SSID>" password "<key>" name wifish
nmcli con mod wifish \
  ipv4.never-default yes \
  ipv4.ignore-auto-dns yes \
  ipv6.method disabled \
  802-11-wireless.powersave 2 \
  connection.autoconnect-retries 0
nmcli con up wifish
```

- `never-default`: default route stays on Ethernet.
- `ipv6.method disabled` needs NetworkManager ≥ 1.20; on older versions
  (JetPack 4.x) use `ipv6.method ignore`.
- `powersave 2` (= disable): Wi-Fi power save can drop or delay multicast frames.
- `autoconnect-retries 0` (= retry forever): NM never gives up, so it
  reconnects whenever the sonar powers up.

Verify (interface names vary; Jetsons often use names like `wlP1p1s0`):

```sh
ip route                     # exactly one default route, via Ethernet
ip -4 addr show wlan0        # note the WLAN address
ip maddr show dev wlan0      # while the probe runs: the announced data group
                             # (224.0.0.1 is always listed, so it proves nothing)
```

Make sure the LAN subnet does not overlap the Wi-Fish subnet. If both the LAN
and the Wi-Fish use `192.x` addresses, the probe picks the one on the same
subnet as the announced device; pass `--iface <WLAN address>` to force it.

## Docker

A containerised client needs `network_mode: host` to receive the multicast.

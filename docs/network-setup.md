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

## When the LAN overlaps the sonar subnet

The sonar hands out `192.168.0.x` addresses, the most common home and router
subnet. If your LAN uses the same range, joining the sonar Wi-Fi gives the
host a direct route for `192.168.0.0/24` through the WLAN. Packets from a LAN
client (SSH, the Signal K web UI) still arrive over Ethernet, but the replies
go out to the sonar network and are lost, so the host seems to drop off the
LAN whenever the sonar is on.

Check the LAN client's address. If it starts with `192.168.0.`, this is the
cause. The fix is to limit the WLAN route to the sonar itself instead of the
whole /24: give the WLAN a static `/32` address and add a host route to the
sonar (`192.168.0.1`) only:

```sh
nmcli con mod wifish \
  ipv4.method manual \
  ipv4.addresses 192.168.0.141/32 \
  ipv4.routes "192.168.0.1/32" \
  ipv4.never-default yes
nmcli con up wifish
```

Pick any unused address in the sonar's range for the WLAN; `192.168.0.141` is
an example. Multicast discovery still works, since `224.0.0.1` is link-local
and does not depend on the subnet route.

The plugin's automatic interface pick copes with this setup: discovery listens
on every `192.x` interface, and once the sonar announces itself the session
joins the data group on every candidate whose subnet contains the sonar. With
a `/32` address no subnet contains it, so the plugin joins on all candidates
(Ethernet included) and the WLAN one receives the data. Setting the plugin's
**Wi-Fi interface address** to the WLAN address remains the recommended
explicit setting: it keeps the sonar sockets off the Ethernet side entirely,
and it is what the probe needs (`--iface`), since the probe uses a single
interface.

If the LAN uses a different range, no special routing is needed. Both
interfaces may still have `192.x` addresses; the plugin then uses the
candidates on the same subnet as the announced device (the probe picks the
first such one), and the interface option / `--iface <WLAN address>` forces it.

## Docker

A containerised client needs `network_mode: host` to receive the multicast.

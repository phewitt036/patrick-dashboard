# Rack chimney — build notes

Two 120mm ARCTIC P12 Pro A-RGB fans bolted into the MOJO rack: one in the bottom
plate blowing up, one in the acrylic top blowing up and out. Both open blade faces
point down. Air enters at the filtered bottom, runs past the Pis and the mini PCs,
and leaves at the top.

The lights double as a fleet-status indicator — green when every node is cool,
amber when one crosses its warn threshold, red when one crosses crit. Same
thresholds the node gauges already use.

---

## Starting cold

If you are picking this up with no other context, this section is the missing
half. Ask for `esphome/rack-chimney.yaml` alongside this file — it is the actual
firmware config and the two are meant to be read together.

### The actual parts

| Thing called | What it really is |
|---|---|
| the controller | GLEDOPTO **GL-C-017WL-D** — an ESP32 board sold as a WLED light controller. Barrel jack in, screw terminals out, USB-C for flashing. **It passes its input voltage straight through to the LED terminals — it does not step anything down.** |
| the fans | 2 × ARCTIC **P12 Pro A-RGB**, 120mm, 4-pin PWM motor plus a separate 3-pin 5V addressable LED ring |
| 12V brick | ALITOVE 12V 3A, 5.5×2.1mm barrel |
| 5V brick | 5V 3A, 5.5×2.1mm barrel — **not yet purchased**, see below |
| the splitter (power) | 1-to-3 DC barrel splitter |
| the splitter (lights) | 3-pin ARGB splitter, one round cable in, two legs out. Its legs are female; the fans' ARGB plugs are male, so they mate directly |
| screw terminals | green barrel-jack-to-screw-terminal adapters |
| fan extension cables | 5-pack of 11.8in 4-pin PWM case fan extension cables. These get cut |

### What is already done

- Both fans are physically mounted. Bottom fan screwed to the vented bottom plate,
  top fan bolted through the vents of the removable acrylic lid with M4 bolts and
  washers. Both blow upward, open blade face down.
- Magnetic dust filter is stuck to the underside of the bottom plate.
- Everything in the parts table is in hand **except the 5V brick.**
- The dashboard side is written and deployed — see "Order of work" step 6. Do not
  rebuild it. The code is in this repo at `routes/pimax.js` (search `rack`) and
  `public/index.html` (search `loadRack`).

### The blocker

**The 5V 3A supply has not been bought yet.** Nothing past step 2 can be finished
without it, and improvising with the 12V brick destroys both LED rings. Everything
in step 1 works today.

### Before flashing: the secrets file

`rack-chimney.yaml` refers to four values it does not contain. ESPHome reads them
from a `secrets.yaml` sitting next to it. Without this the config will not compile
and the error message will be about a missing secret:

```yaml
wifi_ssid: "your network name"
wifi_password: "your wifi password"
rack_chimney_api_key: ""          # ESPHome generates this; paste it back in
rack_chimney_ota_password: "pick anything"
```

The ESPHome add-on offers to generate the API encryption key when you create the
device. Take what it gives you.

### Flashing, in more detail than step 2

1. Home Assistant → Settings → Add-ons → Add-on Store → install **ESPHome Builder**.
2. Open it, **New Device**, name it `rack-chimney`, pick **ESP32** as the board.
3. Let it create the skeleton, then replace the whole file with `rack-chimney.yaml`.
4. Plug the controller into the computer with a USB-C cable — a real data cable,
   not a charge-only one.
5. Install → **Plug into this computer**. The browser flasher needs Chrome or Edge;
   Firefox and Safari cannot talk to serial ports.
6. After the first flash it updates over wifi, so the USB cable only matters once.

### What the ESP32 looks like from Home Assistant

Once adopted, these entities appear. agent-hub drives the fans through these:

| Entity | What it does |
|---|---|
| `fan.rack_chimney_intake` | bottom fan, 0–100% |
| `fan.rack_chimney_exhaust` | top fan, 0–100% |
| `light.rack_chimney_ring` | both LED rings, colour + brightness + effects |
| `sensor.rack_chimney_intake_rpm` | measured speed of the bottom fan |

agent-hub reaches them over Home Assistant's REST API on bee — `GET /api/states/<entity>`
to read, `POST /api/services/fan/set_percentage` and `/api/services/light/turn_on`
to write, with a long-lived access token in an `Authorization: Bearer` header.
Create that token in Home Assistant under your user profile → Security.

### The one gap nothing here can fill

**agent-hub itself is not in this repo.** It runs on pimax and it is the piece that
has to be written for step 5 — the temperature curve, the fleet-status colour, the
override timer, and the calls to Home Assistant above. Anyone helping with step 5
needs to see that codebase; this file only specifies what it must return, not how
it is built.

---

## How it all hangs together

```
  wall
   ├── 12V brick ──► 1-to-3 splitter ──► screw terminals ──► fan motors (both fans)
   └── 5V  brick ─────────────────────► ESP32 controller ──► fan LED rings (both fans)
                                              │
                                              └── speed wires back out to both fans
```

Then, over wifi:

```
  ESP32 ──► Home Assistant (on bee) ──► agent-hub (on pimax) ──► dashboard tile
```

The dashboard never talks to the fans. It asks agent-hub, agent-hub asks Home
Assistant, Home Assistant talks to the ESP32. Same chain the pimax fan widget
already uses, one hop longer.

---

## Two power bricks, and why

This is the part that is easy to get wrong and expensive to get wrong.

| | 12V brick (black, ALITOVE) | 5V brick |
|---|---|---|
| Feeds | the fan **motors** | the **controller board** |
| Goes to | splitter → screw terminals → fans | controller's barrel jack |

The controller board does **not** convert voltage. Whatever goes into its barrel
jack comes straight back out of its LED screw terminals. The fans' LED rings are
5V parts. Put 12V into the controller and those rings are destroyed the instant
it powers on, with no warning and no recovery.

So: **5V into the controller. 12V nowhere near it.**

**The two bricks' ground wires must be joined.** Use one of the lever nuts that
came with the controller — flip the orange levers up, push both bare ground wires
in, flip the levers down. Without this the controller has no shared reference with
the fans and the speed signal does nothing; the fans will just run flat out.

---

## The fan extension cable

Each fan ends in a **wide plug with four slots**. That plug goes into one end of a
black extension cable from the 5-pack. The **other** end of that cable gets cut
off, and the four wires inside get stripped and screwed into the green screw
terminal blocks.

Inside that cable, in order along the connector:

| Position | Colour | What it is | Where it goes |
|---|---|---|---|
| 1 | black | ground | screw terminal, joined to 12V ground |
| 2 | red | 12V power | screw terminal, from the 12V splitter |
| 3 | yellow | speed report (RPM out) | controller `GPIO2` — bottom fan only |
| 4 | blue | speed control (PWM in) | controller `GPIO4` bottom / `GPIO13` top |

Colours vary between cable brands, so confirm against **position**, not colour:
the order above is fixed by the connector, the colours are not.

Only black and red are needed to make the fans spin. Yellow and blue can stay
taped off until the controller is in.

---

## Which controller terminal is which

| Terminal | Wire | Notes |
|---|---|---|
| `GPIO16` | ARGB data (from the splitter) | both fans' lights, daisy-chained |
| `GPIO4` | blue wire, **bottom** fan | speed control |
| `GPIO13` | blue wire, **top** fan | speed control |
| `GPIO2` | yellow wire, **bottom** fan | speed report |
| `GND` | joined 12V + 5V grounds | |

`GPIO12` is deliberately left empty. It is a pin the ESP32 reads at the moment it
powers on to decide how to talk to its own memory chip. A fan holds its speed-control
wire high, which is the state that makes the board refuse to boot. Nothing goes there.

Flash the board over USB **before** wiring the yellow wire to `GPIO2` — that pin is
also read during flashing, and a fan attached to it can block the upload.

---

## Order of work

1. **Fans spin.** 12V brick → splitter → screw terminals → black and red wires only.
   Both fans should run at full speed. This proves the power path with nothing
   fragile connected.
2. **Flash the controller.** Home Assistant → Settings → Add-ons → ESPHome. Plug the
   board into a computer with USB-C, adopt it, push `rack-chimney.yaml`.
3. **Lights.** 5V brick → controller barrel jack. ARGB splitter → `GPIO16` and the
   controller's ground.
4. **Speed control.** Blue wires to `GPIO4` and `GPIO13`, yellow to `GPIO2`.
5. **agent-hub.** Add `/rack/status`, `/rack/override`, `/rack/lights` on pimax.
6. **Dashboard.** Already done. Until step 5 answers, the tile sits greyed with
   "pimax unreachable" (agent-hub has no `/rack` route yet); once it does, a
   powered-off or offline ESP32 reads "controller offline" instead. Either way it
   stays quiet rather than throwing a red error.

---

## What agent-hub needs to return

`GET /rack/status`:

```json
{
  "success": true,
  "online": true,
  "mode": 3,
  "modeName": "Balanced",
  "reason": "hottest node pimax 62.4°C",
  "intakePct": 45,
  "exhaustPct": 35,
  "intakeRpm": 820,
  "hottestNode": "pimax",
  "hottestTemp": 62.4,
  "lights": { "on": true, "effect": "fleet", "color": "#22c55e" },
  "override": false,
  "lastRun": "2026-09-07T14:20:00Z"
}
```

`mode` reuses the pimax fan's numbering so the dashboard colours match:
1 performance, 2 cool, 3 balanced, 4 quiet.

`POST /rack/override` takes `{ mode, minutes }`; `DELETE` clears it.
`POST /rack/lights` takes `{ effect }` — one of `fleet`, `rainbow`, `solid`, `off`.

Keep the intake a few percent faster than the exhaust. That holds the rack at
slightly positive pressure, so air comes in through the filter at the bottom
instead of being sucked in through every gap in the frame, dust and all.

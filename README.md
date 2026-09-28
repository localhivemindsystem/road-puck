# Road Puck

A dashboard alert for London drivers. Your phone watches your GPS against a dataset of
camera-enforced road restrictions and tells you, in big bold letters, whether the street
ahead is **OPEN**, **CLOSING** or **CLOSED**. A small round puck on the dash mirrors it.

This first test set covers **Lambeth's 43 School Streets**.

![Puck screens](docs/puck-screens.png)

## What's in here

| Folder | What it is |
| --- | --- |
| `docs/` | The phone app (served by GitHub Pages). `index.html` is built from `app/app.html`; `engine.js` is the alert logic. |
| `data/lambeth/` | The dataset: `school_streets.geojson` (open it on GitHub to see it on a map), `term_dates.json`, and the street map `basemap.json`. |
| `firmware/RoadPuck/` | Arduino sketch for the Waveshare ESP32-S3-Touch-AMOLED-1.75. |
| `tools/` | Scripts that rebuild the data, the fonts and the app, plus the engine tests. |

## 1. Put the phone app online (once)

1. On GitHub, open this repository's **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**, branch `main`, folder `/docs`, then **Save**.
3. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.
   Open that on your Android phone in **Chrome** and add it to your home screen.

iPhone: Safari can't talk to Bluetooth devices. The app still works for GPS alerts, but to
reach the puck you'd need a Web Bluetooth browser such as Bluefy.

## 2. Flash the puck

1. Arduino IDE → Boards Manager → install **esp32 by Espressif**, version **3.3.10**
   (the version Waveshare tests with).
2. Install **GFX Library for Arduino** (1.6.x). The copy in Waveshare's
   `examples/arduino/libraries` folder is fine.
3. Open `firmware/RoadPuck/RoadPuck.ino` and set the Tools menu:
   - Board: **ESP32S3 Dev Module**
   - USB CDC On Boot: **Enabled**
   - Flash Size: **16MB (128Mb)**
   - Partition Scheme: **16M Flash (3MB APP/9.9MB FATFS)**
   - PSRAM: **OPI PSRAM** (required: the screen image lives here)
4. Upload. The puck shows **CONNECT**.

On the puck, the **BOOT** button:
- short press cycles brightness (bright / medium / night)
- hold for 2 seconds for demo mode, which cycles sample screens with no phone needed

## 3. Drive test

1. Open the app on the phone and tap **START GPS**. Allow location.
2. Switch on the puck, tap **CONNECT PUCK** and pick `RoadPuck-xxxx`.
3. Keep the app open with the phone mounted. The screen stays on while GPS runs.
4. Drive past a School Street during its closure times on a school day.

Try it at home first: tap **SIMULATE**, then tap along a street on the map to "drive".
The **Time** panel lets you set any day and time.

## How the alert decides

For every closure the engine measures the distance to the closed stretch of road, then:

| Puck shows | When |
| --- | --- |
| **DON'T ENTER** (flashing red) | You're within 35 m of a closed stretch (plus up to 40 m for GPS error). |
| **CLOSED** | A closure is inside your look-ahead zone, in front of you, and closed now or by the time you'd reach it. |
| **CLOSING** | A closure ahead starts within 30 minutes. |
| **OPEN** | A closure ahead is open right now (between times, weekend or school holiday). |
| **CLEAR** | Nothing in the look-ahead zone. |
| **NO GPS** | GPS accuracy worse than 100 m, or no fix for 15 seconds. |

- **Look-ahead zone:** 250 m when slow, growing with speed up to 600 m, plus GPS error (capped at 50 m).
- **"In front of you":** within 75° of your direction of travel. When you're stopped there's no direction, so every nearby closure counts; the engine errs on the side of warning.
- **Arrival time:** the engine assumes at least 3 m/s, which is cautious for London traffic.
- **Steady screen:** a stronger warning is held for 4 seconds so the screen doesn't flicker.

Run `node tools/test_engine.js` to check the rules against real Lambeth positions.

## The data, and its limits

- **Closure times** come from Lambeth Council's
  [School Streets times and locations page](https://www.lambeth.gov.uk/streets-roads-transport/school-streets/school-streets-times-locations).
  Restrictions apply Monday to Friday in term time, including INSET days.
- **Term dates** use Lambeth's standard
  [2026-27 dates](https://www.lambeth.gov.uk/schools-education/school-term-holiday-dates/school-term-dates-2026-2027).
  Academies and faith schools can differ by a few days.
- **Where each closure is:** the stretch of the named road within 150 m of the point
  nearest the school, using OpenStreetMap. Real closures can be longer or shorter.
  Four are flagged `"placement": "check"` because the school sits well away from the named road.
- **Nothing has been checked on the ground yet.** Every feature has
  `"verified_on_ground": false`. After a drive past, fix the line in
  `data/lambeth/school_streets.geojson` (geojson.io is handy for editing), set it to `true`,
  and run `python3 tools/build_dataset.py`.
- Street map © OpenStreetMap contributors, available under the
  [Open Database License](https://www.openstreetmap.org/copyright).

Road signs always take priority over the app.

## Rebuilding

```
python3 tools/build_dataset.py   # dataset -> docs/data
python3 tools/build_app.py       # app/app.html -> docs/index.html
python3 tools/make_fonts.py      # TTF -> firmware/RoadPuck/fonts.h
python3 tools/puck_preview.py    # docs/puck-screens.png
node tools/test_engine.js        # alert rule checks
```

## Next

- Bus gates and LTN camera filters (Lambeth publishes Digital Traffic Regulation Orders; the
  national D-TRO service is free to register for).
- Bus lanes with their operating hours.
- Parking restrictions: CPZ hours, yellow lines, pay-by-phone bays.
- More boroughs.

Fonts: Anton and Barlow Condensed, SIL Open Font License (see `firmware/RoadPuck/FONT-LICENSE-*.txt`).

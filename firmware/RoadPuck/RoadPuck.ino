/*
  Road Puck - dashboard alert display for London road restrictions
  Board: Waveshare ESP32-S3-Touch-AMOLED-1.75 (466 x 466 round AMOLED, CO5300)

  The phone app does the work (GPS, restriction data, geofences) and sends
  this puck one short line of text over Bluetooth whenever the alert changes.
  The puck only draws it: big, bold, high-contrast.

  Arduino IDE settings (Tools menu):
    Board:            ESP32S3 Dev Module
    USB CDC On Boot:  Enabled
    Flash Size:       16MB (128Mb)
    Partition Scheme: 16M Flash (3MB APP/9.9MB FATFS)
    PSRAM:            OPI PSRAM          <- required, the screen buffer lives here
  Library: "GFX Library for Arduino" (the copy in Waveshare's examples/arduino/libraries works).
  Tested to compile with Arduino-ESP32 core 3.3.10.

  Message format (UTF-8 text, fields split by '|'):
    2|STATE|ROAD|DISTANCE_M|DETAIL|GPS_ACCURACY_M|KIND|WORD|LIMIT_MPH|OVER
    (version 1 messages, without the last three fields, still work)
    WORD:   the big word; empty = chosen from STATE
    LIMIT:  speed limit for the badge at the top; empty = no badge
    OVER:   0 within the limit, 1 over (amber badge), 2 well over (flashing red badge)
    STATE:  X = don't enter (inside/at the closure while closed)
            C = closed ahead          W = closing soon
            L = beside a bus lane you've already been warned about (quiet reminder: smaller word, thin ring)
            O = open to traffic       K = all clear
            R = wrong way down a one-way street (flashing)
            E = no entry: one-way street ahead against you
            P = parked, controlled: WORD is PAY (pay bay: ROAD = app + location code) or PERMIT
            F = parked, zone controls off (free)
            S = safety camera ahead (red when over the limit)
            Y = yellow box junction ahead
            G = no GPS fix
    e.g.    2|C|HACKFORD RD|180|UNTIL 09:15|8|SCHOOL STREET|CLOSED|20|0

  BOOT button: short press = brightness (bright / medium / night)
               hold 2 s    = demo mode on/off (cycles sample screens, no phone needed)
*/

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include "fonts.h"
#include "alert.h"

// ---------- board pins (from Waveshare's pin_config.h) ----------
#define LCD_SDIO0 4
#define LCD_SDIO1 5
#define LCD_SDIO2 6
#define LCD_SDIO3 7
#define LCD_SCLK 38
#define LCD_CS 12
#define LCD_RESET 39
#define LCD_W 466
#define LCD_H 466
#define BOOT_BTN 0

// ---------- Bluetooth IDs (the phone app uses the same ones) ----------
#define PUCK_SERVICE_UUID "7a1e0001-3c4b-4d2a-9f6e-2b8c5d1a0e10"
#define PUCK_ALERT_UUID   "7a1e0002-3c4b-4d2a-9f6e-2b8c5d1a0e10"

// ---------- colours (RGB565) ----------
static inline uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }
const uint16_t C_BLACK = 0x0000;
const uint16_t C_WHITE = 0xFFFF;
const uint16_t C_RED = rgb(0xFF, 0x3B, 0x30);
const uint16_t C_RED_DIM = rgb(0x8A, 0x12, 0x0C);
const uint16_t C_AMBER = rgb(0xFF, 0xB0, 0x20);
const uint16_t C_GREEN = rgb(0x3D, 0xDC, 0x84);
const uint16_t C_GREY = rgb(0x9A, 0xA4, 0xAE);
const uint16_t C_DARK = rgb(0x26, 0x2C, 0x33);

// ---------- display ----------
Arduino_DataBus *bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
Arduino_CO5300 *panel = new Arduino_CO5300(bus, LCD_RESET, 0 /* rotation */, LCD_W, LCD_H, 6, 0, 0, 0);
Arduino_Canvas *gfx = new Arduino_Canvas(LCD_W, LCD_H, panel);
uint16_t *fb = nullptr;

// ---------- alert state ----------

Alert cur;                       // what is on screen
volatile bool pending = false;   // a new message arrived
char inbox[200];                 // raw message from Bluetooth
portMUX_TYPE inboxLock = portMUX_INITIALIZER_UNLOCKED;
volatile bool linked = false;
uint32_t lastMsgMs = 0;
char puckName[20];

enum Screen { SCR_NONE, SCR_CONNECT, SCR_WAITING, SCR_ALERT };
Screen screen = SCR_NONE;
bool pulseOn = true;
uint32_t pulseMs = 0;

const uint8_t BRIGHT[] = {255, 150, 60};
uint8_t brightIdx = 0;
bool demo = false;
uint32_t demoMs = 0;
int demoStep = 0;

// ================= text drawing (anti-aliased 4-bit glyphs) =================
static inline uint16_t blend(uint16_t bg, uint16_t fg, uint8_t a) {
  if (a == 0) return bg;
  if (a >= 15) return fg;
  uint8_t ia = 15 - a;
  uint16_t r = (((fg >> 11) & 31) * a + ((bg >> 11) & 31) * ia) / 15;
  uint16_t g = (((fg >> 5) & 63) * a + ((bg >> 5) & 63) * ia) / 15;
  uint16_t b = ((fg & 31) * a + (bg & 31) * ia) / 15;
  return (r << 11) | (g << 5) | b;
}

static inline char up(char c) { return (c >= 'a' && c <= 'z') ? c - 32 : c; }

int textWidth(const PuckFont &f, const char *s) {
  int w = 0;
  for (; *s; s++) {
    char c = up(*s);
    if (c < f.first || c > f.last) c = ' ';
    w += f.glyphs[c - f.first].adv;
  }
  return w;
}

void drawText(const PuckFont &f, const char *s, int x, int baseline, uint16_t color) {
  for (; *s; s++) {
    char c = up(*s);
    if (c < f.first || c > f.last) c = ' ';
    const PuckGlyph &g = f.glyphs[c - f.first];
    const uint8_t *bits = f.bits + g.offset;
    int gx = x + g.xo, gy = baseline + g.yo;
    for (int j = 0; j < g.h; j++) {
      int yy = gy + j;
      if (yy < 0 || yy >= LCD_H) continue;
      uint16_t *row = fb + yy * LCD_W;
      for (int i = 0; i < g.w; i++) {
        int xx = gx + i;
        if (xx < 0 || xx >= LCD_W) continue;
        int p = j * g.w + i;
        uint8_t a = (p & 1) ? (bits[p >> 1] & 0x0F) : (bits[p >> 1] >> 4);
        if (a) row[xx] = blend(row[xx], color, a);
      }
    }
    x += g.adv;
  }
}

// usable width of the round screen for a line whose glyphs span [top, bottom]
int chordWidth(int top, int bottom, int margin) {
  const float r = LCD_W / 2.0f;
  float dy = max(fabsf(top - r), fabsf(bottom - r));
  if (dy >= r) return 0;
  return (int)(2.0f * sqrtf(r * r - dy * dy)) - 2 * margin;
}

// draw centred, picking the first font that fits; returns the font used
const PuckFont *drawFit(const char *s, int baseline, uint16_t color, const PuckFont *a, const PuckFont *b = nullptr, const PuckFont *c = nullptr) {
  const PuckFont *opts[3] = {a, b, c};
  const PuckFont *use = a;
  for (int i = 0; i < 3 && opts[i]; i++) {
    use = opts[i];
    int avail = chordWidth(baseline - use->capH, baseline, 22);
    if (textWidth(*use, s) <= avail) break;
  }
  drawText(*use, s, (LCD_W - textWidth(*use, s)) / 2, baseline, color);
  return use;
}

void ring(uint16_t color, int thick) {
  gfx->fillCircle(LCD_W / 2, LCD_H / 2, LCD_W / 2, color);
  gfx->fillCircle(LCD_W / 2, LCD_H / 2, LCD_W / 2 - thick, C_BLACK);
}

void formatDist(int m, char *out, size_t n) {
  if (m < 0) { out[0] = 0; return; }
  if (m < 1000) snprintf(out, n, "%d M", m < 10 ? 10 : (m + 5) / 10 * 10);
  else snprintf(out, n, "%d.%d KM", m / 1000, (m % 1000) / 100);
}

// ================= screens =================
void drawConnect() {
  gfx->fillScreen(C_BLACK);
  ring(C_DARK, 8);
  drawFit("ROAD PUCK", 100, C_GREY, &F_SMALL);
  drawFit("CONNECT", 228, C_WHITE, &F_STATUS, &F_BIG);
  drawFit("OPEN THE PHONE APP", 292, C_WHITE, &F_ROAD, &F_ROAD_S);
  drawFit("TAP CONNECT PUCK", 350, C_AMBER, &F_ROAD_S, &F_SMALL);
  drawFit(puckName, 410, C_GREY, &F_TINY);
  gfx->flush();
}

void drawWaiting() {
  gfx->fillScreen(C_BLACK);
  ring(C_AMBER, 6);
  drawFit("ROAD PUCK", 100, C_GREY, &F_SMALL);
  drawFit("WAITING", 228, C_AMBER, &F_STATUS, &F_BIG);
  drawFit("NO UPDATE FROM PHONE", 292, C_WHITE, &F_ROAD, &F_ROAD_S);
  drawFit("KEEP THE APP OPEN", 350, C_GREY, &F_SMALL);
  gfx->flush();
}

// UK-style speed limit roundel at the top of the screen
void drawBadge(int limit, int over) {
  const int cx = LCD_W / 2, cy = 58, r = 38;
  char num[8];
  snprintf(num, sizeof num, "%d", limit);
  uint16_t numCol = C_BLACK;
  if (over >= 2) {
    gfx->fillCircle(cx, cy, r, pulseOn ? C_RED : C_RED_DIM);
    numCol = C_WHITE;
  } else if (over == 1) {
    gfx->fillCircle(cx, cy, r, C_AMBER);
  } else {
    gfx->fillCircle(cx, cy, r, C_RED);
    gfx->fillCircle(cx, cy, r - 8, C_WHITE);
  }
  int base = cy + F_ROAD.capH / 2;
  drawText(F_ROAD, num, cx - textWidth(F_ROAD, num) / 2, base, numCol);
}

void drawAlert() {
  const Alert &a = cur;
  char dist[16];
  formatDist(a.dist, dist, sizeof dist);
  char gps[20] = "";
  if (a.acc >= 0) snprintf(gps, sizeof gps, "GPS %d M", a.acc);

  if (a.st == 'X' || a.st == 'R') {  // DON'T ENTER / WRONG WAY: whole screen red, flashing
    uint16_t bg = pulseOn ? C_RED : C_RED_DIM;
    gfx->fillScreen(C_BLACK);
    gfx->fillCircle(LCD_W / 2, LCD_H / 2, LCD_W / 2, bg);
    drawFit(a.kind[0] ? a.kind : "RESTRICTED", 90, C_WHITE, &F_SMALL);
    drawFit(a.st == 'R' ? "WRONG" : "DON'T", 206, C_WHITE, &F_STATUS);
    drawFit(a.st == 'R' ? "WAY" : "ENTER", 322, C_WHITE, &F_STATUS);
    drawFit(a.road, 378, C_WHITE, &F_ROAD, &F_ROAD_S, &F_SMALL);
    drawFit(a.detail, 420, C_WHITE, &F_SMALL, &F_TINY);
    gfx->flush();
    return;
  }

  uint16_t col;
  const char *word;
  switch (a.st) {
    case 'C': col = C_RED; word = "CLOSED"; break;
    case 'L': col = C_RED; word = "CLOSED"; break;
    case 'E': col = C_RED; word = "NO ENTRY"; break;
    case 'W': col = C_AMBER; word = "CLOSING"; break;
    case 'S': col = a.over ? C_RED : C_AMBER; word = "CAMERA"; break;
    case 'Y': col = C_AMBER; word = "KEEP CLEAR"; break;
    case 'P': col = C_AMBER; word = "PERMIT"; break;
    case 'O': col = C_GREEN; word = "OPEN"; break;
    case 'F': col = C_GREEN; word = "FREE"; break;
    case 'G': col = C_AMBER; word = "NO GPS"; break;
    default:  col = C_GREEN; word = "CLEAR"; break;
  }
  if (a.word[0]) word = a.word;
  gfx->fillScreen(C_BLACK);
  bool strong = a.st == 'C' || a.st == 'E' || (a.st == 'S' && a.over);
  ring(col, strong ? 14 : 8);
  if (a.limit > 0) drawBadge(a.limit, a.over);
  else if (gps[0]) drawFit(gps, 60, C_GREY, &F_TINY);
  drawFit(a.kind[0] ? a.kind : "ROAD PUCK", 122, col, &F_SMALL, &F_TINY);
  if (a.st == 'L') drawFit(word, 238, col, &F_BIG);   // quiet reminder: smaller word
  else drawFit(word, 238, col, &F_STATUS, &F_BIG);
  drawFit(a.road, 292, C_WHITE, &F_ROAD, &F_ROAD_S, &F_SMALL);
  if (dist[0]) {
    drawFit(dist, 378, C_WHITE, &F_BIG);
    drawFit(a.detail, 424, strong ? C_WHITE : C_GREY, &F_SMALL, &F_TINY);
  } else {
    drawFit(a.detail, 350, (strong || a.st == 'P' || a.st == 'F') ? C_WHITE : C_GREY, &F_ROAD_S, &F_SMALL, &F_TINY);
  }
  gfx->flush();
}

// ================= messages =================
bool parseMessage(const char *msg, Alert &out) {
  char buf[200];
  strncpy(buf, msg, sizeof buf - 1);
  buf[sizeof buf - 1] = 0;
  char *fields[10] = {0};
  int n = 0;
  char *p = buf;
  fields[n++] = p;
  while (*p && n < 10) {
    if (*p == '|') { *p = 0; fields[n++] = p + 1; }
    p++;
  }
  if (n < 2 || (strcmp(fields[0], "1") != 0 && strcmp(fields[0], "2") != 0)) return false;
  Alert a;
  a.st = fields[1][0];
  if (n > 2) strncpy(a.road, fields[2], sizeof a.road - 1);
  a.dist = (n > 3 && fields[3][0]) ? atoi(fields[3]) : -1;
  if (n > 4) strncpy(a.detail, fields[4], sizeof a.detail - 1);
  a.acc = (n > 5 && fields[5][0]) ? atoi(fields[5]) : -1;
  if (n > 6) strncpy(a.kind, fields[6], sizeof a.kind - 1);
  if (n > 7) strncpy(a.word, fields[7], sizeof a.word - 1);
  a.limit = (n > 8 && fields[8][0]) ? atoi(fields[8]) : -1;
  a.over = (n > 9 && fields[9][0]) ? atoi(fields[9]) : 0;
  out = a;
  return true;
}

bool sameAlert(const Alert &a, const Alert &b) {
  return a.st == b.st && a.dist == b.dist && a.acc == b.acc && !strcmp(a.road, b.road) &&
         !strcmp(a.detail, b.detail) && !strcmp(a.kind, b.kind) && !strcmp(a.word, b.word) &&
         a.limit == b.limit && a.over == b.over;
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override { linked = true; lastMsgMs = millis(); }
  void onDisconnect(BLEServer *s) override {
    linked = false;
    BLEDevice::startAdvertising();
  }
};

class AlertCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *c) override {
    String v = String(c->getValue().c_str());
    portENTER_CRITICAL(&inboxLock);
    strncpy(inbox, v.c_str(), sizeof inbox - 1);
    inbox[sizeof inbox - 1] = 0;
    pending = true;
    portEXIT_CRITICAL(&inboxLock);
  }
};

void startBluetooth() {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(puckName, sizeof puckName, "RoadPuck-%02X%02X", (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  BLEDevice::init(puckName);
  BLEDevice::setMTU(247);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *svc = server->createService(PUCK_SERVICE_UUID);
  BLECharacteristic *ch = svc->createCharacteristic(
      PUCK_ALERT_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  ch->setCallbacks(new AlertCallbacks());
  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->setScanResponse(true);  // the phone finds the puck by name
  BLEDevice::startAdvertising();
  Serial.printf("Bluetooth ready as %s\n", puckName);
}

// ================= demo mode (no phone needed) =================
const char *DEMO[] = {
    "2|K|NO CLOSURES AHEAD||NEAREST 1.2 KM|6|ROAD PUCK|CLEAR|20|0",
    "2|W|STUDLEY RD|420|CLOSES IN 6 MIN|7|SCHOOL STREET|CLOSING|20|0",
    "2|C|HACKFORD RD|180|UNTIL 09:15|8|SCHOOL STREET|CLOSED|20|0",
    "2|X|HACKFORD RD|30|CLOSED UNTIL 09:15|8|SCHOOL STREET|DON'T ENTER||0",
    "2|S|30 MPH LIMIT|180|CHECK YOUR SPEED|5|SPEED CAMERA|CAMERA|30|0",
    "2|S|30 MPH LIMIT|120|SLOW DOWN|5|SPEED CAMERA|CAMERA|30|2",
    "2|Y|BRIXTON RD|40|EXIT MUST BE CLEAR|5|YELLOW BOX JUNCTION|KEEP CLEAR|30|0",
    "2|E|SOUTH LAMBETH PL|30|CHECK THE SIGNS|5|BUS GATE|NO ENTRY|20|0",
    "2|C|CAMBERWELL NEW RD||KEEP OUT - 24 HOURS|7|BUS LANE|CLOSED|30|1",
    "2|E|HEPWORTH RD|25|ONE WAY AGAINST YOU|6|ONE WAY STREET|NO ENTRY|20|0",
    "2|R|HEPWORTH RD|0|TURN AROUND SAFELY|6|ONE WAY STREET|WRONG WAY||0",
    "2|P|PAYBYPHONE 83349||MAX 4 H - TIL 18:30|5|PARKING|PAY||0",
    "2|L|BRIXTON RD||KEEP OUT - 24 HOURS|6|BUS LANE|CLOSED|30|0",
    "2|P|RINGGO 11737||MAX 4 H - TIL 18:30|8|PARKING|PAY||0",
    "2|P|RINGGO 40000||CHECK THE SIGNS|8|CAR PARK|CHECK||0",
    "2|P|ZONE S STOCKWELL||PERMIT TIL 17:30|5|PARKING|PERMIT||0",
    "2|F|ZONE S STOCKWELL||UNTIL TUE 08:30|5|PARKING|FREE||0",
    "2|G|||WAITING FOR SIGNAL|60|ROAD PUCK|NO GPS||0",
};
const int DEMO_N = sizeof(DEMO) / sizeof(DEMO[0]);

// ================= setup / loop =================
void setup() {
  Serial.begin(115200);
  pinMode(BOOT_BTN, INPUT_PULLUP);
  if (!gfx->begin()) {
    Serial.println("Display start failed. Check Tools > PSRAM is set to OPI PSRAM.");
  }
  fb = gfx->getFramebuffer();
  panel->setBrightness(BRIGHT[brightIdx]);
  if (!fb) {
    Serial.println("No screen buffer: enable OPI PSRAM in the Tools menu.");
    while (true) delay(1000);
  }
  startBluetooth();
  drawConnect();
  screen = SCR_CONNECT;
}

void handleButton() {
  static bool was = false;
  static uint32_t downMs = 0;
  static bool longDone = false;
  bool down = digitalRead(BOOT_BTN) == LOW;
  if (down && !was) { downMs = millis(); longDone = false; }
  if (down && !longDone && millis() - downMs > 2000) {
    longDone = true;
    demo = !demo;
    demoStep = 0;
    demoMs = 0;
    if (!demo) screen = SCR_NONE;  // force a redraw of the real state
  }
  if (!down && was && !longDone && millis() - downMs > 30) {
    brightIdx = (brightIdx + 1) % sizeof(BRIGHT);
    panel->setBrightness(BRIGHT[brightIdx]);
  }
  was = down;
}

void loop() {
  handleButton();
  uint32_t now = millis();

  if (demo) {
    if (demoMs == 0 || now - demoMs > 3500) {
      demoMs = now;
      parseMessage(DEMO[demoStep], cur);
      demoStep = (demoStep + 1) % DEMO_N;
      screen = SCR_ALERT;
      drawAlert();
    }
  } else {
    if (pending) {
      char msg[200];
      portENTER_CRITICAL(&inboxLock);
      strncpy(msg, inbox, sizeof msg);
      pending = false;
      portEXIT_CRITICAL(&inboxLock);
      Alert a;
      if (parseMessage(msg, a)) {
        lastMsgMs = now;
        if (screen != SCR_ALERT || !sameAlert(a, cur)) {
          cur = a;
          screen = SCR_ALERT;
          drawAlert();
        }
      }
    }
    if (!linked && screen != SCR_CONNECT) {
      screen = SCR_CONNECT;
      drawConnect();
    } else if (linked && now - lastMsgMs > 10000 && screen != SCR_WAITING) {
      screen = SCR_WAITING;
      drawWaiting();
    }
  }

  // flash the DON'T ENTER screen
  if (screen == SCR_ALERT && (cur.st == 'X' || cur.st == 'R' || cur.over >= 2) && now - pulseMs > 450) {
    pulseMs = now;
    pulseOn = !pulseOn;
    drawAlert();
  }
  delay(10);
}

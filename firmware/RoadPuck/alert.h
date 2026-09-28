// One alert as sent by the phone app.
// Kept in its own header so Arduino IDE sees it before the function
// declarations it adds automatically to the top of RoadPuck.ino.
#pragma once

struct Alert {
  char st = 0;          // X C W O K R E P F G (see RoadPuck.ino)
  char road[48] = "";
  int dist = -1;        // metres, -1 = none
  char detail[48] = "";
  int acc = -1;         // GPS accuracy in metres, -1 = unknown
  char kind[32] = "";   // SCHOOL STREET, BUS LANE, ONE WAY STREET, PARKING, SPEED CAMERA, ...
  char word[24] = "";   // the big word (v2 messages); empty = pick from st
  int limit = -1;       // speed limit in mph for the badge, -1 = none
  int over = 0;         // 0 within the limit, 1 over, 2 well over
};

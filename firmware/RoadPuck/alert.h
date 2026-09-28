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
  char kind[32] = "";   // SCHOOL STREET, BUS LANE, ONE WAY STREET, PARKING
};

/*
  Street map for the app (data/lambeth/basemap.json).
  Run at https://overpass-turbo.eu or POST to https://overpass-api.de/api/interpreter.
  The busy public server often times out on the full area, so the app's copy was
  fetched in six tiles (lat 51.404-51.501, lon -0.158 to -0.072) and merged.
  Each way was then simplified (2.5 m tolerance) and stored as metres from
  lon -0.115, lat 51.455, delta-encoded:  [class, nameIndex, oneway, dx, dy, dx, dy, ...]
  Classes: 0 motorway/trunk, 1 primary, 2 secondary, 3 tertiary, 4 minor, 5 pedestrian/living street.
  Data (c) OpenStreetMap contributors, ODbL.
*/
[out:json][timeout:120];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|unclassified|residential|living_street|pedestrian)$"](51.404,-0.158,51.501,-0.072);
out tags geom;
rel["boundary"="administrative"]["name"="London Borough of Lambeth"];
out geom;

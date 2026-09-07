const EARTH_RADIUS_M = 6371000;

function toRad(d) {
  return (d * Math.PI) / 180;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function point(lng, lat) {
  return { type: 'Point', coordinates: [Number(lng), Number(lat)] };
}

function coordsOf(geo) {
  if (!geo || !geo.coordinates) return null;
  return { lng: geo.coordinates[0], lat: geo.coordinates[1] };
}

module.exports = { haversineMeters, point, coordsOf };

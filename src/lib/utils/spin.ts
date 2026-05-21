import type { Map as MaplibreMap } from "maplibre-gl";

const SPIN_SPEED = 6;

export function createSpin(getMap: () => MaplibreMap | undefined) {
  let spinning = false;
  let animFrame: number | undefined;
  let lastTime: number | undefined;

  function spinStep(timestamp: number) {
    const map = getMap();
    if (!spinning || !map) return;
    if (lastTime !== undefined) {
      const delta = (timestamp - lastTime) / 1000;
      const center = map.getCenter();
      center.lng -= SPIN_SPEED * delta;
      map.setCenter(center);
    }
    lastTime = timestamp;
    animFrame = requestAnimationFrame(spinStep);
  }

  function start() {
    spinning = true;
    lastTime = undefined;
    animFrame = requestAnimationFrame(spinStep);
  }

  function stop() {
    if (!spinning) return;
    spinning = false;
    if (animFrame !== undefined) cancelAnimationFrame(animFrame);
  }

  return { start, stop };
}

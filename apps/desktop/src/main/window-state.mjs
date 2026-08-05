export const DEFAULT_WINDOW_BOUNDS = Object.freeze({ width: 1360, height: 860 })

function finiteBounds(value) {
  return value && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

function centeredBounds(area, preferred = DEFAULT_WINDOW_BOUNDS) {
  const width = Math.min(area.width, Math.max(760, preferred.width))
  const height = Math.min(area.height, Math.max(560, preferred.height))
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

export function restoreWindowState(saved, displays, primaryDisplay) {
  const primary = primaryDisplay?.workArea ?? { x: 0, y: 0, width: 1440, height: 900 }
  if (!finiteBounds(saved?.bounds)) return { bounds: centeredBounds(primary), maximized: false }

  const bounds = {
    x: saved.bounds.x,
    y: saved.bounds.y,
    width: Math.max(760, saved.bounds.width),
    height: Math.max(560, saved.bounds.height),
  }
  const match = (displays ?? [])
    .map((display) => ({ display, area: intersectionArea(bounds, display.workArea) }))
    .sort((a, b) => b.area - a.area)[0]
  if (!match || match.area < 80 * 80) {
    return { bounds: centeredBounds(primary, bounds), maximized: saved.maximized === true }
  }

  const area = match.display.workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    bounds: {
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
      width,
      height,
    },
    maximized: saved.maximized === true,
  }
}

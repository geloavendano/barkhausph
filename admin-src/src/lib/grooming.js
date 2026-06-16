export const GROOM_DURATIONS = { bath_dry: 60, basic: 60, premium: 120, ala_carte: 60 }
export const GROOM_DURATION_ADDONS = new Set(['demat', 'deshed'])

export function hasDurationAddon(addons) {
  if (!addons) return false
  if (Array.isArray(addons)) {
    return addons.some(a => GROOM_DURATION_ADDONS.has(a?.addon_key ?? a?.addon_name))
  }
  return Object.keys(addons).some(k => GROOM_DURATION_ADDONS.has(k))
}

export function groomDurationMins(serviceKey = 'basic', addons = null) {
  const base = GROOM_DURATIONS[serviceKey] ?? 60
  return base + (hasDurationAddon(addons) ? 30 : 0)
}

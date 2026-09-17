// How this copy of the app was installed, as electron-builder recorded it.
//
// A Linux package build (deb, rpm) writes `resources/package-type` holding the
// target name; DMG, zip, and development builds have no such file. The updater
// reads it to leave a package-managed install to its package manager, and the
// install metric reads it to count a .deb under its own row.
import fs from 'node:fs'
import path from 'node:path'

const PACKAGE_TYPE = /^[a-z][a-z0-9-]{0,15}$/

/** 'deb', 'rpm', … or null when the file is absent, unreadable, or not a plain name. */
export function readPackageType(resourcesPath) {
  if (!resourcesPath) return null
  try {
    const value = fs.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim()
    return PACKAGE_TYPE.test(value) ? value : null
  } catch {
    return null
  }
}

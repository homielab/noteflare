// The single source of truth is the "version" field in package.json; scripts/release.mjs bumps it.
import { version } from '../package.json'

export const APP_VERSION: string = version

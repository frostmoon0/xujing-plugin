import { isTaichuEnabled } from './taichu_equipment.js'
import { readTaichuStore } from './taichu_store.js'
import { findPlayerTaichuRun } from './taichu_dungeon.js'

export function playerInTaichu (gid, uid) {
  if (!isTaichuEnabled()) return false
  return !!findPlayerTaichuRun(readTaichuStore(gid), String(uid))
}

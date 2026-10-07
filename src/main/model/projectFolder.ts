// Where "New project folder…" puts a project: ~/Spettro Projects/<name>.
//
// The name is the user's words ("Bakery website"), so it is made safe for
// every file system Spettro runs on rather than refused: path separators and
// the characters Windows reserves become dashes, leading dots go (a hidden
// folder would vanish from the user's own file browser), and a name already
// taken gets " 2", " 3", … — never a second project inside the first.

import { existsSync } from 'fs'
import { join } from 'path'

/** The folder name for a project called `name`, or '' when nothing usable
 *  is left of it. */
export function projectFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+/, '')
    .replace(/[.\s-]+$/, '')
    .slice(0, 80)
}

/** A path under `root` for a new project called `name` that nothing exists
 *  at yet. Throws, in words, when the name has nothing usable in it. */
export function newProjectPath(root: string, name: string, exists: (p: string) => boolean = existsSync): string {
  const folder = projectFolderName(name)
  if (folder === '') throw new Error('Give the project a name.')
  let path = join(root, folder)
  for (let n = 2; exists(path); n++) path = join(root, `${folder} ${n}`)
  return path
}

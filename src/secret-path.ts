import { realpath } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import { defaultSecretsDirectory } from "./keychain"

export const isInside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Refuse BuddyTG's own secret store, whatever the model asks for. */
export const assertNotSecret = async (path: string) => {
  const real = await realpath(path)
  const defaultSecrets = defaultSecretsDirectory()
  const secrets = await realpath(defaultSecrets).catch(() => defaultSecrets)
  if (isInside(secrets, real)) throw new Error("path is inside the BuddyTG secret store.")
  return real
}

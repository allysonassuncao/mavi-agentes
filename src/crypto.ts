import { createHash, randomBytes } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Token aleatório seguro para URL. */
export const newToken = (prefix = "") => prefix + randomBytes(24).toString("base64url");

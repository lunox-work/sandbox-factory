import { memberships, organizations } from "../db/index.js";

export function tables() {
  return [memberships, organizations];
}

import { rankAtLeast } from "sandbox-factory";
export { rankAtLeast } from "sandbox-factory";

export function isAtLeastAdmin(role: string): boolean {
  return rankAtLeast(role, "admin");
}

import type { User } from "../src/model.js";

export function label(user: User): string {
  return user.name;
}

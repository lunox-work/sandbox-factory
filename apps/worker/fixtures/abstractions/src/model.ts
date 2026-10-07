import type { Clock } from "time-lib";
import { readFileSync } from "node:fs";

export interface User {
  id: number;
  name: string;
  joined: Clock;
}

export type Id = User["id"];

export enum Role {
  Owner = "owner",
  Member = "member",
}

export const LIMIT = 5;

export function greet(user: User): string {
  return `hi ${user.name}`;
}

export const shout = (user: User): string => greet(user).toUpperCase();

export class Repo {
  find(id: Id): User | undefined {
    return id === LIMIT ? undefined : undefined;
  }
}

export namespace Shapes {
  export const square = 4;
}

export function load(path: string): string {
  return readFileSync(path, "utf8");
}

const answer = { value: 42 };
export default answer;

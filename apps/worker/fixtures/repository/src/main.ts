import { helper } from "./util.js";
import { value } from "./folder";
import { helper as alias } from "@/util";
import "missing-package";
export function main() {
  return helper() + alias() + value;
}
export async function dynamic(name: string) {
  return import(name);
}

import { missing } from "./missing.js";
import { unpinned } from "unpinned-package";

export const dyn = (name: string) => import(name);
export const value = missing;
export const other = unpinned;

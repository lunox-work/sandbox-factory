import type { Post } from "@prisma/client";
import { prisma } from "../db/prisma.js";

export async function recent(): Promise<Post[]> {
  const users = await prisma.user.findMany();
  return users.length > 0 ? prisma.post.findMany() : [];
}

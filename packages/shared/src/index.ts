/**
 * The wire contract: what an API response looks like on both sides of the
 * network. The API parses with these schemas on the way out, the client parses
 * with them on the way in, so a shape change breaks the build rather than
 * producing a runtime surprise in one consumer.
 *
 * Runtime dependency on zod only — no HTTP, no database, no DOM, so the
 * extension and the browser can both bundle it.
 */

import { TITLE_MAX_LENGTH, TODO_FILTERS } from "sandbox-factory";
import { z } from "zod";

/**
 * Derived from the core constants rather than restated, so a cap changed in
 * core takes effect here too — which is the point of keeping both in one repo.
 */
export const titleSchema = z
  .string()
  .trim()
  .min(1, "A todo needs a title.")
  .max(
    TITLE_MAX_LENGTH,
    `Titles are capped at ${TITLE_MAX_LENGTH} characters.`,
  );

export const todoFilterSchema = z.enum(TODO_FILTERS);

export const todoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  done: z.boolean(),
  createdAt: z.iso.datetime(),
});

export const todoListSchema = z.object({
  todos: z.array(todoSchema),
});

/** Body for `POST /api/v1/todos`. */
export const createTodoSchema = z.object({
  title: titleSchema,
});

/**
 * Body for `PATCH /api/v1/todos/:id`.
 *
 * Both fields are optional so one endpoint serves renaming and checking off,
 * but an empty body is a mistake rather than a no-op — it almost always means
 * the caller sent the wrong shape.
 */
export const updateTodoSchema = z
  .object({
    title: titleSchema.optional(),
    done: z.boolean().optional(),
  })
  .refine((body) => body.title !== undefined || body.done !== undefined, {
    message: "Provide a title, a done flag, or both.",
  });

export const errorSchema = z.object({
  error: z.string(),
});

export type TodoDto = z.infer<typeof todoSchema>;
export type TodoListDto = z.infer<typeof todoListSchema>;
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
export type UpdateTodoInput = z.infer<typeof updateTodoSchema>;
export type ErrorDto = z.infer<typeof errorSchema>;
